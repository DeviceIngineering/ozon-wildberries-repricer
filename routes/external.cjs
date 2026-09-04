const express = require('express');
const router = express.Router();
const db = require('../db.cjs');
const ozonFetcher = require('../ozonFetcher.cjs');
const yandexFetcher = require('../yandexFetcher.cjs');
const wbFetcher = require('../wbFetcher.cjs');
const { computeOldPrice } = require('../lib/priceHelpers.cjs');
const wrap = require('../middleware/asyncHandler.cjs');
const proj = require('../lib/apiProjection.cjs');

function getFetcher(platform) {
    if (platform === 'yandex') return yandexFetcher;
    if (platform === 'wildberries') return wbFetcher;
    return ozonFetcher;
}

// Магазин без секретов (токены маркетплейсов наружу не отдаём).
// Раньше работало по принципу «вырезать секреты», из-за чего наружу уходили
// все 26 колонок магазина, включая операторские настройки, которые агенту не
// нужны. Теперь белый список: что не перечислено — не отдаётся.
// ?full=1 возвращает прежний расширенный вид (без секретов).
function sanitizeStore(s, { full = false } = {}) {
    if (!s) return s;
    const {
        api_key, client_id, wb_api_key, ym_api_key, ym_business_id, ym_campaign_id,
        ...safe
    } = s;
    const creds = {
        has_ozon_creds: !!(api_key && client_id),
        has_wb_creds: !!wb_api_key,
        has_ym_creds: !!ym_api_key,
    };
    if (full) return { ...safe, ...creds };

    const out = {};
    for (const f of proj.STORE_AGENT_FIELDS) if (safe[f] !== undefined) out[f] = safe[f];
    return { ...out, ...creds };
}

// Проставить данные для аудита (пишутся middleware на finish).
function audit(req, { store_id = null, action = null, summary = null, affected_count = 0 }) {
    req._audit = { store_id, action, summary, affected_count };
}

/**
 * Отправка цен в маркетплейс + запись эталона (репрайсер держит цену агента) + snapshot + pending.
 * Ценовые рельсы (floor, лимит скачка, владение SKU) применяет validatePriceUpdates
 * до вызова этой функции — здесь только отправка и полный аудит.
 * dry_run включён по умолчанию: забытое поле не должно двигать реальные цены.
 * @returns {Promise<{sent:number, item_errors:any[], dry_run:boolean}>}
 */
async function sendPricesToStore(store, updates, { dry_run = true } = {}) {
    const storeId = store.id;
    const allProducts = await db.getStoreProducts(storeId);
    const byOffer = new Map(allProducts.map((p) => [p.offer_id, p]));

    // Нормализация: old_price вычисляем, если не задан.
    const normalized = updates.map((u) => {
        const price = parseFloat(u.price) || 0;
        const minPrice = u.min_price != null ? parseFloat(u.min_price) : price;
        const oldPrice = parseFloat(u.old_price);
        return {
            offer_id: u.offer_id,
            price: String(price),
            min_price: String(minPrice),
            old_price: (oldPrice > 0) ? String(oldPrice) : String(computeOldPrice(price, minPrice)),
        };
    }).filter((u) => u.offer_id && parseFloat(u.price) > 0);

    if (dry_run) {
        return { sent: 0, item_errors: [], dry_run: true, preview: normalized };
    }

    // Снапшот текущих цен (для отката).
    const snapItems = normalized
        .map((u) => byOffer.get(u.offer_id))
        .filter(Boolean)
        .map((p) => ({ offer_id: p.offer_id, price: p.price || '0', old_price: p.old_price || '0', min_price: p.min_price || '0' }));
    await db.createSnapshot(storeId, 'external-api', snapItems.length, JSON.stringify(snapItems), 'manual', 'Внешний API (агент ценообразования)');

    // Отправка через нужный fetcher.
    const fetcher = getFetcher(store.platform);
    let result;
    if (store.platform === 'wildberries') {
        result = await fetcher.updateProductPrices(store.wb_api_key, normalized, storeId, 'external-api');
    } else {
        result = await fetcher.updateProductPrices(store.client_id, store.api_key, normalized, storeId, 'external-api');
    }

    // Записать эталон (ref_price) — чтобы репрайсер ДЕРЖАЛ цену агента, а не откатывал.
    const verifyAfter = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    for (const u of normalized) {
        await db.updateProductRefPrice(storeId, u.offer_id, u.price, u.min_price || '0');
        const p = byOffer.get(u.offer_id);
        if (p && p.id) {
            await db.createPendingUpdate({
                store_id: storeId, product_id: p.id, offer_id: u.offer_id,
                sent_price: parseFloat(u.price) || 0,
                sent_min_price: u.min_price ? parseFloat(u.min_price) : null,
                sent_old_price: u.old_price ? parseFloat(u.old_price) : null,
                verify_after: verifyAfter,
            });
        }
    }
    return { sent: normalized.length, item_errors: result?._itemErrors || [], dry_run: false };
}

