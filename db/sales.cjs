const { db } = require('./connection.cjs');

/**
 * Append-only запись дневных продаж (одна строка на store×offer×date).
 * При повторном сборе того же дня — обновляем агрегат (UPSERT по UNIQUE(store_id, offer_id, date)).
 */
function upsertSalesDaily(storeId, rows) {
    if (!rows || rows.length === 0) return 0;
    const cols = ['product_id', 'offer_id', 'marketplace', 'date', 'units', 'revenue', 'profit',
        'price_seller', 'price_buyer_est', 'cost_unit', 'commission_pct', 'floor', 'ceiling',
        'promo_flag', 'promo_price', 'ad_spend', 'boost_pct', 'stock_qty', 'in_stock_flag',
        'spp_pct', 'comp_price', 'experiment_id', 'step_idx', 'is_dirty_flag', 'liquidation_flag'];
    const placeholders = cols.map(c => '@' + c).join(', ');
    const updates = cols.filter(c => c !== 'offer_id' && c !== 'date').map(c => `${c} = excluded.${c}`).join(', ');
    const stmt = db.prepare(`INSERT INTO sales_daily (store_id, ${cols.join(', ')})
        VALUES (@store_id, ${placeholders})
        ON CONFLICT(store_id, offer_id, date) DO UPDATE SET ${updates}`);
    const tx = db.transaction((items) => {
        for (const r of items) {
            const row = { store_id: storeId };
            for (const c of cols) row[c] = r[c] != null ? r[c] : null;
            stmt.run(row);
        }
    });
    tx(rows);
    return rows.length;
}

/**
 * Агрегат продаж SKU за окно дней для движка стратегий.
 * Только «чистые» дни (is_dirty_flag=0): без промо/слива/стокаута — честный сигнал спроса.
 */
function getSalesWindow(storeId, offerId, windowDays = 14) {
    const since = `-${windowDays} days`;
    const clean = db.prepare(
        `SELECT COALESCE(SUM(units),0) units, COALESCE(SUM(revenue),0) revenue, COUNT(*) salesDays
         FROM sales_daily WHERE store_id = ? AND offer_id = ? AND date >= date('now', ?) AND is_dirty_flag = 0`
    ).get(storeId, offerId, since);
    const dirtyRow = db.prepare(
        `SELECT COUNT(*) dirtyDays FROM sales_daily WHERE store_id = ? AND offer_id = ? AND date >= date('now', ?) AND is_dirty_flag = 1`
    ).get(storeId, offerId, since);
    const dirtyDays = dirtyRow.dirtyDays || 0;
    // Экспозиция (дни) = всё окно минус грязные дни. Дни без продаж НЕ записываются в sales_daily,
    // но они часть экспозиции (сигнал низкого спроса) → λ = чистые_штуки / (окно − грязные дни).
    const exposureDays = Math.max(1, windowDays - dirtyDays);
    return {
        units: clean.units || 0,
        days: exposureDays,
        salesDays: clean.salesDays || 0, // дни, в которые реально были продажи
        dirtyDays,
        revenue: clean.revenue || 0,
    };
}

/** Топ-N SKU магазина по объёму продаж за окно (для авто-выбора пилотных товаров). */
function getTopSellingOffers(storeId, windowDays = 30, limit = 20) {
    return db.prepare(
        `SELECT offer_id, SUM(units) total_units, SUM(revenue) total_revenue, COUNT(*) days
         FROM sales_daily WHERE store_id = ? AND date >= date('now', ?)
         GROUP BY offer_id HAVING total_units > 0
         ORDER BY total_units DESC LIMIT ?`
    ).all(storeId, `-${windowDays} days`, limit);
}

/** Последняя дата с продажами (для инкрементального сбора). */
function getLastSalesDate(storeId) {
    const r = db.prepare(`SELECT MAX(date) d FROM sales_daily WHERE store_id = ?`).get(storeId);
    return r && r.d ? r.d : null;
}

module.exports = { upsertSalesDaily, getSalesWindow, getTopSellingOffers, getLastSalesDate };
