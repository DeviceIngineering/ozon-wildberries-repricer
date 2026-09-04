const { db } = require('./connection.cjs');

// === Глобальные настройки (app_settings) ===
function getAppSetting(key, def = null) {
    const r = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return r ? r.value : def;
}
function setAppSetting(key, value) {
    db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`)
        .run(key, String(value));
}
// Глобальный kill-switch стратегий: '1' = все эксперименты остановлены.
function isGlobalKillSwitch() { return getAppSetting('strategy_kill_switch', '0') === '1'; }

// === Товары в эксперименте ===
// strategy_type != 'ref_price' И in_experiment=1, магазин не под kill-switch.
function getExperimentalProducts(storeId) {
    return db.prepare(`
        SELECT p.id product_id, p.ozon_id, p.offer_id, p.name, p.strategy_type, p.strategy_price_min,
               p.strategy_price_max, p.strategy_target_margin, p.strategy_window_days,
               p.cost_price, p.floor_min_price, p.ref_price, p.wb_subject_id, p.wb_volume_liters,
               p.wb_price_base, p.wb_discount, p.liquidation_max_loss_pct, p.liquidation_active,
               json_extract(p.data_json,'$.price') cur_price
        FROM products p
        WHERE p.store_id = ? AND p.in_experiment = 1
          AND p.strategy_type IS NOT NULL AND p.strategy_type != 'ref_price'`).all(storeId);
}

// === Состояние эксперимента (ladder) ===
function getExperiment(storeId, offerId) {
    return db.prepare('SELECT * FROM experiments WHERE store_id = ? AND offer_id = ?').get(storeId, offerId);
}
function upsertExperiment(storeId, offerId, exp) {
    const cols = ['strategy_type', 'status', 'analysis_window_days', 'current_price', 'step_percent',
        'direction', 'best_price', 'best_metric', 'bad_steps', 'step_started_at', 'sales_since_step',
        'auto_apply', 'last_decision_json'];
    const sets = cols.map(c => `${c} = @${c}`).join(', ');
    const row = { store_id: storeId, offer_id: offerId };
    for (const c of cols) row[c] = exp[c] != null ? exp[c] : null;
    if (row.strategy_type == null) row.strategy_type = 'ref_price'; // NOT NULL guard
    const exists = getExperiment(storeId, offerId);
    if (exists) {
        db.prepare(`UPDATE experiments SET ${sets}, updated_at = CURRENT_TIMESTAMP WHERE store_id=@store_id AND offer_id=@offer_id`).run(row);
        return exists.id;
    }
    const insCols = cols.filter(c => row[c] != null);
    const info = db.prepare(`INSERT INTO experiments (store_id, offer_id, ${insCols.join(', ')})
        VALUES (@store_id, @offer_id, ${insCols.map(c => '@' + c).join(', ')})`).run(row);
    return info.lastInsertRowid;
}

// === Лог решений стратегии ===
function logStrategy(storeId, entry) {
    db.prepare(`INSERT INTO strategy_log (store_id, experiment_id, offer_id, strategy_type, action,
        old_price, new_price, metric_name, metric_value, reason, applied)
        VALUES (@store_id, @experiment_id, @offer_id, @strategy_type, @action,
        @old_price, @new_price, @metric_name, @metric_value, @reason, @applied)`)
        .run({
            store_id: storeId,
            experiment_id: entry.experiment_id != null ? entry.experiment_id : null,
            offer_id: entry.offer_id,
            strategy_type: entry.strategy_type || null,
            action: entry.action || null,
            old_price: entry.old_price != null ? entry.old_price : null,
            new_price: entry.new_price != null ? entry.new_price : null,
            metric_name: entry.metric_name || null,
            metric_value: entry.metric_value != null ? entry.metric_value : null,
            reason: entry.reason || null,
            applied: entry.applied ? 1 : 0,
        });
}

// === Управление (РФ5) ===

// Назначить стратегию товарам (и поставить in_experiment). config — поля стратегии.
function assignStrategy(storeId, offerIds, config = {}) {
    const valid = ['ref_price', 'max_profit', 'max_revenue', 'max_units', 'liquidation'];
    const st = valid.includes(config.strategy_type) ? config.strategy_type : 'ref_price';
    const inExp = st !== 'ref_price' ? 1 : 0;
    const stmt = db.prepare(`UPDATE products SET
        strategy_type = @st, in_experiment = @inExp,
        strategy_price_min = @pmin, strategy_price_max = @pmax,
        strategy_target_margin = @tmargin, strategy_window_days = @win,
        liquidation_max_loss_pct = @liqloss, liquidation_active = @liqactive
        WHERE store_id = @sid AND offer_id = @offer`);
    const tx = db.transaction((ids) => {
        for (const offer of ids) {
            stmt.run({
                st, inExp, sid: storeId, offer,
                pmin: config.price_min != null ? config.price_min : null,
                pmax: config.price_max != null ? config.price_max : null,
                tmargin: config.target_margin != null ? config.target_margin : null,
                win: config.window_days != null ? config.window_days : 14,
                liqloss: config.liquidation_max_loss_pct != null ? config.liquidation_max_loss_pct : null,
                liqactive: (st === 'liquidation') ? 1 : 0,
            });
            // снятие стратегии → закрыть эксперимент
            if (st === 'ref_price') db.prepare('UPDATE experiments SET status = ? WHERE store_id = ? AND offer_id = ?').run('stopped', storeId, offer);
        }
    });
    tx(offerIds);
    return offerIds.length;
}

// Включить/выключить авто-применение (gate) на эксперименте.
function setExperimentAutoApply(storeId, offerId, on) {
    const exp = getExperiment(storeId, offerId);
    if (exp) {
        db.prepare('UPDATE experiments SET auto_apply = ?, updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND offer_id = ?').run(on ? 1 : 0, storeId, offerId);
    } else {
        const p = db.prepare('SELECT strategy_type FROM products WHERE store_id = ? AND offer_id = ? LIMIT 1').get(storeId, offerId);
        upsertExperiment(storeId, offerId, { strategy_type: (p && p.strategy_type) || 'ref_price', status: 'active', auto_apply: on ? 1 : 0 });
    }
}

// Kill-switch магазина.
function setStoreKillSwitch(storeId, on) {
    db.prepare('UPDATE stores SET strategy_kill_switch = ? WHERE id = ?').run(on ? 1 : 0, storeId);
}

// Сводка стратегий магазина: товары + состояние эксперимента + последнее предложение.
function getStrategyOverview(storeId) {
    return db.prepare(`
        SELECT p.offer_id, p.name, p.strategy_type, p.in_experiment, p.strategy_window_days,
               p.ref_price, p.cost_price, p.floor_min_price,
               json_extract(p.data_json,'$.price') cur_price,
               e.current_price, e.best_price, e.best_metric, e.auto_apply, e.status, e.updated_at exp_updated,
               (SELECT action FROM strategy_log sl WHERE sl.store_id=p.store_id AND sl.offer_id=p.offer_id ORDER BY sl.id DESC LIMIT 1) last_action,
               (SELECT new_price FROM strategy_log sl WHERE sl.store_id=p.store_id AND sl.offer_id=p.offer_id ORDER BY sl.id DESC LIMIT 1) last_proposed,
               (SELECT reason FROM strategy_log sl WHERE sl.store_id=p.store_id AND sl.offer_id=p.offer_id ORDER BY sl.id DESC LIMIT 1) last_reason
        FROM products p
        LEFT JOIN experiments e ON e.store_id=p.store_id AND e.offer_id=p.offer_id
        WHERE p.store_id = ? AND p.strategy_type IS NOT NULL AND p.strategy_type != 'ref_price'
        ORDER BY p.offer_id`).all(storeId);
}

function getStrategyLog(storeId, limit = 200) {
    return db.prepare(`SELECT offer_id, timestamp, strategy_type, action, old_price, new_price,
        metric_name, metric_value, reason, applied FROM strategy_log
        WHERE store_id = ? ORDER BY id DESC LIMIT ?`).all(storeId, limit);
}

module.exports = {
    getAppSetting, setAppSetting, isGlobalKillSwitch,
    getExperimentalProducts, getExperiment, upsertExperiment, logStrategy,
    assignStrategy, setExperimentAutoApply, setStoreKillSwitch,
    getStrategyOverview, getStrategyLog,
};
