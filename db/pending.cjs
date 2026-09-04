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

function getPendingUpdates(storeId, status) {
    if (status) {
        return dbAll(db, `SELECT * FROM price_updates_pending WHERE store_id = ? AND status = ? ORDER BY id DESC`, [storeId, status]);
    }
    return dbAll(db, `SELECT * FROM price_updates_pending WHERE store_id = ? ORDER BY id DESC`, [storeId]);
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
    createPendingUpdate, getPendingUpdates, updatePendingStatus, getPendingToVerify,
    expireOldPending,
};
