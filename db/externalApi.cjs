const { db, dbRun, dbAll } = require('./connection.cjs');
const { getAppSetting, setAppSetting } = require('./strategies.cjs');

// Внешний API включён по умолчанию (если ключ задан в env). Выключатель — app_settings.
const ENABLED_KEY = 'external_api_enabled';

function isExternalApiEnabled() {
    return getAppSetting(ENABLED_KEY, '1') === '1';
}

function setExternalApiEnabled(on) {
    setAppSetting(ENABLED_KEY, on ? '1' : '0');
    return isExternalApiEnabled();
}

/**
 * Запись строки аудита внешнего API. Не бросает — сбой лога не должен ронять запрос.
 */
function logExternalCall({ ip, method, path, status_code, store_id = null, action = null, summary = null, affected_count = 0 }) {
    try {
        return dbRun(db,
            `INSERT INTO external_api_log (ip, method, path, status_code, store_id, action, summary, affected_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [ip || null, method || null, path || null, status_code || null, store_id, action, summary, affected_count || 0]);
    } catch (e) {
        console.error('[external-api] audit log failed:', e.message);
        return Promise.resolve();
    }
}

function getExternalApiLog({ limit = 200 } = {}) {
    const lim = Math.min(1000, Math.max(1, parseInt(limit, 10) || 200));
    return dbAll(db,
        `SELECT id, timestamp, ip, method, path, status_code, store_id, action, summary, affected_count
         FROM external_api_log ORDER BY id DESC LIMIT ?`, [lim]);
}

module.exports = { isExternalApiEnabled, setExternalApiEnabled, logExternalCall, getExternalApiLog };
