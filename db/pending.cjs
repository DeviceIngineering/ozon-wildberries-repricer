const { db, dbRun, dbAll } = require('./connection.cjs');

async function createPendingUpdate(data) {
    const sql = `INSERT INTO price_updates_pending
        (store_id, product_id, offer_id, sent_price, sent_min_price, sent_old_price, verify_after, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING')`;
    const { lastID } = await dbRun(db, sql, [
        data.store_id, data.product_id, data.offer_id,
        data.sent_price, data.sent_min_price || null, data.sent_old_price || null,
        data.verify_after || null
    ]);
    return lastID;
}

/**
 * @param {string} storeId
 * @param {string} [status] Filter by status
 * @param {{limit?: number, since?: string}} [opts] limit defaults to unlimited for
 *   internal callers; the external API always passes one, because this table
 *   accumulates historically and a bulk send of 1 000 SKU otherwise returns
 *   every row of it.
 */
function getPendingUpdates(storeId, status, opts = {}) {
    const where = ['store_id = ?'];
    const params = [storeId];
    if (status) { where.push('status = ?'); params.push(status); }
    if (opts.since) { where.push('sent_at >= ?'); params.push(opts.since); }
    let sql = `SELECT * FROM price_updates_pending WHERE ${where.join(' AND ')} ORDER BY id DESC`;
    if (opts.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }
    return dbAll(db, sql, params);
}

/** Counts per status plus the failures themselves — what a caller checking on a
 *  bulk send actually needs, instead of every row it sent. */
async function getPendingSummary(storeId, opts = {}) {
    const params = [storeId];
    let sinceSql = '';
    if (opts.since) { sinceSql = ' AND sent_at >= ?'; params.push(opts.since); }

    const counts = await dbAll(db,
        `SELECT status, COUNT(*) n FROM price_updates_pending
         WHERE store_id = ?${sinceSql} GROUP BY status`, params);

    const failures = await dbAll(db,
        `SELECT offer_id, sent_price, actual_price, fail_reason
         FROM price_updates_pending
         WHERE store_id = ?${sinceSql} AND status = 'VERIFIED_FAIL'
         ORDER BY id DESC LIMIT ?`, [...params, opts.failuresLimit || 50]);

    const byStatus = {};
    for (const r of counts) byStatus[r.status] = r.n;
    return { by_status: byStatus, failures };
}

function updatePendingStatus(id, status, actualPrice, failReason) {
    return dbRun(db,
        `UPDATE price_updates_pending SET status = ?, actual_price = ?, fail_reason = ? WHERE id = ?`,
        [status, actualPrice || null, failReason || null, id]
    );
}

function getPendingToVerify() {
    return dbAll(db,
        `SELECT * FROM price_updates_pending WHERE status = 'PENDING' AND verify_after <= datetime('now')`
    );
}

function expireOldPending(daysOld = 3) {
    return dbRun(db,
        "UPDATE price_updates_pending SET status = 'EXPIRED', fail_reason = 'Auto-expired after ' || ? || ' days' WHERE status = 'PENDING' AND sent_at < datetime('now', '-' || ? || ' days')",
        [daysOld, daysOld]
    );
}

module.exports = {
    createPendingUpdate, getPendingUpdates, getPendingSummary, updatePendingStatus, getPendingToVerify,
    expireOldPending,
};
