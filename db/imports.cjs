const { db, dbRun, dbGet, dbAll } = require('./connection.cjs');

async function createPriceImport(storeId, filename, filePath) {
    const { lastID } = await dbRun(db, `INSERT INTO price_imports (store_id, filename, file_path, status) VALUES (?, ?, ?, 'PENDING')`,
        [storeId, filename, filePath]);
    return lastID;
}

function updatePriceImport(id, status, resultJson) {
    return dbRun(db, `UPDATE price_imports SET status = ?, result_json = ? WHERE id = ?`, [status, resultJson, id]);
}

function getPriceImportById(id) {
    return dbGet(db, "SELECT * FROM price_imports WHERE id = ?", [id]);
}

function getRecentPriceImports(storeId, limit = 3) {
    return dbAll(db, "SELECT * FROM price_imports WHERE store_id = ? ORDER BY id DESC LIMIT ?", [storeId, limit]);
}

function getOldPriceImports(storeId, keepCount = 3) {
    return dbAll(db, "SELECT * FROM price_imports WHERE store_id = ? ORDER BY id DESC LIMIT -1 OFFSET ?", [storeId, keepCount]);
}

function deletePriceImport(id) {
    return dbRun(db, "DELETE FROM price_imports WHERE id = ?", [id]);
}

module.exports = {
    createPriceImport, updatePriceImport, getPriceImportById,
    getRecentPriceImports, getOldPriceImports, deletePriceImport,
};