// ═══════════════════════════ GOVERNANCE: одно поле знаний ═══════════════════════════

// GET /context — живой контекст проекта: версия, политики, владение SKU, активные решения.
// ОБЯЗАТЕЛЕН к прочтению перед любыми действиями. context_version из ответа передаётся в POST /prices.
router.get('/context', wrap(async (req, res) => {
    res.json({ data: db.getContext() });
}));

// GET /briefing — живой брифинг проекта в markdown (команда пользователя «ознакомься»).
// Собирается из журнала решений/политик/владения SKU. После прочтения агент подтверждает ack.
router.get('/briefing', wrap(async (req, res) => {
    res.type('text/markdown').send(db.getBriefing());
}));

// POST /briefing/ack — подтверждение ознакомления { agent }
router.post('/briefing/ack', wrap(async (req, res) => {
    const { agent } = req.body || {};
    if (!agent) return res.status(400).json({ error: 'agent is required', code: 'bad_request' });
    const r = db.ackBriefing(agent);
    audit(req, { action: 'briefing.ack', summary: `${agent} @ v${r.context_version}` });
    res.json({ success: true, ...r });
}));

// GET /briefing/acks — кто ознакомился и актуальна ли его версия
router.get('/briefing/acks', wrap(async (req, res) => {
    res.json({ data: db.listAcks(), current_version: db.getContextVersion() });
}));

// GET /decisions?status=active|done|all — журнал решений/намерений
router.get('/decisions', wrap(async (req, res) => {
    const status = req.query.status === 'all' ? null : (req.query.status || 'active');
    res.json({ data: db.listDecisions({ status, limit: Math.min(500, parseInt(req.query.limit, 10) || 100) }) });
}));

// POST /decisions — объявить решение/намерение/политику. Инкрементирует context_version.
// body: { agent, kind: decision|intent|policy, title, body?, store_id?, skus?, active_until? }
router.post('/decisions', wrap(async (req, res) => {
    const { agent, kind, title, body, store_id, skus, active_until } = req.body || {};
    if (!agent || !title) return res.status(400).json({ error: 'agent and title are required', code: 'bad_request' });
    const r = db.addDecision({ author: agent, kind, title, body, store_id, skus, active_until });
    audit(req, { store_id: store_id || null, action: 'decision.add', summary: `[${kind || 'decision'}] ${title}`.slice(0, 200) });
    res.json({ success: true, id: r.id, context_version: r.context_version });
}));

// PATCH /decisions/:id — закрыть/отменить решение { status: done|cancelled }
router.patch('/decisions/:id', wrap(async (req, res) => {
    const changed = db.closeDecision(parseInt(req.params.id, 10), req.body.status || 'done');
    if (!changed) return res.status(404).json({ error: 'Decision not found', code: 'not_found' });
    audit(req, { action: 'decision.close', summary: `#${req.params.id} → ${req.body.status || 'done'}` });
    res.json({ success: true, context_version: db.getContextVersion() });
}));

