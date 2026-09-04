import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { decide, metric, unitProfit } = require('../strategyEngine.cjs');

// Детерминированная (seeded) симуляция сходимости ladder на синтетическом пуассон-спросе.
// Защищает движок в CI: при достаточном объёме разрыв по метрике до оптимума мал.
function makeSim(seed = 777) {
    let s = seed;
    const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
    const poisson = (l) => { if (l <= 0) return 0; const L = Math.exp(-l); let k = 0, p = 1; do { k++; p *= rnd(); } while (p > L); return k - 1; };
    return { rnd, poisson };
}

const econ = { cost: 400, commissionPct: 30, acquiringPct: 1.5, taxPct: 11, logistics: 90 };
const floor = 700, ceiling = 1500;
const A = 4.0, B = 0.0028, SCALE = 6; // высокий объём
const demand = (p) => Math.max(0, (A - B * p) * SCALE);

function trueOptimum(strategy, tm) {
    let bp = floor, bm = -Infinity;
    for (let p = floor; p <= ceiling; p++) { const m = metric(strategy, p, demand(p), econ, tm); if (m > bm) { bm = m; bp = p; } }
    return { price: bp, value: bm };
}

function run(strategy, tm) {
    const { poisson } = makeSim();
    let state = { current_price: 1100, step_percent: 8, direction: -1, best_price: null, best_metric: null, bad_steps: 0 };
    const opts = { strategy, floor, ceiling, targetMargin: tm, nMin: 12, tMax: 14, minDays: 3, deltaHysteresis: 0.02 };
    for (let c = 0; c < 30; c++) {
        let units = 0, days = 0;
        while (!((units >= 12 && days >= 3) || days >= 14)) { units += poisson(demand(state.current_price)); days++; }
        const d = decide(state, { units, days }, econ, opts);
        if (d.bestPrice != null) { state.best_price = d.bestPrice; state.best_metric = d.bestMetric; }
        if (d.direction != null) state.direction = d.direction;
        if (d.badSteps != null) state.bad_steps = d.badSteps;
        if (d.stepPercent != null) state.step_percent = d.stepPercent;
        if (d.phase != null) state.phase = d.phase;
        if (d.scan != null) state.scan = d.scan;
        if (d.scan_grid != null) state.scan_grid = d.scan_grid;
        if (d.scan_idx != null) state.scan_idx = d.scan_idx;
        if (d.action === 'scan_done') { state.scan = null; state.scan_grid = null; state.scan_idx = null; }
        if (['no_room', 'converged'].includes(d.action)) break;
        if (d.nextPrice != null) state.current_price = d.nextPrice;
    }
    return state.best_price;
}

describe('Сходимость ladder (детерминированно, высокий объём)', () => {
    it('max_profit: разрыв по метрике < 10%', () => {
        const opt = trueOptimum('max_profit');
        const conv = run('max_profit');
        const achieved = metric('max_profit', conv, demand(conv), econ);
        const gap = (opt.value - achieved) / Math.abs(opt.value) * 100;
        expect(gap).toBeLessThan(10);
    });
    it('max_units (маржа≥15%): разрыв по метрике < 15%', () => {
        const opt = trueOptimum('max_units', 15);
        const conv = run('max_units', 15);
        const achieved = metric('max_units', conv, demand(conv), econ, 15);
        const gap = (opt.value - achieved) / Math.abs(opt.value) * 100;
        expect(gap).toBeLessThan(15);
    });
    it('сошедшаяся цена остаётся в коридоре [floor; ceiling]', () => {
        const conv = run('max_profit');
        expect(conv).toBeGreaterThanOrEqual(floor);
        expect(conv).toBeLessThanOrEqual(ceiling);
    });
    it('прибыль на сошедшейся цене положительна (floor-гард)', () => {
        const conv = run('max_profit');
        expect(unitProfit(conv, econ)).toBeGreaterThan(0);
    });
});
