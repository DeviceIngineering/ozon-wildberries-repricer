const { db, dbRun, dbGet, dbAll } = require('./connection.cjs');

async function createLog(storeId) {
    const { lastID } = await dbRun(db, `INSERT INTO sync_logs (store_id, status) VALUES (?, 'RUNNING')`, [storeId]);
    return lastID;
}

function updateLog(logId, { status, items_processed, items_changed, log_text, completed }) {
    let sql = `UPDATE sync_logs SET status = ?`;
    let params = [status];

    if (items_processed !== undefined) { sql += `, items_processed = ?`; params.push(items_processed); }
    if (items_changed !== undefined) { sql += `, items_changed = ?`; params.push(items_changed); }
    if (log_text !== undefined) { sql += `, log_text = ?`; params.push(log_text); }
    if (completed) { sql += `, completed_at = CURRENT_TIMESTAMP`; }

    sql += ` WHERE id = ?`;
    params.push(logId);
    return dbRun(db, sql, params);
}

function getStoreLogs(storeId) {
    return dbAll(db, "SELECT * FROM sync_logs WHERE store_id = ? ORDER BY id DESC LIMIT 50", [storeId]);
}

function addLogEntry(logId, level, stage, message) {
    return dbRun(db, `INSERT INTO sync_log_entries (log_id, level, stage, message) VALUES (?, ?, ?, ?)`,
        [logId, level, stage, message]);
}

function getLogDetails(logId) {
    return dbAll(db, "SELECT * FROM sync_log_entries WHERE log_id = ? ORDER BY id ASC", [logId]);
}

function getLastPrice(productId) {
    return dbGet(db, "SELECT * FROM price_history WHERE product_id = ? ORDER BY id DESC LIMIT 1", [productId]);
}

function getProductPriceHistory(ozonProductId) {
    const sql = `
        SELECT ph.id, ph.price, ph.marketing_price, ph.min_price, ph.created_at as checked_at
        FROM price_history ph
        JOIN products p ON ph.product_id = p.id
        WHERE p.ozon_id = ?
        ORDER BY ph.id DESC
        LIMIT 50
    `;
    return dbAll(db, sql, [ozonProductId]);
}

function insertApiLog(storeId, data) {
    return dbRun(db,
        `INSERT INTO api_logs (store_id, endpoint, method, status_code, duration_ms, items_count, request_summary, response_summary, error_message, source, retry_attempt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [storeId, data.endpoint, data.method || 'POST', data.statusCode, data.durationMs, data.itemsCount, data.requestSummary, data.responseSummary, data.errorMessage, data.source, data.retryAttempt || 0]
    );
}

async function getApiLogs(storeId, { source, status, period, page = 1, limit = 50 } = {}) {
    let where = 'WHERE store_id = ?';
    const params = [storeId];

    if (source) { where += ' AND source = ?'; params.push(source); }
    if (status === 'ok') { where += ' AND status_code >= 200 AND status_code < 300'; }
    else if (status === 'error') { where += ' AND (status_code >= 400 OR status_code IS NULL)'; }
    if (period === 'today') { where += " AND timestamp >= datetime('now', '-1 day')"; }
    else if (period === 'week') { where += " AND timestamp >= datetime('now', '-7 days')"; }
    else if (period === 'month') { where += " AND timestamp >= datetime('now', '-30 days')"; }

    const countRow = await dbGet(db, `SELECT COUNT(*) as count FROM api_logs ${where}`, params);
    const total = countRow.count;
    const offset = (page - 1) * limit;
    const rows = await dbAll(db, `SELECT * FROM api_logs ${where} ORDER BY timestamp DESC LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { rows, total, page, totalPages: Math.ceil(total / limit) };
}

function insertRepricerLog(storeId, runId, entry) {
    return dbRun(db,
        `INSERT INTO repricer_log (store_id, run_id, offer_id, product_name, old_price, new_price, ref_price, deviation_percent, action, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [storeId, runId, entry.offerId, entry.productName, entry.oldPrice, entry.newPrice, entry.refPrice, entry.deviationPercent, entry.action, entry.reason]
    );
}

async function getRepricerLogs(storeId, { action, period, page = 1, limit = 100, search, sort, order } = {}) {
    let where = 'WHERE store_id = ?';
    const params = [storeId];

    if (action === 'corrected') { where += " AND action = 'corrected'"; }
    else if (action === 'skipped') { where += " AND action LIKE 'skipped_%'"; }
    else if (action === 'minor_drop') { where += " AND action = 'minor_drop'"; }
    else if (action === 'ok') { where += " AND action = 'ok'"; }
    if (period === 'today') { where += " AND timestamp >= datetime('now', '-1 day')"; }
    else if (period === 'week') { where += " AND timestamp >= datetime('now', '-7 days')"; }
    else if (period === 'month') { where += " AND timestamp >= datetime('now', '-30 days')"; }

    if (search) {
        where += " AND (offer_id LIKE ? OR product_name LIKE ?)";
        params.push(`%${search}%`, `%${search}%`);
    }

    const allowedSort = ['timestamp', 'offer_id', 'old_price', 'new_price', 'deviation_percent'];
    const sortCol = allowedSort.includes(sort) ? sort : 'timestamp';
    const sortDir = order === 'asc' ? 'ASC' : 'DESC';

    const countRow = await dbGet(db, `SELECT COUNT(*) as count FROM repricer_log ${where}`, params);
    const total = countRow.count;
    const offset = (page - 1) * limit;
    const rows = await dbAll(db, `SELECT * FROM repricer_log ${where} ORDER BY ${sortCol} ${sortDir} LIMIT ? OFFSET ?`, [...params, limit, offset]);
    return { rows, total, page, totalPages: Math.ceil(total / limit) };
}

module.exports = {
    createLog, updateLog, getStoreLogs, addLogEntry, getLogDetails,
    getLastPrice, getProductPriceHistory,
    insertApiLog, getApiLogs,
    insertRepricerLog, getRepricerLogs,
};
