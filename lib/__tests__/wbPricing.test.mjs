import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { computeWbFloor, computeWbPricePair, computeBoxLogistics, discountedFromPair } = require('../wbPricing.cjs');

describe('computeWbFloor', () => {
    it('возвращает null при некорректной себестоимости/комиссии', () => {
        expect(computeWbFloor({ costPrice: 0, commissionPercent: 33, logisticsAmount: 46, taxRate: 6 })).toBeNull();
        expect(computeWbFloor({ costPrice: 100, commissionPercent: 100, logisticsAmount: 46, taxRate: 6 })).toBeNull();
    });

    it('работает при налоге 0 (безубыточность без налога, не null)', () => {
        const floor = computeWbFloor({ costPrice: 100, commissionPercent: 33, acquiringPercent: 1.5, logisticsAmount: 46, returnLogisticsAmount: 46 * 0.3, taxRate: 0 });
        expect(floor).toBeGreaterThan(100);
        // без налога floor ниже, чем с налогом 6%
        const withTax = computeWbFloor({ costPrice: 100, commissionPercent: 33, acquiringPercent: 1.5, logisticsAmount: 46, returnLogisticsAmount: 46 * 0.3, taxRate: 6 });
        expect(floor).toBeLessThan(withTax);
    });

    it('считает безубыточную discountedPrice (cost100, комиссия33%, лог46+обр13.8, налог6%)', () => {
        const floor = computeWbFloor({
            costPrice: 100, commissionPercent: 33, acquiringPercent: 1.5,
            logisticsAmount: 46, returnLogisticsAmount: 46 * 0.3, taxRate: 6, marginPercent: 0,
        });
        expect(floor).toBe(254);
    });

    it('маржа увеличивает floor', () => {
        const base = computeWbFloor({ costPrice: 100, commissionPercent: 20, logisticsAmount: 50, taxRate: 6, marginPercent: 0 });
        const withMargin = computeWbFloor({ costPrice: 100, commissionPercent: 20, logisticsAmount: 50, taxRate: 6, marginPercent: 20 });
        expect(withMargin).toBeGreaterThan(base);
    });
});

describe('computeWbPricePair (держим РРЦ через базу при фикс. скидке)', () => {
    it('сохраняет скидку 95% и двигает базу под целевую РРЦ', () => {
        const pair = computeWbPricePair(10213, 95);
        expect(pair.discount).toBe(95);
        expect(pair.price).toBe(204260);
        expect(discountedFromPair(pair.price, pair.discount)).toBeCloseTo(10213, 0);
    });

    it('скидка 50% → база = 2×цели', () => {
        const pair = computeWbPricePair(254, 50);
        expect(pair).toEqual({ price: 508, discount: 50 });
        expect(discountedFromPair(pair.price, pair.discount)).toBe(254);
    });

    it('без валидной скидки-якоря держит цену напрямую (discount=0)', () => {
        expect(computeWbPricePair(500, 0)).toEqual({ price: 500, discount: 0 });
        expect(computeWbPricePair(500, 100)).toEqual({ price: 500, discount: 0 });
    });

    it('итоговая discountedPrice НЕ ниже цели (округление базы вверх)', () => {
        for (const target of [199, 333, 1001, 7777]) {
            for (const disc of [10, 33, 50, 88, 95]) {
                const pair = computeWbPricePair(target, disc);
                expect(discountedFromPair(pair.price, pair.discount)).toBeGreaterThanOrEqual(target);
            }
        }
    });
});

describe('computeBoxLogistics', () => {
    it('до 1 литра — только база', () => {
        expect(computeBoxLogistics(0.55, { base: 46, liter: 14 })).toBe(46);
        expect(computeBoxLogistics(1, { base: 46, liter: 14 })).toBe(46);
    });
    it('доп. литры добавляются по тарифу', () => {
        expect(computeBoxLogistics(3.2, { base: 46, liter: 14 })).toBe(46 + 3 * 14);
    });
    it('пустой объём трактуется как 1 литр', () => {
        expect(computeBoxLogistics(0, { base: 46, liter: 14 })).toBe(46);
    });
});
