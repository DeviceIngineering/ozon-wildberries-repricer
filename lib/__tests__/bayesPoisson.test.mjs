import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { normInv, gammaPosterior, gammaQuantile, posteriorRate } = require('../bayesPoisson.cjs');

describe('normInv (обратная нормаль)', () => {
    it('медиана 0, симметрия', () => {
        expect(normInv(0.5)).toBeCloseTo(0, 6);
        expect(normInv(0.25)).toBeCloseTo(-0.6745, 3);
        expect(normInv(0.975)).toBeCloseTo(1.96, 2);
    });
});

describe('gammaPosterior (сопряжённость)', () => {
    it('апостериор = Gamma(α0+units, β0+days)', () => {
        const p = gammaPosterior({ units: 10, days: 5 }, { alpha: 1, beta: 2 });
        expect(p.alpha).toBe(11);
        expect(p.beta).toBe(7);
        expect(p.mean).toBeCloseTo(11 / 7, 6);
    });
});

describe('posteriorRate (риск-аверсная оценка λ)', () => {
    it('p25 < среднего (нижний перцентиль консервативнее)', () => {
        const r = posteriorRate({ units: 6, days: 10 });
        expect(r.p25).toBeLessThan(r.mean);
        expect(r.p25).toBeGreaterThan(0);
    });
    it('больше данных → p25 ближе к среднему (уже апостериор)', () => {
        const few = posteriorRate({ units: 3, days: 5 });   // λ̂≈0.6
        const many = posteriorRate({ units: 30, days: 50 }); // λ̂≈0.6, но точнее
        const gapFew = (few.mean - few.p25) / few.mean;
        const gapMany = (many.mean - many.p25) / many.mean;
        expect(gapMany).toBeLessThan(gapFew);
    });
});

describe('gammaQuantile', () => {
    it('монотонна по p', () => {
        const a = 10, b = 5;
        expect(gammaQuantile(a, b, 0.1)).toBeLessThan(gammaQuantile(a, b, 0.5));
        expect(gammaQuantile(a, b, 0.5)).toBeLessThan(gammaQuantile(a, b, 0.9));
    });
});
