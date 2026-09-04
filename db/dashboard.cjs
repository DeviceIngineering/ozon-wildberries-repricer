const { db, dbRun, dbGet, dbAll } = require('./connection.cjs');

async function getDashboardSummary() {
    const stores = await dbAll(db, 'SELECT * FROM stores');
    const summaries = [];
    for (const store of stores) {
        const counts = await dbGet(db, `
            SELECT
                COUNT(*) as product_count,
                SUM(CASE WHEN is_quarantine = 1 THEN 1 ELSE 0 END) as quarantine_count,
                SUM(CASE WHEN is_archived = 1 THEN 1 ELSE 0 END) as archived_count,
                SUM(CASE WHEN price_apply_status = 'REJECTED' THEN 1 ELSE 0 END) as price_rejected_count,
                SUM(CASE WHEN in_promo = 1 AND promo_price IS NOT NULL AND cost_price IS NOT NULL AND promo_price < cost_price THEN 1 ELSE 0 END) as promo_below_cost_count,
                SUM(CASE WHEN visibility != 'VISIBLE' AND is_quarantine = 0 AND is_archived = 0 THEN 1 ELSE 0 END) as invisible_count,
                SUM(CASE WHEN ref_price IS NOT NULL AND ref_price > 0 THEN 1 ELSE 0 END) as ref_price_count,
                SUM(CASE WHEN in_promo = 1 THEN 1 ELSE 0 END) as promo_count,
                SUM(CASE WHEN ref_price > 0 AND in_promo = 1
                    AND CAST(json_extract(data_json, '$.price') AS REAL) < ref_price
                    THEN 1 ELSE 0 END) as below_ref_promo_count,
                SUM(CASE WHEN ref_price > 0 AND (in_promo = 0 OR in_promo IS NULL)
                    AND CAST(json_extract(data_json, '$.price') AS REAL) < ref_price
                    THEN 1 ELSE 0 END) as below_ref_other_count,
                SUM(CASE WHEN floor_min_price IS NOT NULL AND floor_min_price > 0
                    AND CAST(json_extract(data_json, '$.min_price') AS REAL) < floor_min_price
                    THEN 1 ELSE 0 END) as below_floor_count
            FROM products WHERE store_id = ?
        `, [store.id]);

        const failRow = await dbGet(db, `
            SELECT COUNT(*) as cnt FROM price_updates_pending
            WHERE store_id = ? AND status = 'VERIFIED_FAIL'
            AND sent_at > datetime('now', '-24 hours')
        `, [store.id]);

        summaries.push({
            id: store.id,
            name: store.name,
            platform: store.platform || 'ozon',
            repricer_enabled: store.repricer_enabled,
            repricer_interval_min: store.repricer_interval_min || 15,
            last_repricer_run: store.last_repricer_run || null,
            tax_rate: store.tax_rate || 0,
            min_margin_percent: store.min_margin_percent || 0,
            ...counts,
            verified_fail_count: failRow?.cnt || 0,
            last_sync: store.last_updated_at
        });
    }
    const total_alerts = summaries.reduce((sum, s) =>
        sum + (s.quarantine_count || 0) + (s.price_rejected_count || 0) + (s.promo_below_cost_count || 0), 0);
    return { stores: summaries, total_alerts };
}

async function rotateOldData() {
    // price_snapshots rotation is now handled in createSnapshot() (max 10 per category)

    // Delete price_updates_pending with status != 'PENDING' older than 30 days
    await dbRun(db, `
        DELETE FROM price_updates_pending
        WHERE status != 'PENDING'
          AND sent_at < datetime('now', '-30 days')
    `);

    // Delete price_history older than 365 days
    await dbRun(db, `
        DELETE FROM price_history
        WHERE created_at < datetime('now', '-365 days')
    `);

    // Delete sync_log_entries older than 90 days
    await dbRun(db, `
        DELETE FROM sync_log_entries
        WHERE timestamp < datetime('now', '-90 days')
    `);

    // Delete api_logs older than 30 days
    await dbRun(db, `
        DELETE FROM api_logs
        WHERE timestamp < datetime('now', '-30 days')
    `);

    // Delete repricer_log older than 90 days
    await dbRun(db, `
        DELETE FROM repricer_log
        WHERE timestamp < datetime('now', '-90 days')
    `);
}

module.exports = {
    getDashboardSummary, rotateOldData,
};