// PATCH /products/:offerId/management — режим управления SKU (владение)
// body: { agent, store_id, mode: ref_price|experiment|liquidation|disposal, reason? }
router.patch('/products/:offerId/management', wrap(async (req, res) => {
    const { agent, store_id, mode, reason } = req.body || {};
    if (!agent || !store_id || !mode) return res.status(400).json({ error: 'agent, store_id, mode are required', code: 'bad_request' });
    // Смена чужого режима запрещена (кроме user)
    const cur = (await db.getStoreProducts(store_id)).find((p) => p.offer_id === req.params.offerId);
    if (!cur) return res.status(404).json({ error: 'Offer not found', code: 'not_found' });
    if (cur.management_mode && cur.management_mode !== 'ref_price' && cur.managed_by && cur.managed_by !== agent && agent !== 'user') {
        return res.status(403).json({ error: `SKU в режиме ${cur.management_mode}, владелец ${cur.managed_by}`, code: 'sku_owned' });
    }
    const changed = db.setManagementMode(store_id, [req.params.offerId], mode, agent, reason || null);
    audit(req, { store_id, action: 'management.set', summary: `${req.params.offerId} → ${mode} (${agent})`, affected_count: changed });
    res.json({ success: true, changed, context_version: db.getContextVersion() });
}));

// GET /stores/:id/pnl?days=40 — ЕДИНАЯ расчётная истина по прибыли.
// Агентам запрещено считать прибыль самостоятельно (особенно соинвест!) — читать отсюда.
router.get('/stores/:id/pnl', wrap(async (req, res) => {
    const store = await db.getStoreById(req.params.id);
    if (!store) return res.status(404).json({ error: 'Store not found', code: 'not_found' });
    const days = Math.min(90, parseInt(req.query.days, 10) || 40);
    const verbose = req.query.verbose === '1' || req.query.verbose === 'true';
    const { db: raw } = require('../db/connection.cjs');
    const agg = raw.prepare(`SELECT sum(units) units, sum(revenue) revenue,
        sum(CASE WHEN cost_unit IS NOT NULL THEN cost_unit*units ELSE 0 END) cogs
        FROM sales_daily WHERE store_id = ? AND date >= date('now', ?)`).get(store.id, `-${days} days`);
    const policies = db.getPolicies();
    const revenue = agg.revenue || 0;
    const isOzon = store.platform === 'ozon';
    const coinvest = isOzon ? revenue * policies.coinvest_share_ozon : 0;
    const buyerMoney = revenue - coinvest;
    const tax = buyerMoney * (parseFloat(store.tax_rate) || 0) / 100;
    res.json({
        data: {
            store: store.name, platform: store.platform, window_days: days,
            units: agg.units || 0,
            revenue_accrued: Math.round(revenue),
            coinvest_included: Math.round(coinvest),
            buyer_money: Math.round(buyerMoney),
            cogs: Math.round(agg.cogs || 0),
            gross_before_fees: Math.round(revenue - (agg.cogs || 0)),
            tax_estimate: Math.round(tax),
            // Методика — константа, но раньше приезжала при каждом вызове и
            // занимала 59% ответа. Теперь только по ?verbose=1; без него —
            // короткий маркер, по которому агент поймёт, что правила те же.
            ...(verbose
                ? {
                    methodology: [
                        `Выручка — начисления из sales_daily (${isOzon ? 'включая соинвест Ozon ~' + Math.round(policies.coinvest_share_ozon * 100) + '%' : 'цена продавца'}).`,
                        'Соинвест НЕ облагается налогом и НЕ означает, что цены занижены — НЕ поднимать цены на его основании.',
                        'gross_before_fees НЕ включает комиссию/логистику/рекламу/хранение маркетплейса — реальная чистая прибыль ниже. Полный P&L по финансовым API — у пользователя.',
                    ],
                }
                : { methodology_ref: 'pnl/v1 — полный текст: ?verbose=1' }),
        },
    });
}));

// ═══════════════════════════ ЧТЕНИЕ ═══════════════════════════

// GET /health — сводка состояния репрайсера
router.get('/health', wrap(async (req, res) => {
    const stores = await db.getAllStores();
    res.json({
        ok: true,
        external_api_enabled: db.isExternalApiEnabled(),
        stores_count: stores.length,
        stores: stores.map((s) => ({
            id: s.id, name: s.name, platform: s.platform,
            repricer_enabled: !!s.repricer_enabled,
            kill_switch: !!s.strategy_kill_switch,
            last_updated_at: s.last_updated_at,
        })),
        global_kill_switch: db.getAppSetting ? db.getAppSetting('strategy_kill_switch', '0') === '1' : undefined,
    });
}));

