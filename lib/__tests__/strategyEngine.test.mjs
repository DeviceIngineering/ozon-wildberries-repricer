import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { unitProfit, marginPct, metric, lowerBound, decide } = require('../strategyEngine.cjs');

const econ = { cost: 400, commissionPct: 30, acquiringPct: 1.5, taxPct: 11, logistics: 90 };

describe('unitProfit / marginPct', () => {
    it('прибыль = цена·(1−%удержаний) − логистика − себест', () => {
        // 1000·(1−0.425) − 90 − 400 = 575 − 490 = 85
        expect(unitProfit(1000, econ)).toBeCloseTo(85, 6);
        expect(marginPct(1000, econ)).toBeCloseTo(85 / 400 * 100, 6);
    });
});

describe('metric (целевые функции)', () => {
    it('max_revenue = цена×штуки', () => {
        expect(metric('max_revenue', 1000, 2, econ)).toBe(2000);
    });
    it('max_profit = прибыль/ед × штуки', () => {
        expect(metric('max_profit', 1000, 2, econ)).toBeCloseTo(170, 6);
    });
    it('max_units = штуки при марже ≥ целевой, иначе -Inf', () => {
        expect(metric('max_units', 1000, 3, econ, 10)).toBe(3);        // маржа ~21% ≥ 10
        expect(metric('max_units', 1000, 3, econ, 30)).toBe(-Infinity); // маржа ~21% < 30
    });
});

describe('lowerBound (слив ниже себестоимости)', () => {
    it('обычная стратегия → floor', () => {
        expect(lowerBound({ strategy: 'max_profit', floor: 950, econ })).toBe(950);
    });
    it('liquidation → допускает ниже себестоимости', () => {
        const lb = lowerBound({ strategy: 'liquidation', floor: 950, econ, liquidationMaxLossPct: 20 });
        expect(lb).toBeLessThan(950);          // ниже обычного floor
        expect(lb).toBeGreaterThan(0);
    });
});

describe('decide (ladder)', () => {
    const opts = { strategy: 'max_profit', floor: 600, ceiling: 1500, nMin: 12, tMax: 14 };

    it('держим, пока мало данных', () => {
        const d = decide({ current_price: 1000, step_percent: 8 }, { units: 3, days: 4 }, econ, opts);
        expect(d.action).toBe('hold');
    });
    it('фаза скана: зондируем сетку коридора', () => {
        const d = decide({ current_price: 1000, step_percent: 8 }, { units: 15, days: 10 }, econ, opts);
        expect(d.action).toBe('scan');
        expect(d.phase).toBe('scan');
        expect(d.nextPrice).toBeGreaterThanOrEqual(opts.floor);
    });
    it('ladder: первый замер с достаточными данными → шаг + фиксация лучшего', () => {
        const d = decide({ current_price: 1000, step_percent: 8, phase: 'ladder' }, { units: 15, days: 10 }, econ, opts);
        expect(d.action).toBe('step');
        expect(d.bestPrice).toBe(1000);
        expect(d.nextPrice).not.toBe(1000);
    });
    it('liquidation → опускаем к минимуму, без эксперимента', () => {
        const d = decide({ current_price: 1000 }, { units: 0, days: 0 },
            econ, { strategy: 'liquidation', floor: 950, ceiling: 1500, liquidationMaxLossPct: 15 });
        expect(d.action).toBe('liquidate');
        expect(d.nextPrice).toBeLessThan(950);
    });
    it('нет коридора (floor ≥ ceiling) → no_room', () => {
        const d = decide({ current_price: 1000 }, { units: 20, days: 10 }, econ,
            { strategy: 'max_profit', floor: 1200, ceiling: 1100, nMin: 12, tMax: 14 });
        expect(d.action).toBe('no_room');
    });
    it('safety: nextPrice не выше ceiling (потолок коридора)', () => {
        // max_profit, цена у потолка, шаг вверх должен клампиться
        const d = decide({ current_price: 1480, step_percent: 8, phase: 'ladder', direction: 1 },
            { units: 20, days: 10 }, econ, { ...opts, ceiling: 1500 });
        if (d.nextPrice != null) expect(d.nextPrice).toBeLessThanOrEqual(1500);
    });
    it('safety: слив не опускает цену произвольно низко (граница допустимого минуса)', () => {
        const lowLoss = decide({ current_price: 1000 }, { units: 0, days: 0 },
            econ, { strategy: 'liquidation', floor: 950, ceiling: 1500, liquidationMaxLossPct: 5 });
        const highLoss = decide({ current_price: 1000 }, { units: 0, days: 0 },
            econ, { strategy: 'liquidation', floor: 950, ceiling: 1500, liquidationMaxLossPct: 30 });
        // больший допустимый минус → ниже цена
        expect(highLoss.nextPrice).toBeLessThan(lowLoss.nextPrice);
        expect(lowLoss.nextPrice).toBeGreaterThan(0);
    });
    it('safety: max_units при недостижимой марже не выбирает такую цену (метрика -Inf)', () => {
        // floor=cost-уровень, маржа недостижима 50% → метрика -Inf на всех ценах коридора
        const m = metric('max_units', 700, 5, econ, 50);
        expect(m).toBe(-Infinity);
    });

    it('два плохих замера подряд → откат к лучшей цене', () => {
        const state = { current_price: 920, step_percent: 8, direction: -1, best_price: 1000, best_metric: 200, bad_steps: 1, phase: 'ladder' };
        const d = decide(state, { units: 15, days: 10 }, econ, opts);
        expect(d.action).toBe('rollback');
        expect(d.nextPrice).toBe(1000);
        expect(d.stepPercent).toBeLessThan(8);
    });
});
