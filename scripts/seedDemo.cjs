#!/usr/bin/env node
/**
 * Fills the database with a self-contained demo catalogue so the app can be
 * opened and judged without connecting a real marketplace account.
 *
 * Everything here is synthetic. The store credentials are obvious placeholders
 * and no network call is ever made with them: nothing in this script talks to
 * Ozon, Wildberries or Yandex.
 *
 * The catalogue is arranged to exercise the parts of the UI that matter — the
 * decision cockpit only has something to show when there is something wrong —
 * so it deliberately contains products below their floor, promotions priced
 * under cost, missing cost prices, quarantine and a running experiment.
 *
 *   npm run seed:demo             add demo data
 *   npm run seed:demo -- --reset  wipe the demo stores first
 *
 * Refuses to touch a database that already holds real stores.
 */

require('../lib/loadEnv.cjs').loadEnv();

const crypto = require('crypto');
const db = require('../db/connection.cjs').db;

const RESET = process.argv.includes('--reset');
const DEMO_MARK = 'demo:';           // stored in client_id, used to identify demo rows

// ── deterministic pseudo-random, so screenshots are reproducible ───────────
let seed = 20260904;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const between = (lo, hi) => lo + rnd() * (hi - lo);
const poisson = (lambda) => {
    // Knuth: enough for demo sales, and keeps the run dependency-free.
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= rnd(); } while (p > L);
    return k - 1;
};

const STORES = [
    { name: 'Demo Store · Ozon',        platform: 'ozon',   tax: 6,  margin: 20 },
    { name: 'Demo Store · Wildberries', platform: 'wildberries',  tax: 6,  margin: 20 },
    { name: 'Demo Store · Yandex',      platform: 'yandex', tax: 6,  margin: 15 },
];

const CATEGORIES = [
    ['Органайзер настольный',     ['белый', 'чёрный', 'бежевый', 'серый']],
    ['Подставка для наушников',   ['дуб', 'орех', 'чёрная', 'белая']],
    ['Держатель для телефона',    ['складной', 'магнитный', 'на стол', 'в авто']],
    ['Кабель-менеджер',           ['набор 6 шт', 'набор 12 шт', 'клипсы', 'лоток']],
    ['Подставка под ноутбук',     ['алюминий', 'регулируемая', 'складная', 'с охлаждением']],
    ['Ночник настольный',         ['тёплый свет', 'RGB', 'с таймером', 'сенсорный']],
];

/** Ozon floor: tax nested on net revenue. Mirrors lib/priceFloor.cjs. */
function floorFor(cost, commissionPct, logistics, acquiring, taxPct, marginPct) {
    const net = cost * (1 + marginPct / 100);
    const beforeTax = net / (1 - taxPct / 100);
    return Math.ceil((beforeTax + logistics + acquiring) / (1 - commissionPct / 100));
}

function wipeDemo() {
    const ids = db.prepare(`SELECT id FROM stores WHERE client_id LIKE ?`).all(`${DEMO_MARK}%`).map(r => r.id);
    if (!ids.length) return 0;
    const marks = ids.map(() => '?').join(',');
    for (const t of ['sales_daily', 'experiments', 'strategy_log', 'repricer_log',
                     'price_updates_pending', 'price_snapshots', 'scheduled_updates',
                     'api_logs', 'sync_logs', 'price_imports', 'products']) {
        try { db.prepare(`DELETE FROM ${t} WHERE store_id IN (${marks})`).run(...ids); } catch { /* table may not exist yet */ }
    }
    db.prepare(`DELETE FROM stores WHERE id IN (${marks})`).run(...ids);
    return ids.length;
}

