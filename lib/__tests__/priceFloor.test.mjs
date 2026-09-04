import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { computeFloorMinPrice } = require('../priceFloor.cjs');

const base = {
    costPrice: 400,
    commissionRate: 20,
    logisticsAmount: 50,
    acquiringAmount: 15,
    taxRate: 6,
};

describe('computeFloorMinPrice', () => {
    it('покрывает себестоимость, налог, комиссию и абсолютные удержания', () => {
        // netNeeded 400 -> beforeTax 400/0.94 = 425.53 -> +65 = 490.53 -> /0.8 = 613.16
        expect(computeFloorMinPrice(base)).toBe(614);
    });

    it('округляет вверх — floor не должен оказаться ниже безубыточности', () => {
        const floor = computeFloorMinPrice(base);
        const net = floor * (1 - base.commissionRate / 100)
            - base.logisticsAmount - base.acquiringAmount;
        expect(net * (1 - base.taxRate / 100)).toBeGreaterThanOrEqual(base.costPrice);
    });

    it('учитывает целевую маржу', () => {
        const withMargin = computeFloorMinPrice({ ...base, marginPercent: 30 });
        expect(withMargin).toBeGreaterThan(computeFloorMinPrice(base));
    });

    it('растёт вместе с комиссией', () => {
        expect(computeFloorMinPrice({ ...base, commissionRate: 30 }))
            .toBeGreaterThan(computeFloorMinPrice(base));
    });

    // Регрессия: нулевая ставка — это реальный режим (патент, НПД, освобождение
    // от НДС), а не «значение не задано». Раньше floor в этом случае молча
    // отключался, и продавец оставался без защиты именно там, где вся выручка
    // облагается по нулю.
    it('нулевая ставка налога = 0%, а не отключение защиты', () => {
        const floor = computeFloorMinPrice({ ...base, taxRate: 0 });
        expect(floor).not.toBeNull();
        // 400 + 65 = 465 -> /0.8 = 581.25
        expect(floor).toBe(582);
    });

    it('нулевая ставка даёт floor ниже, чем ненулевая', () => {
        expect(computeFloorMinPrice({ ...base, taxRate: 0 }))
            .toBeLessThan(computeFloorMinPrice(base));
    });

    it.each([
        ['нет себестоимости', { costPrice: 0 }],
        ['отрицательная себестоимость', { costPrice: -100 }],
        ['налог 100%', { taxRate: 100 }],
        ['налог больше 100%', { taxRate: 120 }],
        ['отрицательный налог', { taxRate: -5 }],
        ['нет комиссии', { commissionRate: 0 }],
        ['комиссия 100%', { commissionRate: 100 }],
    ])('возвращает null: %s', (_label, override) => {
        expect(computeFloorMinPrice({ ...base, ...override })).toBeNull();
    });

    it('работает без абсолютных удержаний', () => {
        const floor = computeFloorMinPrice({
            costPrice: 100, commissionRate: 20, taxRate: 0,
        });
        expect(floor).toBe(125); // 100 / 0.8
    });
});
