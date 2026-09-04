const { db, dbRun, dbGet, dbAll, generateUUID } = require('./connection.cjs');

function getAllStores() {
    return dbAll(db, "SELECT * FROM stores");
}

function getStoreById(id) {
    return dbGet(db, "SELECT * FROM stores WHERE id = ?", [id]);
}

function createStore(store) {
    const id = generateUUID();
    const sql = `INSERT INTO stores (id, name, client_id, api_key, update_interval_minutes, antiban_enabled, repricer_enabled, repricer_interval_min, threshold_drop_percent, threshold_rise_percent, platform, ym_business_id, ym_campaign_id, ym_api_key, wb_api_key, promo_guard_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    const params = [
        id,
        store.name,
        store.client_id || '',
        store.api_key || '',
        store.update_interval_minutes || 60,
        store.antiban_enabled ? 1 : 0,
        store.repricer_enabled ? 1 : 0,
        store.repricer_interval_min || 15,
        store.threshold_drop_percent || 5.0,
        store.threshold_rise_percent || 5.0,
        store.platform || 'ozon',
        store.ym_business_id || null,
        store.ym_campaign_id || null,
        store.ym_api_key || null,
        store.wb_api_key || null,
        store.promo_guard_enabled ? 1 : 0,
    ];
    return dbRun(db, sql, params).then(() => ({ id, ...store }));
}

function updateStore(id, store) {
    const sql = `UPDATE stores SET name = ?, client_id = ?, api_key = ?, update_interval_minutes = ?, antiban_enabled = ?, repricer_enabled = ?, repricer_interval_min = ?, threshold_drop_percent = ?, threshold_rise_percent = ?, platform = ?, ym_business_id = ?, ym_campaign_id = ?, ym_api_key = ?, wb_api_key = ?, tax_rate = ?, min_margin_percent = ?, promo_guard_enabled = ?, promo_exit_enabled = ?, promo_max_discount_percent = ?, ym_boost_cap_percent = ?, ym_floor_max_raise_percent = ?, ym_promo_exit_enabled = ? WHERE id = ?`;
    const params = [
        store.name, store.client_id || '', store.api_key || '',
        store.update_interval_minutes,
        store.antiban_enabled ? 1 : 0,
        store.repricer_enabled ? 1 : 0,
        store.repricer_interval_min,
        store.threshold_drop_percent,
        store.threshold_rise_percent,
        store.platform || 'ozon',
        store.ym_business_id || null,
        store.ym_campaign_id || null,
        store.ym_api_key || null,
        store.wb_api_key || null,
        store.tax_rate || 0,
        store.min_margin_percent || 0,
        store.promo_guard_enabled ? 1 : 0,
        store.promo_exit_enabled ? 1 : 0,
        store.promo_max_discount_percent != null ? Number(store.promo_max_discount_percent) : 5,
        store.ym_boost_cap_percent != null ? Number(store.ym_boost_cap_percent) : 30,
        store.ym_floor_max_raise_percent != null ? Number(store.ym_floor_max_raise_percent) : 20,
        store.ym_promo_exit_enabled ? 1 : 0,
        id
    ];
    return dbRun(db, sql, params).then(() => ({ id, ...store }));
}

// Сохранить список разрешённых акций (whitelist). Принимает массив action_id.
function updateStoreAllowedPromos(id, allowedActionIds) {
    const ids = Array.isArray(allowedActionIds) ? allowedActionIds : [];
    const json = JSON.stringify([...new Set(ids.map(Number).filter(n => Number.isFinite(n)))]);
    return dbRun(db, "UPDATE stores SET promo_allowed_actions = ? WHERE id = ?", [json, id]);
}

async function deleteStore(id) {
    try {
        const tx = db.transaction((storeId) => {
            db.prepare('DELETE FROM api_logs WHERE store_id = ?').run(storeId);
            db.prepare('DELETE FROM repricer_log WHERE store_id = ?').run(storeId);
            db.prepare('DELETE FROM price_updates_pending WHERE store_id = ?').run(storeId);
            db.prepare('DELETE FROM price_snapshots WHERE store_id = ?').run(storeId);
            db.prepare('DELETE FROM scheduled_updates WHERE store_id = ?').run(storeId);
            db.prepare('DELETE FROM price_imports WHERE store_id = ?').run(storeId);
            db.prepare('DELETE FROM sync_log_entries WHERE log_id IN (SELECT id FROM sync_logs WHERE store_id = ?)').run(storeId);
            db.prepare('DELETE FROM sync_logs WHERE store_id = ?').run(storeId);
            db.prepare('DELETE FROM price_history WHERE product_id IN (SELECT id FROM products WHERE store_id = ?)').run(storeId);
            db.prepare('DELETE FROM products WHERE store_id = ?').run(storeId);
            db.prepare('DELETE FROM stores WHERE id = ?').run(storeId);
        });
        tx(id);
    } catch (err) {
        return Promise.reject(err);
    }
}

function updateStoreTimestamp(id) {
    return dbRun(db, "UPDATE stores SET last_updated_at = CURRENT_TIMESTAMP WHERE id = ?", [id]);
}

function updateStoreRepricerLastRun(id) {
    return dbRun(db, "UPDATE stores SET last_repricer_run = CURRENT_TIMESTAMP WHERE id = ?", [id]);
}

function updateStoreMonitorTimestamp(id) {
    return dbRun(db, "UPDATE stores SET last_monitor_run = CURRENT_TIMESTAMP WHERE id = ?", [id]);
}

function updateStorePromoExitTimestamp(id) {
    return dbRun(db, "UPDATE stores SET last_promo_exit_run = CURRENT_TIMESTAMP WHERE id = ?", [id]);
}

module.exports = {
    getAllStores, getStoreById, createStore, updateStore, deleteStore,
    updateStoreTimestamp, updateStoreRepricerLastRun, updateStoreMonitorTimestamp,
    updateStorePromoExitTimestamp, updateStoreAllowedPromos,
};
