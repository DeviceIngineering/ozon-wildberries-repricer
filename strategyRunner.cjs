/**
 * Прогон ценовых стратегий (РФ4). См. docs/STRATEGIES.md.
 *
 * Работает ОТДЕЛЬНО от ref_price-репрайсера: товары со стратегией (strategy_type != ref_price,
 * in_experiment=1) ведёт этот раннер, обычные — repricer.cjs (который их пропускает).
 *
 * Цикл по товару: econ → окно продаж (чистые дни) → strategyEngine.decide → персист состояния →
 * gate (auto_apply=0 → только лог-предложение; =1 → применяем цену) → floor-гард.
 * Kill-switch: глобальный (app_settings) + на магазин (stores.strategy_kill_switch).
 */
const db = require('./db.cjs');
const Sentry = require('./sentry.server.cjs');
const { decide } = require('./lib/strategyEngine.cjs');
const { capStep } = require('./lib/priceStep.cjs');
const { computeWbFloor, computeBoxLogistics, computeWbPricePair } = require('./lib/wbPricing.cjs');

async function buildWbEcon(store, storeId) {
    const wb = require('./wbFetcher.cjs');
    let commissionMap = new Map(), box = { base: 0, liter: 0 };
    try { commissionMap = await wb.fetchCommissions(store.wb_api_key, storeId); } catch (e) { console.warn('[Strategy] WB commissions:', e.message); }
    try { box = await wb.fetchBoxTariffs(store.wb_api_key, storeId); } catch (e) { console.warn('[Strategy] WB box:', e.message); }
    return { commissionMap, box };
}

