const Database = require('better-sqlite3');
const path = require('path');
const crypto = require('crypto');
const { dbRun, dbGet, dbAll } = require('../lib/dbHelper.cjs');

function generateUUID() {
    return crypto.randomUUID();
}

const DB_PATH = process.env.DB_PATH || path.resolve(__dirname, '..', 'ozon.db');

const db = new Database(DB_PATH);
// WAL mode: crash-safe, supports one writer + concurrent readers
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

console.log('Connected to the SQLite database.');
initSchema();
runMigrations();

function execSafe(sql, skipMsg) {
    try {
        db.exec(sql);
    } catch (err) {
        if (!skipMsg || !err.message.includes(skipMsg)) {
            console.error('DB exec error:', err.message);
        }
    }
}

function alterSafe(sql, colName) {
    try {
        db.prepare(sql).run();
    } catch (err) {
        if (!err.message.includes('duplicate column name')) {
            console.error(`Migration error (${colName}):`, err.message);
        }
    }
}

function initSchema() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS stores (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            client_id TEXT NOT NULL,
            api_key TEXT NOT NULL,
            update_interval_minutes INTEGER DEFAULT 60,
            last_updated_at DATETIME,
            antiban_enabled INTEGER DEFAULT 0,
            repricer_enabled INTEGER DEFAULT 0,
            repricer_interval_min INTEGER DEFAULT 15,
            threshold_drop_percent REAL DEFAULT 5.0,
            threshold_rise_percent REAL DEFAULT 5.0
        );
        CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store_id TEXT NOT NULL,
            ozon_id INTEGER NOT NULL,
            offer_id TEXT,
            name TEXT,
            data_json TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (store_id) REFERENCES stores (id),
            UNIQUE(store_id, ozon_id)
        );
        CREATE TABLE IF NOT EXISTS price_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            product_id INTEGER NOT NULL,
            price REAL,
            marketing_price REAL,
            min_price REAL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (product_id) REFERENCES products (id)
        );
        CREATE TABLE IF NOT EXISTS sync_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store_id TEXT NOT NULL,
            started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            status TEXT,
            items_processed INTEGER DEFAULT 0,
            items_changed INTEGER DEFAULT 0,
            log_text TEXT,
            FOREIGN KEY (store_id) REFERENCES stores (id)
        );
        CREATE TABLE IF NOT EXISTS price_imports (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store_id TEXT NOT NULL,
            filename TEXT,
            file_path TEXT,
            uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            status TEXT,
            result_json TEXT,
            FOREIGN KEY (store_id) REFERENCES stores (id)
        );
        CREATE TABLE IF NOT EXISTS sync_log_entries (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            log_id INTEGER NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            level TEXT,
            stage TEXT,
            message TEXT,
            FOREIGN KEY (log_id) REFERENCES sync_logs (id)
        );
        CREATE TABLE IF NOT EXISTS price_updates_pending (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store_id TEXT NOT NULL,
            product_id INTEGER NOT NULL,
            offer_id TEXT NOT NULL,
            sent_price REAL NOT NULL,
            sent_min_price REAL,
            sent_old_price REAL,
            sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            verify_after DATETIME,
            status TEXT DEFAULT 'PENDING',
            actual_price REAL,
            fail_reason TEXT,
            FOREIGN KEY (store_id) REFERENCES stores(id),
            FOREIGN KEY (product_id) REFERENCES products(id)
        );
        CREATE TABLE IF NOT EXISTS price_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store_id TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            source TEXT,
            items_count INTEGER,
            snapshot_json TEXT,
            FOREIGN KEY (store_id) REFERENCES stores(id)
        );
        CREATE TABLE IF NOT EXISTS scheduled_updates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store_id TEXT NOT NULL,
            scheduled_at DATETIME NOT NULL,
            source TEXT,
            updates_json TEXT,
            status TEXT DEFAULT 'SCHEDULED',
            executed_at DATETIME,
            result_json TEXT,
            FOREIGN KEY (store_id) REFERENCES stores(id)
        );
        CREATE TABLE IF NOT EXISTS api_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store_id TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            endpoint TEXT NOT NULL,
            method TEXT DEFAULT 'POST',
            status_code INTEGER,
            duration_ms INTEGER,
            items_count INTEGER,
            request_summary TEXT,
            response_summary TEXT,
            error_message TEXT,
            source TEXT NOT NULL,
            retry_attempt INTEGER DEFAULT 0,
            FOREIGN KEY (store_id) REFERENCES stores(id)
        );
        CREATE TABLE IF NOT EXISTS repricer_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store_id TEXT NOT NULL,
            run_id INTEGER,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            offer_id TEXT NOT NULL,
            product_name TEXT,
            old_price REAL NOT NULL,
            new_price REAL NOT NULL,
            ref_price REAL,
            deviation_percent REAL,
            action TEXT NOT NULL,
            reason TEXT,
            FOREIGN KEY (store_id) REFERENCES stores(id)
        );
        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS external_api_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            ip TEXT,
            method TEXT,
            path TEXT,
            status_code INTEGER,
            store_id TEXT,
            action TEXT,
            summary TEXT,
            affected_count INTEGER DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS sales_daily (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store_id TEXT NOT NULL,
            product_id INTEGER,
            offer_id TEXT,
            marketplace TEXT,
            date DATE NOT NULL,
            units INTEGER DEFAULT 0,
            revenue REAL DEFAULT 0,
            profit REAL,
            price_seller REAL,
            price_buyer_est REAL,
            cost_unit REAL,
            commission_pct REAL,
            floor REAL,
            ceiling REAL,
            promo_flag INTEGER DEFAULT 0,
            promo_price REAL,
            ad_spend REAL,
            boost_pct REAL,
            stock_qty INTEGER,
            in_stock_flag INTEGER DEFAULT 1,
            spp_pct REAL,
            comp_price REAL,
            experiment_id INTEGER,
            step_idx INTEGER,
            is_dirty_flag INTEGER DEFAULT 0,
            liquidation_flag INTEGER DEFAULT 0,
            posterior_lambda_mean REAL,
            posterior_lambda_p25 REAL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (store_id) REFERENCES stores(id),
            UNIQUE(store_id, offer_id, date)
        );
        CREATE TABLE IF NOT EXISTS experiments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store_id TEXT NOT NULL,
            product_id INTEGER,
            offer_id TEXT NOT NULL,
            strategy_type TEXT NOT NULL,
            status TEXT DEFAULT 'active',
            analysis_window_days INTEGER DEFAULT 14,
            current_price REAL,
            step_percent REAL DEFAULT 8,
            direction INTEGER DEFAULT 0,
            best_price REAL,
            best_metric REAL,
            bad_steps INTEGER DEFAULT 0,
            step_started_at DATETIME,
            sales_since_step INTEGER DEFAULT 0,
            auto_apply INTEGER DEFAULT 0,
            last_decision_json TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (store_id) REFERENCES stores(id),
            UNIQUE(store_id, offer_id)
        );
        CREATE TABLE IF NOT EXISTS strategy_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store_id TEXT NOT NULL,
            experiment_id INTEGER,
            offer_id TEXT NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
            strategy_type TEXT,
            action TEXT,
            old_price REAL,
            new_price REAL,
            metric_name TEXT,
            metric_value REAL,
            reason TEXT,
            applied INTEGER DEFAULT 0,
            FOREIGN KEY (store_id) REFERENCES stores(id)
        );
        CREATE INDEX IF NOT EXISTS idx_sales_daily_lookup ON sales_daily(store_id, offer_id, date);
        CREATE INDEX IF NOT EXISTS idx_sales_daily_date ON sales_daily(store_id, date);
        CREATE INDEX IF NOT EXISTS idx_experiments_store ON experiments(store_id, status);
        CREATE INDEX IF NOT EXISTS idx_strategy_log_store ON strategy_log(store_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_price_pending_status ON price_updates_pending(status, verify_after);
        CREATE INDEX IF NOT EXISTS idx_scheduled_status ON scheduled_updates(status, scheduled_at);
        CREATE INDEX IF NOT EXISTS idx_products_offer_id ON products(offer_id);
        CREATE INDEX IF NOT EXISTS idx_snapshots_store ON price_snapshots(store_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_price_history_product ON price_history(product_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_api_logs_store ON api_logs(store_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_api_logs_status ON api_logs(status_code);
        CREATE INDEX IF NOT EXISTS idx_repricer_log_store ON repricer_log(store_id, timestamp);
        CREATE INDEX IF NOT EXISTS idx_repricer_log_run ON repricer_log(run_id);
        CREATE INDEX IF NOT EXISTS idx_external_api_log_ts ON external_api_log(timestamp);
    `);
    console.log('Database schema initialized.');
}

function migrateStoresToUUID() {
    try {
        const columns = db.pragma('table_info(stores)');
        const colNames = columns.map(c => c.name);
        const colDefs = columns.map(c => {
            if (c.name === 'id') return 'id TEXT PRIMARY KEY';
            let def = `${c.name} ${c.type}`;
            if (c.notnull) def += ' NOT NULL';
            if (c.dflt_value !== null) def += ` DEFAULT ${c.dflt_value}`;
            return def;
        });

        const stores = db.prepare("SELECT * FROM stores").all();
        const idMap = {};
        for (const s of stores) idMap[s.id] = generateUUID();

        // foreign_keys pragma must be set outside the transaction
        db.pragma('foreign_keys = OFF');
        db.transaction(() => {
            db.prepare('ALTER TABLE stores RENAME TO stores_old').run();
            db.exec(`CREATE TABLE stores (${colDefs.join(', ')})`);

            const colList = colNames.join(', ');
            const placeholders = colNames.map(() => '?').join(', ');
            const insertStmt = db.prepare(`INSERT INTO stores (${colList}) VALUES (${placeholders})`);
            for (const s of stores) {
                const values = colNames.map(c => c === 'id' ? idMap[s.id] : s[c]);
                insertStmt.run(...values);
            }

            const childTables = ['products', 'sync_logs', 'price_imports', 'price_updates_pending',
                'price_snapshots', 'scheduled_updates', 'api_logs', 'repricer_log'];
            for (const table of childTables) {
                const updateStmt = db.prepare(`UPDATE ${table} SET store_id = ? WHERE store_id = ?`);
                for (const [oldId, newId] of Object.entries(idMap)) {
                    updateStmt.run(newId, String(oldId));
                }
            }

            db.prepare('DROP TABLE stores_old').run();
        })();
        db.pragma('foreign_keys = ON');

        console.log(`[Migration] Successfully migrated ${stores.length} store(s) to UUID IDs.`);
        for (const [oldId, newId] of Object.entries(idMap)) {
            console.log(`  Store ${oldId} -> ${newId}`);
        }
    } catch (err) {
        console.error('[Migration] UUID migration failed:', err.message);
        try { db.pragma('foreign_keys = ON'); } catch {}
    }
}

function runMigrations() {
    // Fix broken FK references left after UUID migration (SQLite auto-renames FKs on ALTER TABLE RENAME)
    const brokenTables = db.prepare(
        "SELECT name, sql FROM sqlite_master WHERE type='table' AND sql LIKE '%stores_old%'"
    ).all();
    if (brokenTables.length > 0) {
        console.log(`[Migration] Fixing ${brokenTables.length} broken FK references (stores_old → stores)...`);
        db.pragma('foreign_keys = OFF');
        db.transaction(() => {
            for (const { name, sql } of brokenTables) {
                const fixedSql = sql
                    .replace(/"stores_old"\s*\(id\)/g, '"stores"(id)')
                    .replace(/\bstores_old\b/g, 'stores');
                const tempName = `_fix_${name}`;
                // Create fixed table under temp name
                const tempSql = fixedSql.replace(
                    /CREATE TABLE\s+["']?[\w]+["']?\s*\(/i,
                    `CREATE TABLE "${tempName}" (`
                );
                db.exec(tempSql);
                // Copy all data
                const cols = db.pragma(`table_info(${name})`).map(c => `"${c.name}"`).join(', ');
                db.exec(`INSERT INTO "${tempName}" SELECT ${cols} FROM "${name}"`);
                db.exec(`DROP TABLE "${name}"`);
                db.exec(`ALTER TABLE "${tempName}" RENAME TO "${name}"`);
                console.log(`  Recreated: ${name}`);
            }
        })();
        db.pragma('foreign_keys = ON');
        console.log('[Migration] FK references fixed.');
    }

    const storeColumns = [
        { name: 'repricer_enabled', type: 'INTEGER DEFAULT 0' },
        { name: 'repricer_interval_min', type: 'INTEGER DEFAULT 15' },
        { name: 'threshold_drop_percent', type: 'REAL DEFAULT 5.0' },
        { name: 'threshold_rise_percent', type: 'REAL DEFAULT 5.0' },
        { name: 'last_repricer_run', type: 'DATETIME' },
        { name: 'monitor_interval_min', type: 'INTEGER DEFAULT 30' },
        { name: 'last_monitor_run', type: 'DATETIME' },
        { name: 'tax_rate', type: 'REAL DEFAULT 0' },
        { name: 'min_margin_percent', type: 'REAL DEFAULT 0' },
        { name: 'promo_guard_enabled', type: 'INTEGER DEFAULT 0' },
        { name: 'promo_exit_enabled', type: 'INTEGER DEFAULT 0' },
        { name: 'last_promo_exit_run', type: 'DATETIME' },
        // Выборочное разрешение акций: JSON-массив action_id, из которых НЕ выводим (пусто = выводим из всех)
        { name: 'promo_allowed_actions', type: "TEXT DEFAULT '[]'" },
        // Глобальный порог скидки для разрешённых акций: товар с большей скидкой выводится
        { name: 'promo_max_discount_percent', type: 'REAL DEFAULT 5' },
        { name: 'platform', type: "TEXT DEFAULT 'ozon'" },
        { name: 'ym_business_id', type: 'TEXT' },
        { name: 'ym_campaign_id', type: 'TEXT' },
        { name: 'ym_api_key', type: 'TEXT' },
        // YM floor: потолок буст-буфера (%), шаг роста цены за прогон (%), авто-вывод из акций
        { name: 'ym_boost_cap_percent', type: 'REAL DEFAULT 30' },
        { name: 'ym_floor_max_raise_percent', type: 'REAL DEFAULT 20' },
        { name: 'ym_promo_exit_enabled', type: 'INTEGER DEFAULT 0' },
        // Wildberries: единый персональный токен (scope «Цены и скидки», «Контент», «Аналитика», «Продвижение»)
        { name: 'wb_api_key', type: 'TEXT' },
        // Ценовые стратегии (см. docs/STRATEGIES.md)
        // kill-switch магазина: 1 = все эксперименты магазина остановлены, откат к ref_price
        { name: 'strategy_kill_switch', type: 'INTEGER DEFAULT 0' },
        // Глобальный kill-switch — отдельная строка-флаг хранится в этом же поле магазина с спец-именем не нужна;
        // глобальный флаг держим в app_settings (см. ниже).
    ];
    for (const col of storeColumns) {
        alterSafe(`ALTER TABLE stores ADD COLUMN ${col.name} ${col.type}`, col.name);
    }

    const productColumns = [
        { name: 'ref_price', type: 'REAL' },
        { name: 'ref_min_price', type: 'REAL' },
        { name: 'cost_price', type: 'REAL' },
        { name: 'visibility', type: "TEXT DEFAULT 'VISIBLE'" },
        { name: 'is_quarantine', type: 'INTEGER DEFAULT 0' },
        { name: 'price_apply_status', type: "TEXT DEFAULT 'APPLIED'" },
        { name: 'price_apply_error', type: 'TEXT' },
        { name: 'in_promo', type: 'INTEGER DEFAULT 0' },
        { name: 'promo_price', type: 'REAL' },
        { name: 'last_status_check', type: 'DATETIME' },
        { name: 'is_archived', type: 'INTEGER DEFAULT 0' },
        { name: 'floor_min_price', type: 'REAL' },
        { name: 'promo_action_id', type: 'INTEGER' },
        { name: 'has_price', type: 'INTEGER DEFAULT 1' },
        { name: 'has_stock', type: 'INTEGER DEFAULT 1' },
        { name: 'ozon_status', type: 'TEXT' },
        { name: 'moderate_status', type: 'TEXT' },
        { name: 'ozon_is_created', type: 'INTEGER DEFAULT 1' },
        { name: 'stocks_fbo', type: 'INTEGER DEFAULT 0' },
        { name: 'stocks_fbs', type: 'INTEGER DEFAULT 0' },
        { name: 'stocks_updated_at', type: 'DATETIME' },
        // Кэш флага самозапрета автодобавления в акции (источник истины — /v5/product/info/prices)
        { name: 'auto_add_blocked', type: 'INTEGER DEFAULT 0' },
        // Wildberries: ozon_id хранит nmID, offer_id — vendorCode.
        // subjectID нужен для комиссии категории, объём (л) — для расчёта логистики короба.
        { name: 'wb_subject_id', type: 'INTEGER' },
        { name: 'wb_volume_liters', type: 'REAL' },
        // Текущее состояние пары цены WB: базовая (зачёркнутая) цена и скидка продавца, %
        { name: 'wb_price_base', type: 'REAL' },
        { name: 'wb_discount', type: 'INTEGER' },
        // Ценовые стратегии (см. docs/STRATEGIES.md). По умолчанию ref_price = текущий режим (держим РРЦ).
        { name: 'strategy_type', type: "TEXT DEFAULT 'ref_price'" },
        { name: 'strategy_price_min', type: 'REAL' },   // нижняя граница коридора (если задана; иначе floor)
        { name: 'strategy_price_max', type: 'REAL' },   // верхняя граница коридора (если задана; иначе РРЦ/выше)
        { name: 'strategy_target_margin', type: 'REAL' }, // для max_units: целевая маржа, %
        { name: 'strategy_window_days', type: 'INTEGER DEFAULT 14' }, // окно анализа: 14/30/60
        { name: 'in_experiment', type: 'INTEGER DEFAULT 0' }, // в пилоте эксперимента
        { name: 'liquidation_max_loss_pct', type: 'REAL' }, // для liquidation: допустимый минус ниже себестоимости, %
        { name: 'liquidation_active', type: 'INTEGER DEFAULT 0' }, // флаг активного слива
        // Governance (см. docs/API_EXTERNAL.md, раздел «Одно поле знаний»):
        // режим управления SKU и владелец. Цену пишет только владелец режима.
        // ref_price — обычный режим (репрайсер держит эталон, внешние агенты могут менять с валидацией);
        // experiment | liquidation — цена под контролем владельца (managed_by), чужая запись отклоняется;
        // disposal — товар в утилизации, ЛЮБАЯ запись цены отклоняется.
        { name: 'management_mode', type: "TEXT DEFAULT 'ref_price'" },
        { name: 'managed_by', type: 'TEXT' },
        { name: 'freeze_reason', type: 'TEXT' },
    ];
    for (const col of productColumns) {
        alterSafe(`ALTER TABLE products ADD COLUMN ${col.name} ${col.type}`, col.name);
    }

    alterSafe("ALTER TABLE price_snapshots ADD COLUMN category TEXT DEFAULT 'manual'", 'category');
    alterSafe("ALTER TABLE price_snapshots ADD COLUMN comment TEXT", 'comment');

    // Журнал решений и намерений агентов (governance, «одно поле знаний»).
    // kind: decision (принятое решение), intent (объявленное намерение), policy (правило расчёта/поведения).
    // Кто из агентов ознакомился с каким context_version (команда пользователя «ознакомься»).
    execSafe(`CREATE TABLE IF NOT EXISTS agent_acks (
        agent TEXT PRIMARY KEY,
        context_version INTEGER NOT NULL,
        acked_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    execSafe(`CREATE TABLE IF NOT EXISTS agent_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        author TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'decision',
        title TEXT NOT NULL,
        body TEXT,
        store_id TEXT,
        skus_json TEXT,
        active_until DATETIME,
        status TEXT DEFAULT 'active'
    )`);

    // Convert stores.id from INTEGER to UUID (one-time migration)
    const row = db.prepare("SELECT typeof(id) as t FROM stores LIMIT 1").get();
    if (row && row.t === 'integer') {
        console.log('[Migration] Converting store IDs from INTEGER to UUID...');
        migrateStoresToUUID();
    }

    execSafe('CREATE INDEX IF NOT EXISTS idx_products_store_visibility ON products(store_id, visibility)');
    execSafe('CREATE INDEX IF NOT EXISTS idx_products_store_quarantine ON products(store_id, is_quarantine)');
    execSafe('CREATE INDEX IF NOT EXISTS idx_products_store_promo ON products(store_id, in_promo)');
}

module.exports = { db, dbRun, dbGet, dbAll, generateUUID };
