// Wrappers around better-sqlite3's synchronous API.
// Return Promises so all callers (db/*.cjs) work without changes.

function dbRun(db, sql, params = []) {
    try {
        const result = db.prepare(sql).run(...params);
        return Promise.resolve({ lastID: result.lastInsertRowid, changes: result.changes });
    } catch (err) {
        return Promise.reject(err);
    }
}

function dbGet(db, sql, params = []) {
    try {
        return Promise.resolve(db.prepare(sql).get(...params));
    } catch (err) {
        return Promise.reject(err);
    }
}

function dbAll(db, sql, params = []) {
    try {
        return Promise.resolve(db.prepare(sql).all(...params));
    } catch (err) {
        return Promise.reject(err);
    }
}

module.exports = { dbRun, dbGet, dbAll };
