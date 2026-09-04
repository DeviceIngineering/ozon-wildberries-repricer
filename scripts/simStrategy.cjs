/**
 * Монте-Карло симуляция движка стратегий (РФ6).
 * Синтетический линейный спрос λ(p)=max(0, a−b·p) → у выручки/прибыли есть внутренний оптимум.
 * Прогоняем ladder и проверяем: сходится ли best_price к теоретическому оптимуму и каков regret.
 * Запуск: node scripts/simStrategy.cjs
 */
const { decide, unitProfit, metric } = require('../lib/strategyEngine.cjs');

// Сид-RNG (LCG) — воспроизводимость.
let _seed = 12345;
function rnd() { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; }
function poisson(lambda) { // Knuth
    if (lambda <= 0) return 0;
    const L = Math.exp(-lambda); let k = 0, p = 1;
    do { k++; p *= rnd(); } while (p > L);
    return k - 1;
}

const econ = { cost: 400, commissionPct: 30, acquiringPct: 1.5, taxPct: 11, logistics: 90 };
// Линейный спрос: λ(p) = (a − b·p)·SCALE (шт/день). SCALE=1 — низкий объём (λ≈0.3..2), SCALE=6 — высокий.
const a = 4.0, b = 0.0028;
let SCALE = 1;
const demand = (p) => Math.max(0, (a - b * p) * SCALE);

const floor = 700, ceiling = 1500;

// Теоретический оптимум на сетке (для сравнения).
function trueOptimum(strategy, targetMargin) {
    let bestP = floor, bestM = -Infinity;
    for (let p = floor; p <= ceiling; p += 1) {
        const m = metric(strategy, p, demand(p), econ, targetMargin);
        if (m > bestM) { bestM = m; bestP = p; }
    }
    return { price: bestP, value: bestM };
}

function simulate(strategy, { startPrice = 1100, cycles = 40, nMin = 12, tMax = 14, minDays = 3, targetMargin } = {}) {
    let state = { current_price: startPrice, step_percent: 8, direction: -1, best_price: null, best_metric: null, bad_steps: 0 };
    const opts = { strategy, floor, ceiling, targetMargin, nMin, tMax, minDays, deltaHysteresis: 0.02, riskQuantile: 0.25, minStepPct: 3 };
    let totalProfit = 0, totalDays = 0;

    for (let c = 0; c < cycles; c++) {
        let units = 0, days = 0;
        while (!((units >= nMin && days >= minDays) || days >= tMax)) {
            const u = poisson(demand(state.current_price));
            units += u; days += 1;
            totalProfit += unitProfit(state.current_price, econ) * u;
            totalDays += 1;
        }
        const d = decide(state, { units, days }, econ, opts);
        // применяем все поля решения в состояние
        if (d.bestPrice != null) { state.best_price = d.bestPrice; state.best_metric = d.bestMetric; }
        if (d.direction != null) state.direction = d.direction;
        if (d.badSteps != null) state.bad_steps = d.badSteps;
        if (d.stepPercent != null) state.step_percent = d.stepPercent;
        if (d.phase != null) state.phase = d.phase;
        if (d.scan != null) state.scan = d.scan;
        if (d.scan_grid != null) state.scan_grid = d.scan_grid;
        if (d.scan_idx != null) state.scan_idx = d.scan_idx;
        if (d.action === 'scan_done') { state.scan = null; state.scan_grid = null; state.scan_idx = null; }
        if (d.action === 'no_room') break;
        if (d.action === 'converged') break;
        if (d.nextPrice != null) state.current_price = d.nextPrice;
    }
    return { converged: state.best_price, totalProfit, totalDays };
}

function runScenario(label, scale) {
    SCALE = scale;
    console.log(`\n===== ${label} (SCALE=${scale}, λ при цене 1000 ≈ ${demand(1000).toFixed(1)}/день) =====`);
    for (const strat of ['max_profit', 'max_revenue', 'max_units']) {
        _seed = 12345; // одинаковый сид на стратегию
        const tm = strat === 'max_units' ? 15 : undefined;
        const opt = trueOptimum(strat, tm);
        const sim = simulate(strat, { targetMargin: tm, cycles: 30 });
        const achieved = sim.converged != null ? metric(strat, sim.converged, demand(sim.converged), econ, tm) : 0;
        const valueGap = opt.value !== 0 ? (opt.value - achieved) / Math.abs(opt.value) * 100 : 0;
        console.log(`  ${strat.padEnd(12)} оптимум цена ${String(opt.price).padStart(4)} → движок ${String(Math.round(sim.converged)).padStart(4)} | разрыв по метрике ${valueGap.toFixed(1)}% (за ${sim.totalDays} дн)`);
    }
}
runScenario('НИЗКИЙ ОБЪЁМ', 1);
runScenario('ВЫСОКИЙ ОБЪЁМ', 6);