// GET /stores — список магазинов (без секретов)
router.get('/stores', wrap(async (req, res) => {
    const stores = await db.getAllStores();
    const full = req.query.full === '1' || req.query.full === 'true';
    res.json({ data: stores.map((s) => sanitizeStore(s, { full })) });
}));

// GET /stores/:id — детали магазина
router.get('/stores/:id', wrap(async (req, res) => {
    const s = await db.getStoreById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Store not found', code: 'not_found' });
    res.json({ data: sanitizeStore(s, { full: req.query.full === '1' || req.query.full === 'true' }) });
}));

// GET /stores/:id/products — товары (пагинация/фильтры/поиск)
// ?fields=a,b,c либо ?fields=default — только нужные поля (null отбрасываются).
// ?format=compact — {cols:[...], rows:[[...]]} вместо массива объектов.
// Полный формат остаётся по умолчанию: существующие агенты не ломаются.
router.get('/stores/:id/products', wrap(async (req, res) => {
    const s = await db.getStoreById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Store not found', code: 'not_found' });
    const { page, pageSize, sort, search, filter, format } = req.query;
    const result = await db.getStoreProductsPaginated(req.params.id, {
        page: parseInt(page, 10) || 1,
        pageSize: Math.min(500, parseInt(pageSize, 10) || 50),
        sort, search, filter,
    });

    const allowed = result.items.length ? Object.keys(result.items[0]) : proj.PRODUCT_PRICING_FIELDS;
    const fields = proj.parseFields(req.query.fields, allowed, proj.PRODUCT_PRICING_FIELDS);
    const { payload } = proj.shape(result.items, { fields, format });

    res.json({
        data: payload,
        meta: {
            total: result.total, page: result.page, pageSize: result.pageSize,
            ...(format === 'compact' ? { format: 'compact' } : {}),
        },
    });
}));

// GET /stores/:id/sales?window=30 — дневные продажи (для оценки спроса)
router.get('/stores/:id/sales', wrap(async (req, res) => {
    const s = await db.getStoreById(req.params.id);
    if (!s) return res.status(404).json({ error: 'Store not found', code: 'not_found' });
    const windowDays = Math.min(90, parseInt(req.query.window, 10) || 30);
    if (req.query.offer_id) {
        const rows = await db.getSalesWindow(req.params.id, req.query.offer_id, windowDays);
        return res.json({ data: rows, meta: { offer_id: req.query.offer_id, window: windowDays } });
    }
    const top = await db.getTopSellingOffers(req.params.id, windowDays, Math.min(200, parseInt(req.query.limit, 10) || 50));
    res.json({ data: top, meta: { window: windowDays } });
}));

// GET /stores/:id/repricer-logs — лог репрайсера
// store_id повторяется в каждой строке, хотя стоит в URL, а run_id — UUID
// ценой в 27 токенов на строку. Оба вынесены: список прогонов идёт в meta.
router.get('/stores/:id/repricer-logs', wrap(async (req, res) => {
    const result = await db.getRepricerLogs(req.params.id, {
        action: req.query.action || null,
        period: req.query.period || null,
        page: parseInt(req.query.page, 10) || 1,
        limit: Math.min(500, parseInt(req.query.limit, 10) || 100),
    });
    const rows = result.items || result.data || [];
    const runs = [...new Set(rows.map(r => r.run_id).filter(Boolean))];
    res.json({
        ...result,
        [result.items ? 'items' : 'data']: proj.omit(rows, ['store_id', 'run_id']),
        meta: { ...(result.meta || {}), store_id: req.params.id, runs },
    });
}));

// GET /stores/:id/pending — статус отправок цен
// ?summary=1 — счётчики по статусам и список упавших вместо всех строк.
// ?limit= (по умолчанию 100, максимум 500), ?since=ISO-дата.
// store_id и product_id из строк убраны: первый есть в URL, второй агенту не нужен.
router.get('/stores/:id/pending', wrap(async (req, res) => {
    const since = req.query.since || null;

    if (req.query.summary === '1' || req.query.summary === 'true') {
        const summary = await db.getPendingSummary(req.params.id, { since });
        return res.json({ data: summary, meta: { store_id: req.params.id, since } });
    }

    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    const rows = await db.getPendingUpdates(req.params.id, req.query.status, { limit, since });
    res.json({
        data: proj.omit(rows, ['store_id', 'product_id']),
        meta: { store_id: req.params.id, count: rows.length, limit, truncated: rows.length === limit },
    });
}));