async function runStore(storeId) {
    if (db.isGlobalKillSwitch()) return { skipped: 'global kill-switch' };
    const store = await db.getStoreById(storeId);
    if (!store) return { skipped: 'no store' };
    if (store.strategy_kill_switch) return { skipped: 'store kill-switch' };

    const products = db.getExperimentalProducts(storeId);
    if (products.length === 0) return { count: 0, applied: 0 };

    const taxRate = parseFloat(store.tax_rate || 0);
    const margin = parseFloat(store.min_margin_percent || 0);
    let wbEcon = null;
    if (store.platform === 'wildberries') wbEcon = await buildWbEcon(store, storeId);

    const updates = []; // WB: {nmID, price, discount}
    const results = [];

    for (const p of products) {
        // 1. Юнит-экономика и floor
        let econ = null;
        let floor = p.floor_min_price != null ? parseFloat(p.floor_min_price) : null;
        if (store.platform === 'wildberries' && p.cost_price > 0) {
            const comm = wbEcon.commissionMap.get(p.wb_subject_id);
            const commPct = comm && comm.fbo > 0 ? comm.fbo : 30;
            const logistics = computeBoxLogistics(p.wb_volume_liters, wbEcon.box);
            econ = { cost: parseFloat(p.cost_price), commissionPct: commPct, acquiringPct: 1.5, taxPct: taxRate, logistics };
            if (floor == null) {
                floor = computeWbFloor({ costPrice: econ.cost, commissionPercent: commPct, logisticsAmount: logistics, returnLogisticsAmount: logistics * 0.3, taxRate, marginPercent: margin });
            }
        }
        if (!econ || floor == null) { results.push({ offer: p.offer_id, action: 'skip_no_econ' }); continue; }

        const lowerMin = p.strategy_price_min != null ? parseFloat(p.strategy_price_min) : floor;
        const ceiling = p.strategy_price_max != null ? parseFloat(p.strategy_price_max)
            : (p.ref_price > 0 ? parseFloat(p.ref_price) * 1.5 : floor * 2);
        const win = parseInt(p.strategy_window_days) || 14;

        // 2. Окно продаж (только чистые дни)
        const obs = db.getSalesWindow(storeId, p.offer_id, win);

        // 3. Состояние эксперимента
        const exp = db.getExperiment(storeId, p.offer_id);
        let lastState = {};
        try { lastState = exp && exp.last_decision_json ? JSON.parse(exp.last_decision_json) : {}; } catch { }
        const curPrice = exp && exp.current_price != null ? exp.current_price
            : (p.cur_price ? parseFloat(p.cur_price) : (p.ref_price ? parseFloat(p.ref_price) : floor));
        const state = {
            current_price: curPrice,
            step_percent: (exp && exp.step_percent) || 8,
            direction: (exp && exp.direction) || -1,
            best_price: exp && exp.best_price,
            best_metric: exp && exp.best_metric,
            bad_steps: (exp && exp.bad_steps) || 0,
            phase: lastState.phase, scan: lastState.scan, scan_grid: lastState.scan_grid, scan_idx: lastState.scan_idx,
        };
        const opts = {
            strategy: p.strategy_type, floor: lowerMin, ceiling,
            targetMargin: p.strategy_target_margin != null ? parseFloat(p.strategy_target_margin) : undefined,
            liquidationMaxLossPct: p.liquidation_max_loss_pct != null ? parseFloat(p.liquidation_max_loss_pct) : undefined,
            nMin: 12, tMax: win, minDays: 3,
        };

        const d = decide(state, obs, econ, opts);

        // Пределы шага цены за прогон — в lib/priceStep.cjs (тот же модуль, что и
        // в репрайсере). Целевую цену движка достигаем ступенчато; current_price
        // продвигается только по фактически выставленной цене — см. ниже.
        let appliedPrice = d.nextPrice;
        let capped = false;
        if (appliedPrice != null && state.current_price > 0) {
            const step = capStep({
                current: state.current_price, target: appliedPrice, store, floor: econ.floor,
            });
            appliedPrice = step.applied;
            capped = step.capped;
        }

        const autoApply = (exp && exp.auto_apply) ? 1 : 0;
        const priceChanging = d.nextPrice != null && !['hold', 'no_room'].includes(d.action) && Math.abs(d.nextPrice - state.current_price) >= 1;
        const willApply = autoApply && priceChanging;

        // Состояние эксперимента ПРОДВИГАЕМ (current_price/scan/ladder) ТОЛЬКО после успешной
        // отправки цены — иначе движок «думает», что цена сдвинулась, хотя нет (рассинхрон).
        // В dry-run/hold/при ошибке отправки строка эксперимента остаётся на ФАКТИЧЕСКОЙ цене.
        const advancedState = {
            strategy_type: p.strategy_type, status: 'active', analysis_window_days: win,
            current_price: appliedPrice,
            step_percent: d.stepPercent != null ? d.stepPercent : state.step_percent,
            direction: d.direction != null ? d.direction : state.direction,
            best_price: d.bestPrice != null ? d.bestPrice : state.best_price,
            best_metric: d.bestMetric != null ? d.bestMetric : state.best_metric,
            bad_steps: d.badSteps != null ? d.badSteps : state.bad_steps,
            auto_apply: autoApply,
            last_decision_json: JSON.stringify({ phase: d.phase, scan: d.scan, scan_grid: d.scan_grid, scan_idx: d.scan_idx, action: d.action, reason: d.reason }),
        };

        // Гарантируем существование строки эксперимента БЕЗ продвижения состояния (для UI/auto-флага).
        const expId = db.upsertExperiment(storeId, p.offer_id, {
            strategy_type: p.strategy_type, status: 'active', analysis_window_days: win, auto_apply: autoApply,
            current_price: exp && exp.current_price != null ? exp.current_price : state.current_price,
            step_percent: (exp && exp.step_percent) || state.step_percent,
            direction: (exp && exp.direction != null) ? exp.direction : state.direction,
            best_price: exp ? exp.best_price : null,
            best_metric: exp ? exp.best_metric : null,
            bad_steps: (exp && exp.bad_steps) || 0,
            last_decision_json: (exp && exp.last_decision_json) ? exp.last_decision_json : JSON.stringify({}),
        });

        db.logStrategy(storeId, {
            experiment_id: expId, offer_id: p.offer_id, strategy_type: p.strategy_type,
            action: willApply ? (capped ? d.action + '_capped' : d.action) : (priceChanging ? d.action + '_proposed' : d.action),
            old_price: state.current_price, new_price: willApply ? appliedPrice : d.nextPrice,
            metric_name: p.strategy_type, metric_value: d.metric != null ? d.metric : null,
            reason: capped ? `${d.reason} | карантин-кап до ${appliedPrice} (цель ${d.nextPrice})` : d.reason,
            applied: willApply,
        });

        if (willApply && store.platform === 'wildberries') {
            const disc = p.wb_discount != null ? p.wb_discount : 0;
            const pair = computeWbPricePair(appliedPrice, disc);
            updates.push({ nmID: p.ozon_id, price: pair.price, discount: pair.discount, _offerId: p.offer_id, _advanced: advancedState });
        }
        results.push({ offer: p.offer_id, action: d.action, next: d.nextPrice, appliedPrice: willApply ? appliedPrice : null, applied: willApply });
    }

    // 6. Применение WB-цен (батч). Состояние применённых продвигаем ТОЛЬКО после успешной отправки.
    let applied = 0;
    if (updates.length > 0 && store.platform === 'wildberries') {
        try {
            const res = await require('./wbFetcher.cjs').updateProductPrices(store.wb_api_key, updates, storeId, 'strategy');
            if (res && res.success === false) throw new Error('WB price upload reported errors: ' + JSON.stringify(res._itemErrors).slice(0, 200));
            applied = updates.length;
            for (const u of updates) {
                await db.saveWbProductMeta(storeId, u.nmID, { priceBase: u.price, discount: u.discount });
                db.upsertExperiment(storeId, u._offerId, u._advanced); // продвигаем состояние после успеха
            }
        } catch (e) {
            console.error('[Strategy] apply error:', e.message);
            Sentry.withScope(s => { s.setTag('operation', 'strategy_apply'); s.setTag('store_id', storeId); Sentry.captureException(e); });
        }
    }
    return { count: products.length, applied, results };
}

module.exports = { runStore };
