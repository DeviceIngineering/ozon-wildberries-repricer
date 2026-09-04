import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { computeYmFloor, computeYmSellerPayout } = require('../ymFloor.cjs');

describe('computeYmFloor', () => {
    it('null при нулевой/отрицательной себестоимости', () => {
        expect(computeYmFloor({ costPrice: 0, pctFees: 20, taxPercent: 11 })).toBeNull();
        expect(computeYmFloor({ costPrice: -5, pctFees: 20, taxPercent: 11 })).toBeNull();
    });

    it('null при аномалии (сумма % удержаний ≥ 95)', () => {
        expect(computeYmFloor({ costPrice: 100, pctFees: 90, taxPercent: 11 })).toBeNull();
        expect(computeYmFloor({ costPrice: 100, pctFees: 50, taxPercent: 11, boostPercent: 40 })).toBeNull();
    });

    it('налог считается с ВЫРУЧКИ (gross): floor·(1−pct) даёт нужную выручку', () => {
        // cost 100, маржа 0, комиссия 20%, налог 11%, без буста, без фикс
        const floor = computeYmFloor({ costPrice: 100, pctFees: 20, taxPercent: 11, marginPercent: 0 });
        // floor = ceil(100 / (1 - 0.31)) = ceil(144.93) = 145
        expect(floor).toBe(145);
        // проверка инварианта: выручка после комиссии+налога ≥ себестоимости
        const payout = floor * (1 - 0.31);
        expect(payout).toBeGreaterThanOrEqual(100);
    });

    it('старая формула (налог от нетто) занижала floor — новая выше', () => {
        const cost = 100, pct = 20, tax = 11;
        const newFloor = computeYmFloor({ costPrice: cost, pctFees: pct, taxPercent: tax });
        // старая: beforeTax = cost/(1-tax), floor=ceil(beforeTax/(1-pct))
        const oldFloor = Math.ceil((cost / (1 - tax / 100)) / (1 - pct / 100));
        expect(newFloor).toBeGreaterThan(oldFloor);
    });

    it('буст продаж поднимает floor', () => {
        const base = computeYmFloor({ costPrice: 100, pctFees: 20, taxPercent: 11 });
        const boosted = computeYmFloor({ costPrice: 100, pctFees: 20, taxPercent: 11, boostPercent: 10 });
        expect(boosted).toBeGreaterThan(base);
    });

    it('фиксированные удержания и маржа увеличивают floor', () => {
        const base = computeYmFloor({ costPrice: 100, pctFees: 20, taxPercent: 11 });
        expect(computeYmFloor({ costPrice: 100, pctFees: 20, taxPercent: 11, absFees: 50 })).toBeGreaterThan(base);
        expect(computeYmFloor({ costPrice: 100, pctFees: 20, taxPercent: 11, marginPercent: 15 })).toBeGreaterThan(base);
    });

    it('налог 0 не ломает расчёт (защита действует и без ставки)', () => {
        const floor = computeYmFloor({ costPrice: 100, pctFees: 20, taxPercent: 0 });
        expect(floor).toBe(125); // ceil(100/0.8)
    });
});

describe('computeYmSellerPayout', () => {
    it('продажа выше floor → выплата ≥ себестоимости', () => {
        const floor = computeYmFloor({ costPrice: 100, pctFees: 20, taxPercent: 11 }); // 145
        const payout = computeYmSellerPayout({ sellerPrice: floor, pctFees: 20, taxPercent: 11 });
        expect(payout).toBeGreaterThanOrEqual(100);
    });

    it('буст съедает маржу: продажа на floor с фактическим бустом → убыток', () => {
        const floor = computeYmFloor({ costPrice: 100, pctFees: 20, taxPercent: 11 }); // 145 без буста
        // продали по floor, но Маркет списал буст 20₽ — выплата падает ниже себестоимости
        const payout = computeYmSellerPayout({ sellerPrice: floor, pctFees: 20, taxPercent: 11, boostAmount: 20 });
        expect(payout).toBeLessThan(100);
    });

    it('фиксированные удержания вычитаются из выплаты', () => {
        const a = computeYmSellerPayout({ sellerPrice: 200, pctFees: 20, taxPercent: 11 });
        const b = computeYmSellerPayout({ sellerPrice: 200, pctFees: 20, taxPercent: 11, absFees: 30 });
        expect(a - b).toBeCloseTo(30, 5);
    });
});