function main() {
    const real = db.prepare(`SELECT COUNT(*) n FROM stores WHERE client_id NOT LIKE ?`).get(`${DEMO_MARK}%`).n;
    if (real > 0) {
        console.error(
            `Refusing to run: this database already has ${real} real store(s).\n` +
            `Demo data is for an empty install. Point DB_PATH at a scratch file instead:\n` +
            `  DB_PATH=./demo.db npm run seed:demo`
        );
        process.exit(1);
    }

    if (RESET) {
        const n = wipeDemo();
        console.log(n ? `Removed ${n} demo store(s).` : 'No demo data to remove.');
    }

    const existing = db.prepare(`SELECT COUNT(*) n FROM stores WHERE client_id LIKE ?`).get(`${DEMO_MARK}%`).n;
    if (existing > 0) {
        console.log(`Demo data already present (${existing} stores). Use --reset to rebuild.`);
        process.exit(0);
    }

    const insertStore = db.prepare(`
        INSERT INTO stores (id, name, client_id, api_key, platform, repricer_enabled,
                            repricer_interval_min, tax_rate, min_margin_percent,
                            promo_guard_enabled, promo_exit_enabled, last_updated_at)
        -- repricer_enabled = 0 on purpose: the credentials are fake, and an
        -- enabled store would have the scheduler firing real requests at Ozon,
        -- Wildberries and Yandex every few minutes. Turn it on in the UI if you
        -- want to watch a run fail against the placeholder keys.
        VALUES (?, ?, ?, ?, ?, 0, 15, ?, ?, 0, 0, datetime('now', '-12 minutes'))`);

    const insertProduct = db.prepare(`
        INSERT INTO products (store_id, ozon_id, offer_id, name, data_json,
                              ref_price, cost_price, floor_min_price, visibility, is_archived,
                              is_quarantine, in_promo, promo_price, stocks_fbo, stocks_fbs,
                              stocks_updated_at, has_price, has_stock, strategy_type,
                              management_mode, in_experiment, updated_at)
        VALUES (@store_id, @ozon_id, @offer_id, @name, @data_json,
                @ref_price, @cost_price, @floor_min_price, @visibility, @is_archived,
                @is_quarantine, @in_promo, @promo_price, @stocks_fbo, @stocks_fbs,
                datetime('now', '-20 minutes'), 1, @has_stock, @strategy_type,
                @management_mode, @in_experiment, datetime('now'))`);

    const insertSale = db.prepare(`
        INSERT OR IGNORE INTO sales_daily (store_id, product_id, offer_id, marketplace, date,
                                           units, revenue, profit, price_seller, price_buyer_est,
                                           cost_unit, commission_pct, floor, promo_flag,
                                           stock_qty, in_stock_flag, is_dirty_flag)
        VALUES (@store_id, @product_id, @offer_id, @marketplace, @date,
                @units, @revenue, @profit, @price_seller, @price_buyer_est,
                @cost_unit, @commission_pct, @floor, @promo_flag,
                @stock_qty, @in_stock_flag, @is_dirty_flag)`);

    const insertExperiment = db.prepare(`
        INSERT INTO experiments (store_id, product_id, offer_id, strategy_type, status,
                                 analysis_window_days, current_price, step_percent, direction,
                                 best_price, best_metric, bad_steps, step_started_at,
                                 sales_since_step, auto_apply, last_decision_json)
        VALUES (@store_id, @product_id, @offer_id, @strategy_type, 'active',
                30, @current_price, 8, -1, @best_price, @best_metric, 0,
                datetime('now', '-4 days'), @sales_since_step, @auto_apply, @last_decision_json)`);

    const insertStrategyLog = db.prepare(`
        INSERT INTO strategy_log (experiment_id, store_id, offer_id, strategy_type, action,
                                  old_price, new_price, metric_name, metric_value, reason,
                                  applied, timestamp)
        VALUES (@experiment_id, @store_id, @offer_id, 'max_profit', @action,
                @old_price, @new_price, @metric_name, @metric_value, @reason,
                @applied, datetime('now', @age))`);

    const insertRepricerLog = db.prepare(`
        INSERT INTO repricer_log (store_id, run_id, offer_id, product_name, old_price, new_price,
                                  ref_price, deviation_percent, action, reason, timestamp)
        VALUES (@store_id, @run_id, @offer_id, @product_name, @old_price, @new_price,
                @ref_price, @deviation_percent, @action, @reason, datetime('now', @age))`);

    const tx = db.transaction(() => {
        let totalProducts = 0, totalSales = 0;

        STORES.forEach((store, storeIdx) => {
            const storeId = crypto.randomUUID();
            insertStore.run(storeId, store.name, `${DEMO_MARK}${store.platform}`,
                            'demo-key-not-a-real-credential', store.platform, store.tax, store.margin);

            const perStore = 14;
            for (let i = 0; i < perStore; i++) {
                const [base, variants] = CATEGORIES[i % CATEGORIES.length];
                const name = `${base}, ${pick(variants)}`;
                // The same article number across all three stores, because that is
                // the real situation: one product listed on every marketplace.
                // It is what makes the master price and cross-store views mean
                // anything — they group by offer_id.
                const offerId = `DEMO-${String(i + 1).padStart(4, '0')}`;
                const ozonId = 900000000 + storeIdx * 1000 + i;

                const cost = Math.round(between(180, 900) / 10) * 10;
                const commission = Math.round(between(14, 24));
                const logistics = Math.round(between(35, 90));
                const acquiring = Math.round(between(10, 25));
                const floor = floorFor(cost, commission, logistics, acquiring, store.tax, store.margin);
                const ref = Math.round(floor * between(1.15, 1.6) / 10) * 10;

                // The catalogue needs problems, otherwise the cockpit is empty
                // and the screenshot shows nothing. Roughly a third are healthy.
                const flavour = i % 7;
                let price = ref, costPrice = cost, refPrice = ref;
                let inPromo = 0, promoPrice = null, quarantine = 0, visibility = 'VISIBLE';

                if (flavour === 1) {
                    price = Math.round(floor * between(0.86, 0.96));      // below floor
                } else if (flavour === 2) {
                    inPromo = 1;
                    promoPrice = Math.round(cost * between(0.85, 0.98));  // promo under cost
                    price = ref;
                } else if (flavour === 3) {
                    costPrice = null;                                     // cost unknown -> no floor
                } else if (flavour === 4) {
                    refPrice = Math.round(cost * between(0.8, 0.95));     // reference below cost
                    price = refPrice;
                } else if (flavour === 5 && store.platform === 'wildberries') {
                    quarantine = 1;
                    price = Math.round(ref * 0.6);
                } else {
                    price = Math.round(ref * between(0.99, 1.02));        // healthy
                }
                if (i === perStore - 1) visibility = 'ARCHIVED';

                const marketing = store.platform === 'ozon'
                    ? Math.round(price * between(0.93, 1.0))
                    : price;
                const minPrice = Math.round(price * 0.55);
                const oldPrice = Math.round(price * between(1.35, 1.8));
                const stocksFbo = Math.round(between(0, 120));
                const sales30 = Math.max(0, Math.round(between(0, 70)));

                const info = insertProduct.run({
                    store_id: storeId, ozon_id: ozonId, offer_id: offerId, name,
                    data_json: JSON.stringify({
                        // product_id is what the marketplace API returns and what the
                        // UI keys rows by; the whole API object is stored verbatim.
                        product_id: ozonId,
                        offer_id: offerId, name, price: String(price),
                        marketing_price: String(marketing), min_price: String(minPrice),
                        old_price: String(oldPrice), currency_code: 'RUB',
                        commission_percent: commission, logistics_amount: logistics,
                        acquiring_amount: acquiring,
                    }),
                    ref_price: refPrice,
                    cost_price: costPrice,
                    floor_min_price: costPrice ? floor : null,
                    visibility, is_quarantine: quarantine,
                    in_promo: inPromo, promo_price: promoPrice,
                    stocks_fbo: stocksFbo, stocks_fbs: Math.round(between(0, 30)),
                    is_archived: visibility === 'ARCHIVED' ? 1 : 0,
                    has_stock: stocksFbo > 0 ? 1 : 0,
                    strategy_type: 'ref_price', management_mode: 'ref_price', in_experiment: 0,
                });
                const productId = info.lastInsertRowid;
                totalProducts++;

                // 60 days of sales, demand falling with price
                const lambda = Math.max(0.15, 3.2 - price / 420);
                for (let d = 60; d >= 1; d--) {
                    const units = poisson(lambda);
                    if (!units && rnd() > 0.35) continue;
                    const dayPrice = inPromo && d < 12 ? promoPrice : price;
                    const revenue = units * dayPrice;
                    insertSale.run({
                        store_id: storeId, product_id: productId, offer_id: offerId,
                        marketplace: store.platform,
                        date: new Date(Date.now() - d * 864e5).toISOString().slice(0, 10),
                        units, revenue,
                        profit: costPrice ? units * (dayPrice * (1 - commission / 100) - logistics - costPrice) : null,
                        price_seller: dayPrice, price_buyer_est: dayPrice,
                        cost_unit: costPrice, commission_pct: commission,
                        floor: costPrice ? floor : null,
                        promo_flag: inPromo && d < 12 ? 1 : 0,
                        stock_qty: stocksFbo, in_stock_flag: stocksFbo > 0 ? 1 : 0,
                        is_dirty_flag: inPromo && d < 12 ? 1 : 0,
                    });
                    totalSales++;
                }

                // One product per store runs a live experiment
                if (i === 6 && costPrice) {
                    db.prepare(`UPDATE products SET in_experiment = 1, strategy_type = 'max_profit',
                                management_mode = 'experiment', managed_by = 'demo-agent' WHERE id = ?`).run(productId);
                    const exp = insertExperiment.run({
                        store_id: storeId, product_id: productId, offer_id: offerId,
                        strategy_type: 'max_profit',
                        current_price: price, best_price: Math.round(price * 0.92),
                        best_metric: Math.round(between(120, 400)),
                        sales_since_step: Math.round(between(4, 16)),
                        auto_apply: storeIdx === 0 ? 1 : 0,
                        last_decision_json: JSON.stringify({ phase: 'ladder', scanIdx: 4 }),
                    });
                    const expId = exp.lastInsertRowid;
                    const steps = [
                        ['scan',      price,                       Math.round(price * 1.08), 'скан коридора: точка 2 из 4',            1, '-9 days'],
                        ['scan_done', Math.round(price * 1.08),    Math.round(price * 0.92), 'скан завершён, лучшая точка — стартовая', 1, '-7 days'],
                        ['step',      Math.round(price * 0.92),    Math.round(price * 0.85), 'метрика выросла на 12% — шаг вниз',      1, '-4 days'],
                        ['hold',      Math.round(price * 0.85),    Math.round(price * 0.85), 'ждём накопления: 7 из 12 продаж',        0, '-1 days'],
                    ];
                    for (const [action, oldP, newP, reason, applied, age] of steps) {
                        insertStrategyLog.run({
                            experiment_id: expId, store_id: storeId, offer_id: offerId,
                            action, old_price: oldP, new_price: newP,
                            metric_name: 'profit_per_day', metric_value: Math.round(between(90, 380)),
                            reason, applied, age,
                        });
                    }
                }
            }

            // A repricer run, so the log page is not empty
            const runId = crypto.randomUUID();
            const sample = db.prepare(
                `SELECT offer_id, name, ref_price, json_extract(data_json,'$.price') price
                 FROM products WHERE store_id = ? LIMIT 6`).all(storeId);
            sample.forEach((p, k) => {
                const cur = Number(p.price) || 0;
                const ref = Number(p.ref_price) || 0;
                const dev = ref ? ((cur - ref) / ref) * 100 : 0;
                const corrected = Math.abs(dev) > 3;
                insertRepricerLog.run({
                    store_id: storeId, run_id: runId, offer_id: p.offer_id, product_name: p.name,
                    old_price: cur, new_price: corrected ? ref : cur, ref_price: ref,
                    deviation_percent: Number(dev.toFixed(2)),
                    action: corrected ? 'corrected' : 'ok',
                    reason: corrected ? `отклонение ${dev.toFixed(1)}% — цена восстановлена до эталона` : 'в пределах порога',
                    age: `-${12 + k} minutes`,
                });
            });
        });

        return { totalProducts, totalSales };
    });

    const { totalProducts, totalSales } = tx();

    console.log(
        `Demo data ready:\n` +
        `  ${STORES.length} stores (Ozon, Wildberries, Yandex)\n` +
        `  ${totalProducts} products, including items below floor, promotions under\n` +
        `    cost, missing cost prices, quarantine and one running experiment\n` +
        `  ${totalSales} daily sales rows across 60 days\n\n` +
        `None of these credentials are real and nothing here contacts a marketplace.\n` +
        `Remove with: npm run seed:demo -- --reset`
    );
}

main();
