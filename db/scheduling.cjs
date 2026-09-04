const { db, dbRun, dbAll } = require('./connection.cjs');

async function createScheduledUpdate(storeId, scheduledAt, source, updatesJson) {
    const { lastID } = await dbRun(db,
        `INSERT INTO scheduled_updates (store_id, scheduled_at, source, updates_json) VALUES (?, ?, ?, ?)`,
        [storeId, scheduledAt, source, updatesJson]
    );
    return lastID;
}

function getDueScheduledUpdates() {
    return dbAll(db,
        `SELECT * FROM scheduled_updates WHERE status = 'SCHEDULED' AND scheduled_at <= datetime('now')`
    );
}

function updateScheduledStatus(id, status, resultJson) {
    return dbRun(db,
        `UPDATE scheduled_updates SET status = ?, executed_at = CURRENT_TIMESTAMP, result_json = ? WHERE id = ?`,
        [status, resultJson || null, id]
    );
}

function getStoreScheduledUpdates(storeId) {
    return dbAll(db,
        `SELECT * FROM scheduled_updates WHERE store_id = ? AND status = 'SCHEDULED' ORDER BY scheduled_at`,
        [storeId]
    );
}

function deleteScheduledUpdate(id) {
    return dbRun(db, `DELETE FROM scheduled_updates WHERE id = ?`, [id]);
}

module.exports = {
    createScheduledUpdate, getDueScheduledUpdates, updateScheduledStatus,
    getStoreScheduledUpdates, deleteScheduledUpdate,
};