// GET /products/:offerId/cross-store — цены изделия по всем магазинам
router.get('/products/:offerId/cross-store', wrap(async (req, res) => {
    const rows = await db.getCrossStoreProducts(req.params.offerId);
    res.json({ data: rows });
}));

// ═══════════════════════════ ЦЕНЫ ═══════════════════════════

// POST /stores/:id/prices — прямая отправка цен (агент задаёт цену, репрайсер её держит).
// GOVERNANCE: обязательны context_version (из GET /context) и agent (имя агента).
// body: { agent, context_version, updates: [{offer_id, price, min_price?, old_price?}],
//         dry_run?: boolean, confirm_mass?: boolean }
router.post('/stores/:id/prices', wrap(async (req, res) => {
    const store = await db.getStoreById(req.params.id);
    if (!store) return res.status(404).json({ error: 'Store not found', code: 'not_found' });
    const { updates, dry_run = true, agent, context_version, confirm_mass = false } = req.body || {};
    if (!Array.isArray(updates) || updates.length === 0) {
        return res.status(400).json({ error: 'updates array is required', code: 'bad_request' });
    }
    // Слои 1/2/4: версия контекста, владение SKU, рельсы
    const v = db.validatePriceUpdates(store, updates, { agent, contextVersion: context_version, confirmMass: confirm_mass });
    if (!v.ok) {
        // Раскрываем всё, что положил governance: для context_stale это
        // current_version / your_version / changed, для остальных — ничего лишнего.
        const { status, message, code, ...rest } = v.error;
        return res.status(status).json({ error: message, code, ...rest });
    }
    if (v.accepted.length === 0) {
        audit(req, { store_id: store.id, action: 'prices.rejected', summary: `${agent}: все ${updates.length} отклонены governance`, affected_count: 0 });
        return res.status(422).json({ error: 'Все позиции отклонены governance-валидацией', code: 'all_rejected', rejected: v.rejected });
    }
    const result = await sendPricesToStore(store, v.accepted, { dry_run });
    audit(req, { store_id: store.id, action: dry_run ? 'prices.dry_run' : 'prices.send', summary: `${agent}: ${v.accepted.length} шт (отклонено ${v.rejected.length})`, affected_count: result.sent });
    res.json({ success: true, ...result, rejected: v.rejected, context_version: db.getContextVersion() });
}));

// PUT /products/:offerId/master-price — эталон во все магазины изделия
router.put('/products/:offerId/master-price', wrap(async (req, res) => {
    const master = Number(req.body.master_price);
    if (!(master > 0)) return res.status(400).json({ error: 'master_price must be > 0', code: 'bad_request' });
    // GOVERNANCE per-store: товар одинаковый везде, но режимы у каждого магазина СВОИ
    // (в одном — слив/утилизация, в других — обычная торговля). Мастер-цена применяется
    // только к магазинам в обычном режиме; управляемые пропускаются и перечисляются в ответе.
    const changed = await db.setMasterPrice(req.params.offerId, master);
    const skipped = db.getManagedStoresForOffer(req.params.offerId)
        .map((r) => ({ store: r.store_name, platform: r.platform, mode: r.management_mode, owner: r.managed_by, reason: r.freeze_reason }));
    if (changed === 0 && skipped.length === 0) return res.status(404).json({ error: 'Offer not found', code: 'not_found' });
    audit(req, { action: 'master_price.set', summary: `${req.params.offerId}=${master} (пропущено управляемых: ${skipped.length})`, affected_count: changed });
    res.json({ success: true, offer_id: req.params.offerId, master_price: master, stores_updated: changed, stores_skipped: skipped });
}));

// POST /stores/:id/repricer/run — запустить прогон репрайсера
router.post('/stores/:id/repricer/run', wrap(async (req, res) => {
    const store = await db.getStoreById(req.params.id);
    if (!store) return res.status(404).json({ error: 'Store not found', code: 'not_found' });
    if (!store.repricer_enabled) return res.status(400).json({ error: 'Repricer disabled for this store', code: 'repricer_disabled' });
    const { checkStore } = require('../repricer.cjs');
    await checkStore(req.params.id);
    audit(req, { store_id: store.id, action: 'repricer.run', summary: 'manual run' });
    res.json({ success: true });
}));

