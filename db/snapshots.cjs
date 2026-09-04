const { db, dbRun, dbGet, dbAll } = require('./connection.cjs');

async function createSnapshot(storeId, source, itemsCount, snapshotJson, category = 'manual', comment = null) {
    // Rotate: keep max 10 per category per store
    const countRow = await dbGet(db, 'SELECT COUNT(*) as cnt FROM price_snapshots WHERE store_id = ? AND category = ?', [storeId, category]);
    if (countRow && countRow.cnt >= 10) {
        await dbRun(db, 'DELETE FROM price_snapshots WHERE id = (SELECT id FROM price_snapshots WHERE store_id = ? AND category = ? ORDER BY created_at ASC LIMIT 1)', [storeId, category]);
    }
    const { lastID } = await dbRun(db,
        `INSERT INTO price_snapshots (store_id, source, items_count, snapshot_json, category, comment) VALUES (?, ?, ?, ?, ?, ?)`,
        [storeId, source, itemsCount, snapshotJson, category, comment]
    );
    return lastID;
}

function getStoreSnapshots(storeId, category = null) {
    if (category) {
        return dbAll(db,
            `SELECT id, store_id, created_at, source, items_count, category, comment FROM price_snapshots WHERE store_id = ? AND category = ? ORDER BY created_at DESC LIMIT 10`,
            [storeId, category]
        );
    }
    return dbAll(db,
        `SELECT id, store_id, created_at, source, items_count, category, comment FROM price_snapshots WHERE store_id = ? ORDER BY created_at DESC LIMIT 20`,
        [storeId]
    );
}

function getSnapshotById(id) {
    return dbGet(db, `SELECT * FROM price_snapshots WHERE id = ?`, [id]);
}

module.exports = {
    createSnapshot, getStoreSnapshots, getSnapshotById,
};
