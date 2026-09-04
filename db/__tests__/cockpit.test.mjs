import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Изолированная БД во временном файле — миграции/схема накатываются при require connection.cjs
const require = createRequire(import.meta.url);
const dbFile = path.join(os.tmpdir(), `cockpit-test-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const { db } = require('../connection.cjs');
const { getDecisionCockpit } = require('../analytics.cjs');

// ── Хелперы сидов ───────────────────────────────────────────────────────────
let storeSeq = 0;
function makeStore(opts = {}) {
    const id = opts.id || `store-${++storeSeq}`;
    db.prepare(`INSERT INTO stores (id,name,client_id,api_key,platform,repricer_enabled,last_repricer_run,promo_exit_enabled)
        VALUES (?,?,?,?,?,?,?,?)`).run(
        id, opts.name || id, 'cid', 'key', opts.platform || 'ozon',
        opts.repricer_enabled ?? 1, opts.last_repricer_run || null, opts.promo_exit_enabled ?? 0);
    return id;
}

let ozonSeq = 0;
function addProduct(storeId, f = {}) {
    const ozonId = f.ozon_id ?? ++ozonSeq;
    const price = f.price ?? 1000;
    const data = JSON.stringify({ price, min_price: f.min_price ?? price, marketing_price: f.marketing_price ?? price });
    const offer = f.offer_id || `OF-${ozonId}`;
    const info = db.prepare(`INSERT INTO products
        (store_id,ozon_id,offer_id,data_json,ref_price,cost_price,floor_min_price,in_promo,promo_price,is_quarantine,price_apply_status,visibility,is_archived)
        VALUES (@store_id,@ozon_id,@offer_id,@data_json,@ref_price,@cost_price,@floor_min_price,@in_promo,@promo_price,@is_quarantine,@price_apply_status,@visibility,@is_archived)`).run({
        store_id: storeId, ozon_id: ozonId, offer_id: offer, data_json: data,
        ref_price: f.ref_price ?? null, cost_price: f.cost_price ?? null, floor_min_price: f.floor_min_price ?? null,
        in_promo: f.in_promo ?? 0, promo_price: f.promo_price ?? null, is_quarantine: f.is_quarantine ?? 0,
        price_apply_status: f.price_apply_status ?? 'APPLIED', visibility: f.visibility ?? 'VISIBLE', is_archived: f.is_archived ?? 0,
    });
    return { id: info.lastInsertRowid, offer };
}

function addLogEntry(storeId, stage, level, message) {
    const r = db.prepare(`INSERT INTO sync_logs (store_id, status) VALUES (?, 'OK')`).run(storeId);
    db.prepare(`INSERT INTO sync_log_entries (log_id, level, stage, message) VALUES (?,?,?,?)`)
        .run(r.lastInsertRowid, level, stage, message);
}

function addRepricerLog(storeId, action) {
    db.prepare(`INSERT INTO repricer_log (store_id, offer_id, old_price, new_price, action) VALUES (?,?,?,?,?)`)
        .run(storeId, 'X', 100, 100, action);
}

function addPending(storeId, productId, status) {
    db.prepare(`INSERT INTO price_updates_pending (store_id, product_id, offer_id, sent_price, status) VALUES (?,?,?,?,?)`)
        .run(storeId, productId, 'X', 100, status);
}

function addSales(storeId, offerId, units, days = 7) {
    for (let d = 0; d < days; d++) {
        const date = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
        db.prepare(`INSERT INTO sales_daily (store_id,offer_id,marketplace,date,units,revenue,is_dirty_flag) VALUES (?,?,?,?,?,?,0)`)
            .run(storeId, offerId, 'ozon', date, units, units * 100);
    }
}

function clearAll() {
    for (const t of ['sync_log_entries', 'sync_logs', 'repricer_log', 'price_updates_pending', 'sales_daily', 'products', 'stores'])
        db.prepare(`DELETE FROM ${t}`).run();
}

const task = (cockpit, id) => cockpit.tasks.find(t => t.id === id);

beforeEach(clearAll);
afterAll(() => {
    try { db.close(); } catch { /* noop */ }
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbFile + ext); } catch { /* noop */ } }
});

// ── Типы задач ────────────────────────────────────────────────────────────────
describe('getDecisionCockpit — типы задач', () => {
    it('bad_ref: РРЦ ниже себестоимости (danger, риск = c/с − РРЦ)', async () => {
        const s = makeStore({ platform: 'wildberries' });
        addProduct(s, { ref_price: 300, cost_price: 350, price: 300 });
        const c = await getDecisionCockpit('7d');
        const t = task(c, 'bad_ref');
        expect(t).toBeTruthy();
        expect(t.severity).toBe('danger');
        expect(t.count).toBe(1);
        expect(t.risk).toBe(50);
        expect(t.byStore[0].store_id).toBe(s);
    });

    it('promo_below_cost: промо ниже себестоимости (danger)', async () => {
        const s = makeStore();
        addProduct(s, { in_promo: 1, promo_price: 80, cost_price: 100, ref_price: 200, price: 80 });
        const t = task(await getDecisionCockpit('7d'), 'promo_below_cost');
        expect(t.severity).toBe('danger');
        expect(t.count).toBe(1);
        expect(t.risk).toBe(20);
    });

    it('below_floor: цена ниже пола (warn, риск = пол − цена)', async () => {
        const s = makeStore();
        addProduct(s, { floor_min_price: 200, price: 150, ref_price: 500, cost_price: 100 });
        const t = task(await getDecisionCockpit('7d'), 'below_floor');
        expect(t.severity).toBe('warn');
        expect(t.count).toBe(1);
        expect(t.risk).toBe(50);
    });

    it('quarantine: цены в карантине (warn)', async () => {
        const s = makeStore();
        addProduct(s, { is_quarantine: 1, ref_price: 100, cost_price: 50 });
        const t = task(await getDecisionCockpit('7d'), 'quarantine');
        expect(t.severity).toBe('warn');
        expect(t.count).toBe(1);
    });

    it('not_applied: REJECTED + VERIFIED_FAIL суммируются', async () => {
        const s = makeStore();
        addProduct(s, { price_apply_status: 'REJECTED', ref_price: 100, cost_price: 50 });
        const p = addProduct(s, { ref_price: 100, cost_price: 50 });
        addPending(s, p.id, 'VERIFIED_FAIL');
        const t = task(await getDecisionCockpit('7d'), 'not_applied');
        expect(t.severity).toBe('warn');
        expect(t.count).toBe(2);
    });

    it('no_cost: не указана себестоимость (warn), не зависит от РРЦ', async () => {
        const s = makeStore();
        addProduct(s, { ref_price: 100, cost_price: null }); // РРЦ есть, себестоимости нет
        const c = await getDecisionCockpit('7d');
        const t = task(c, 'no_cost');
        expect(t.severity).toBe('warn');
        expect(t.count).toBe(1);
        expect(task(c, 'no_data')).toBeFalsy(); // РРЦ заполнена → no_data не срабатывает
    });

    it('no_data: нет эталона РРЦ (info), не зависит от себестоимости', async () => {
        const s = makeStore();
        addProduct(s, { ref_price: null, cost_price: 50 }); // себестоимость есть, РРЦ нет
        const c = await getDecisionCockpit('7d');
        const t = task(c, 'no_data');
        expect(t.severity).toBe('info');
        expect(t.count).toBe(1);
        expect(task(c, 'no_cost')).toBeFalsy(); // себестоимость заполнена → no_cost не срабатывает
    });

    it('товар без РРЦ и без себестоимости → обе задачи (no_cost + no_data)', async () => {
        const s = makeStore();
        addProduct(s, { ref_price: null, cost_price: null });
        const c = await getDecisionCockpit('7d');
        expect(task(c, 'no_cost').count).toBe(1);
        expect(task(c, 'no_data').count).toBe(1);
    });

    it('ozon_cofund: marketing_price ниже пола при корректной цене продавца (danger)', async () => {
        const s = makeStore({ platform: 'ozon' });
        // цена продавца 700 >= пол 650, но marketing_price 600 < пол → софинанс давит
        addProduct(s, { floor_min_price: 650, price: 700, ref_price: 800, cost_price: 300, marketing_price: 600 });
        const t = task(await getDecisionCockpit('7d'), 'ozon_cofund');
        expect(t.severity).toBe('danger');
        expect(t.count).toBe(1);
        expect(t.risk).toBe(50); // пол 650 − marketing 600
    });

    it('ozon_cofund: считает SKU, а не события — один товар = 1 (не дублируется)', async () => {
        const s = makeStore({ platform: 'ozon' });
        addProduct(s, { floor_min_price: 650, price: 700, ref_price: 800, cost_price: 300, marketing_price: 600 });
        // много логовых событий по тому же SKU не должны влиять на счётчик
        addLogEntry(s, 'OZON_PROMO_BELOW_FLOOR', 'WARNING', '[X] ...');
        addLogEntry(s, 'OZON_PROMO_BELOW_FLOOR', 'WARNING', '[X] ...');
        const t = task(await getDecisionCockpit('7d'), 'ozon_cofund');
        expect(t.count).toBe(1);
    });

    it('ozon_cofund: НЕ срабатывает, если цена продавца сама ниже пола (это below_floor)', async () => {
        const s = makeStore({ platform: 'ozon' });
        addProduct(s, { floor_min_price: 650, price: 600, ref_price: 800, cost_price: 300, marketing_price: 600 });
        const c = await getDecisionCockpit('7d');
        expect(task(c, 'ozon_cofund')).toBeFalsy();
        expect(task(c, 'below_floor')).toBeTruthy();
    });

    it('promo_exit_fail: rejected+errors из сводки PROMO_EXIT_SUMMARY (warn)', async () => {
        const s = makeStore();
        addLogEntry(s, 'PROMO_EXIT_SUMMARY', 'WARNING', JSON.stringify({ actions: 2, removed: 5, rejected: 3, errors: 1 }));
        const t = task(await getDecisionCockpit('7d'), 'promo_exit_fail');
        expect(t.severity).toBe('warn');
        expect(t.count).toBe(4); // rejected 3 + errors 1
    });

    it('нет проблем → нет задач', async () => {
        const s = makeStore();
        addProduct(s, { ref_price: 100, cost_price: 50, floor_min_price: 60, price: 100 });
        const c = await getDecisionCockpit('7d');
        expect(c.tasks.length).toBe(0);
        expect(c.totalRisk).toBe(0);
    });
});

// ── Ранжирование ────────────────────────────────────────────────────────────
describe('ранжирование задач', () => {
    it('severity: danger → warn → info', async () => {
        const s = makeStore();
        addProduct(s, { ref_price: 300, cost_price: 350, price: 300 });       // bad_ref danger
        addProduct(s, { floor_min_price: 200, price: 150, ref_price: 500, cost_price: 100 }); // below_floor warn
        addProduct(s, { ref_price: null, cost_price: 50 });                    // no_data info
        const order = (await getDecisionCockpit('7d')).tasks.map(t => t.severity);
        expect(order).toEqual(['danger', 'warn', 'info']);
    });

    it('внутри severity — по риску ₽ убыванием', async () => {
        const s = makeStore();
        addProduct(s, { ref_price: 300, cost_price: 310, price: 300 });        // bad_ref риск 10
        addProduct(s, { in_promo: 1, promo_price: 100, cost_price: 1000, ref_price: 2000, price: 100 }); // promo риск 900
        const dangers = (await getDecisionCockpit('7d')).tasks.filter(t => t.severity === 'danger');
        expect(dangers[0].risk).toBeGreaterThan(dangers[1].risk);
        expect(dangers[0].id).toBe('promo_below_cost');
    });
});

// ── Money-at-risk: per_unit ↔ per_day ─────────────────────────────────────────
describe('money-at-risk', () => {
    it('без продаж → per_unit (разовый разрыв)', async () => {
        const s = makeStore();
        addProduct(s, { floor_min_price: 200, price: 150, ref_price: 500, cost_price: 100 });
        const c = await getDecisionCockpit('7d');
        expect(c.moneyKind).toBe('per_unit');
        expect(task(c, 'below_floor').riskKind).toBe('per_unit');
        expect(task(c, 'below_floor').risk).toBe(50);
    });

    it('с продажами → per_day (разрыв × средние дневные продажи)', async () => {
        const s = makeStore();
        const p = addProduct(s, { floor_min_price: 200, price: 150, ref_price: 500, cost_price: 100 });
        addSales(s, p.offer, 2, 7); // 7 дней × 2 = 14 ед / 7 = 2 ед/день
        const c = await getDecisionCockpit('7d');
        expect(c.moneyKind).toBe('per_day');
        expect(task(c, 'below_floor').riskKind).toBe('per_day');
        expect(task(c, 'below_floor').risk).toBe(100); // gap 50 × 2 ед/день
    });

    it('guard: при отсутствии таблицы sales_daily не падает, фолбэк per_unit', async () => {
        const s = makeStore();
        addProduct(s, { floor_min_price: 200, price: 150, ref_price: 500, cost_price: 100 });
        const createSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='sales_daily'").get().sql;
        db.prepare('DROP TABLE sales_daily').run();
        try {
            const c = await getDecisionCockpit('7d');
            expect(c.moneyKind).toBe('per_unit');
            expect(task(c, 'below_floor').risk).toBe(50);
        } finally {
            db.prepare(createSql).run(); // восстановить таблицу для остальных тестов
        }
    });
});

// ── Слой автоматики ───────────────────────────────────────────────────────────
describe('слой автоматики', () => {
    it('held считает товары на/выше РРЦ, corrected из repricer_log', async () => {
        const s = makeStore({ name: 'Маг1' });
        addProduct(s, { ref_price: 1000, price: 1000 });  // held
        addProduct(s, { ref_price: 1000, price: 900 });   // не held
        addRepricerLog(s, 'corrected');
        addRepricerLog(s, 'corrected');
        addRepricerLog(s, 'ok');
        const a = (await getDecisionCockpit('7d')).automation.find(x => x.id === s);
        expect(a.held).toBe(1);
        expect(a.corrected).toBe(2);
        expect(a.name).toBe('Маг1');
    });
});

// ── Аналитика ────────────────────────────────────────────────────────────────
describe('аналитика для решений', () => {
    it('маржа портфеля: распределение по марже к полу', async () => {
        const s = makeStore();
        addProduct(s, { floor_min_price: 100, price: 90 });   // loss
        addProduct(s, { floor_min_price: 100, price: 110 });  // 5–15% (b5)
        addProduct(s, { floor_min_price: 100, price: 200 });  // 30%+ (b30)
        const m = (await getDecisionCockpit('7d')).analytics.margin;
        expect(m.loss).toBe(1);
        expect(m.b5).toBe(1);
        expect(m.b30).toBe(1);
    });

    it('контроль цены: РРЦ (не в акции) vs акции', async () => {
        const s = makeStore();
        addProduct(s, { in_promo: 1 });
        addProduct(s, { in_promo: 1 });
        addProduct(s, { in_promo: 0 });
        const ctrl = (await getDecisionCockpit('7d')).analytics.control;
        expect(ctrl.promo).toBe(2);
        expect(ctrl.rrc).toBe(1); // 1 товар не в акции
    });
});

// ── Контракт ответа ───────────────────────────────────────────────────────────
describe('контракт ответа', () => {
    it('возвращает period, tasks, totalRisk, moneyKind, automation, analytics', async () => {
        makeStore();
        const c = await getDecisionCockpit('30d');
        expect(c.period).toBe('30d');
        expect(Array.isArray(c.tasks)).toBe(true);
        expect(typeof c.totalRisk).toBe('number');
        expect(['per_day', 'per_unit']).toContain(c.moneyKind);
        expect(Array.isArray(c.automation)).toBe(true);
        expect(c.analytics).toHaveProperty('margin');
        expect(c.analytics).toHaveProperty('control');
        expect(c.analytics).toHaveProperty('lossTrend');
    });
});