// ═══════════════════════════ СТРАТЕГИИ / KILL-SWITCH ═══════════════════════════

// PATCH /products/:offerId/strategy — стратегия для товара (во всех магазинах изделия или одном)
// body: { store_id?, strategy_type, price_min?, price_max?, target_margin?, window_days?, liquidation_max_loss_pct? }
router.patch('/products/:offerId/strategy', wrap(async (req, res) => {
    const { store_id } = req.body || {};
    const offerId = req.params.offerId;
    let storeIds = [];
    if (store_id) {
        storeIds = [store_id];
    } else {
        const rows = await db.getCrossStoreProducts(offerId);
        storeIds = [...new Set(rows.map((r) => r.store_id))];
    }
    if (storeIds.length === 0) return res.status(404).json({ error: 'Offer not found', code: 'not_found' });
    // GOVERNANCE per-store: пропускаем магазины, где SKU в управляемом режиме у другого владельца
    const agent = (req.body || {}).agent || null;
    const managedMap = new Map(db.getManagedStoresForOffer(offerId).map((r) => [r.store_id, r]));
    const skipped = [];
    let total = 0;
    for (const sid of storeIds) {
        const m = managedMap.get(sid);
        if (m && (m.management_mode === 'disposal' || (m.managed_by && m.managed_by !== agent && agent !== 'user'))) {
            skipped.push({ store: m.store_name, mode: m.management_mode, owner: m.managed_by });
            continue;
        }
        total += db.assignStrategy(sid, [offerId], req.body || {});
    }
    audit(req, { store_id: store_id || null, action: 'strategy.assign', summary: `${offerId} → ${(req.body || {}).strategy_type} (пропущено: ${skipped.length})`, affected_count: total });
    res.json({ success: true, offer_id: offerId, stores_updated: total, stores_skipped: skipped });
}));

// POST /stores/:id/kill-switch — kill-switch магазина { enabled: bool }
router.post('/stores/:id/kill-switch', wrap(async (req, res) => {
    const store = await db.getStoreById(req.params.id);
    if (!store) return res.status(404).json({ error: 'Store not found', code: 'not_found' });
    const on = !!req.body.enabled;
    db.setStoreKillSwitch(req.params.id, on);
    audit(req, { store_id: store.id, action: 'kill_switch.store', summary: `enabled=${on}` });
    res.json({ success: true, store_id: req.params.id, kill_switch: on });
}));

// POST /kill-switch/global — глобальный kill-switch { enabled: bool }
router.post('/kill-switch/global', wrap(async (req, res) => {
    const on = !!req.body.enabled;
    db.setAppSetting('strategy_kill_switch', on ? '1' : '0');
    audit(req, { action: 'kill_switch.global', summary: `enabled=${on}` });
    res.json({ success: true, global_kill_switch: on });
}));

// ═══════════════════════════ МАГАЗИНЫ (только настройки репрайсера) ═══════════════════════════

// PATCH /stores/:id/settings — настройки репрайсера (без токенов/CRUD)
const ALLOWED_SETTINGS = [
    'repricer_enabled', 'repricer_interval_min', 'update_interval_minutes',
    'threshold_drop_percent', 'threshold_rise_percent', 'antiban_enabled',
    'min_margin_percent', 'tax_rate',
];
router.patch('/stores/:id/settings', wrap(async (req, res) => {
    const store = await db.getStoreById(req.params.id);
    if (!store) return res.status(404).json({ error: 'Store not found', code: 'not_found' });
    // Берём только разрешённые поля, поверх текущих значений магазина (updateStore ждёт полный объект).
    const patch = {};
    for (const key of ALLOWED_SETTINGS) {
        if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'no allowed settings provided', code: 'bad_request', allowed: ALLOWED_SETTINGS });
    }
    await db.updateStore(req.params.id, { ...store, ...patch });
    audit(req, { store_id: store.id, action: 'store.settings', summary: Object.keys(patch).join(','), affected_count: Object.keys(patch).length });
    const updated = await db.getStoreById(req.params.id);
    res.json({ success: true, data: sanitizeStore(updated) });
}));

module.exports = router;
