import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { deriveStorePrice } = require('../masterPricing.cjs');

describe('deriveStorePrice — Ozon', () => {
    const store = { platform: 'ozon' };

    it('price = master, скидка и зачёркнутая цена выводятся', () => {
        const r = deriveStorePrice(1035, store, { offer_id: 'SKU-0001', cost_price: 414, ref_min_price: 500 });
        expect(r.ok).toBe(true);
        expect(r.update.price).toBe('1035');
        expect(r.buyerPrice).toBe(1035);
        expect(Number(r.priceNoDiscount)).toBeGreaterThan(1035); // old_price > price
        expect(Number(r.update.min_price)).toBe(500);
        expect(r.belowCost).toBe(false);
    });

    it('min_price по умолчанию = 50% мастер-цены, если ref_min_price не задан', () => {
        const r = deriveStorePrice(1000, store, { offer_id: 'x', cost_price: 300 });
        expect(Number(r.update.min_price)).toBe(500);
    });

    it('belowCost=true при мастер-цене ниже себестоимости', () => {
        const r = deriveStorePrice(300, store, { offer_id: 'x', cost_price: 414 });
        expect(r.belowCost).toBe(true);
    });

    it('дефолт платформы — ozon', () => {
        const r = deriveStorePrice(1000, {}, { offer_id: 'x', cost_price: 100 });
        expect(r.platform).toBe('ozon');
        expect(r.update.price).toBe('1000');
    });
});

describe('deriveStorePrice — Wildberries', () => {
    const store = { platform: 'wildberries' };

    it('держит скидку продавца, двигает базу; цена покупателя ≈ master', () => {
        const r = deriveStorePrice(1035, store, { offer_id: 'SKU-0001', ozon_id: 100000001, wb_discount: 43, cost_price: 414 });
        expect(r.ok).toBe(true);
        expect(r.update.nmID).toBe(100000001);
        expect(r.update.discount).toBe(43);
        // base × (1 - 43/100) должно давать >= master (округление базы вверх)
        expect(r.buyerPrice).toBeGreaterThanOrEqual(1035);
        expect(r.buyerPrice).toBeLessThan(1035 + 5);
        expect(Number(r.update.price)).toBeGreaterThan(1035); // базовая (зачёркнутая) выше цены покупателя
    });

    it('без валидной скидки-якоря — discount=0, price=master', () => {
        const r = deriveStorePrice(1000, store, { offer_id: 'x', ozon_id: 555, wb_discount: 0, cost_price: 100 });
        expect(r.update.discount).toBe(0);
        expect(r.update.price).toBe('1000');
        expect(r.buyerPrice).toBe(1000);
    });

    it('nmID берётся из ozon_id (для WB там хранится nmID)', () => {
        const r = deriveStorePrice(1000, store, { offer_id: 'SKU-0002', ozon_id: 777, wb_discount: 20 });
        expect(r.update.nmID).toBe(777);
    });
});

describe('deriveStorePrice — гарды', () => {
    it('ok=false при некорректной мастер-цене', () => {
        expect(deriveStorePrice(0, { platform: 'ozon' }, { offer_id: 'x' }).ok).toBe(false);
        expect(deriveStorePrice(-5, { platform: 'ozon' }, { offer_id: 'x' }).ok).toBe(false);
        expect(deriveStorePrice('abc', { platform: 'ozon' }, { offer_id: 'x' }).ok).toBe(false);
    });
});
