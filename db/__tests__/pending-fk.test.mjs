import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Изолированная БД
const require = createRequire(import.meta.url);
const dbFile = path.join(os.tmpdir(), `pending-fk-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbFile;

const { db } = require('../connection.cjs');
const { getStoreProducts } = require('../products.cjs');
const { createPendingUpdate } = require('../pending.cjs');

function makeStore(id = 'st-1') {
    db.prepare(`INSERT INTO stores (id,name,client_id,api_key,platform) VALUES (?,?,?,?,?)`)
        .run(id, id, 'cid', 'key', 'ozon');
    return id;
}
// ozon_id и data_json.product_id = крупный Ozon-идентификатор, отличный от PK
function addProduct(storeId, ozonId) {
    const data = JSON.stringify({ product_id: ozonId, offer_id: `OF-${ozonId}`, price: 1000 });
    const info = db.prepare(`INSERT INTO products (store_id,ozon_id,offer_id,data_json) VALUES (?,?,?,?)`)
        .run(storeId, ozonId, `OF-${ozonId}`, data);
    return info.lastInsertRowid; // PK
}
function clearAll() {
    for (const t of ['price_updates_pending', 'products', 'stores']) db.prepare(`DELETE FROM ${t}`).run();
}

beforeEach(clearAll);
afterAll(() => {
    try { db.close(); } catch { /* noop */ }
    for (const ext of ['', '-wal', '-shm']) { try { fs.unlinkSync(dbFile + ext); } catch { /* noop */ } }
});

describe('FK price_updates_pending.product_id (фикс импорта Excel)', () => {
    it('getStoreProducts отдаёт PK id (= products.id), а product_id = Ozon-id', async () => {
        const s = makeStore();
        const pk = addProduct(s, 9000000001); // Ozon id заведомо ≠ PK
        const [p] = await getStoreProducts(s);
        expect(p.id).toBe(pk);                 // PK строки
        expect(p.product_id).toBe(9000000001); // Ozon product_id из data_json
        expect(p.id).not.toBe(p.product_id);   // именно их путаница давала FK-ошибку
    });

    it('createPendingUpdate с PK (product.id) — успех (FK выполняется)', async () => {
        const s = makeStore();
        addProduct(s, 9000000002);
        const [p] = await getStoreProducts(s);
        const lastId = await createPendingUpdate({
            store_id: s, product_id: p.id, offer_id: p.offer_id,
            sent_price: 1000, verify_after: new Date().toISOString(),
        });
        expect(lastId).toBeGreaterThan(0);
    });

    it('createPendingUpdate с Ozon product_id (старый баг) — падает по FK', async () => {
        const s = makeStore();
        addProduct(s, 9000000003);
        const [p] = await getStoreProducts(s);
        await expect(createPendingUpdate({
            store_id: s, product_id: p.product_id, offer_id: p.offer_id, // Ozon-id → нет такого PK
            sent_price: 1000, verify_after: new Date().toISOString(),
        })).rejects.toThrow(/FOREIGN KEY/i);
    });
});
