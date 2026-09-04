/**
 * Движок ценовых стратегий (чистая логика, без сети/БД). См. docs/STRATEGIES.md.
 *
 * Вход: состояние эксперимента по SKU + наблюдения продаж на текущей цене + юнит-экономика + границы.
 * Выход: решение (hold / step / rollback / converged / liquidate) и следующая целевая цена.
 *
 * Подход: within-SKU ladder + Gamma-Poisson байес + event-based стоп + гистерезис.
 * Решение по апостериорной метрике на риск-аверсной λ (нижний перцентиль).
 */
const { posteriorRate } = require('./bayesPoisson.cjs');

const STRATEGIES = ['ref_price', 'max_profit', 'max_revenue', 'max_units', 'liquidation'];

const round2 = (x) => Math.round(x * 100) / 100;
const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

/**
 * Прибыль с единицы при цене price (модель WB/общая): из цены вычитаем процентные
 * удержания (комиссия+эквайринг+налог) и абсолютные (логистика), затем себестоимость.
 * econ = { cost, commissionPct, acquiringPct=1.5, taxPct=0, logistics=0 }
 */
function unitProfit(price, econ) {
    const pctSum = (econ.commissionPct || 0) + (econ.acquiringPct != null ? econ.acquiringPct : 1.5) + (econ.taxPct || 0);
    return price * (1 - pctSum / 100) - (econ.logistics || 0) - (econ.cost || 0);
}

/** Рентабельность (маржа на себестоимость), %. */
function marginPct(price, econ) {
    if (!econ.cost || econ.cost <= 0) return null;
    return unitProfit(price, econ) / econ.cost * 100;
}

/**
 * Значение целевой метрики стратегии при цене price и оценке спроса lambda (шт/день).
 * targetMargin — для max_units (требование минимальной рентабельности).
 * Возвращает число (больше = лучше) или -Infinity если цена недопустима для стратегии.
 */
function metric(strategy, price, lambda, econ, targetMargin) {
    switch (strategy) {
        case 'max_revenue':       // макс выручки = цена × штуки
            return price * lambda;
        case 'max_profit':        // макс прибыли = прибыль/ед × штуки
            return unitProfit(price, econ) * lambda;
        case 'max_units': {       // макс штук при марже ≥ целевой
            const mp = marginPct(price, econ);
            if (mp == null || (targetMargin != null && mp < targetMargin)) return -Infinity;
            return lambda;
        }
        default:
            return -Infinity;
    }
}

/**
 * Нижняя граница цены: для обычных стратегий — floor (безубыточность);
 * для liquidation — себестоимость, уменьшенная на допустимый минус (можно ниже себестоимости).
 */
function lowerBound({ strategy, floor, econ, liquidationMaxLossPct }) {
    if (strategy === 'liquidation' && econ && econ.cost > 0) {
        const loss = (liquidationMaxLossPct || 0) / 100;
        // нетто-выручка с единицы = себестоимость − допустимый_минус (можем уйти в минус на loss·cost)
        const targetNet = econ.cost * (1 - loss);
        // решаем unitProfit(price) = targetNet − cost  → price·(1−pct) − logistics = targetNet
        const pctSum = (econ.commissionPct || 0) + (econ.acquiringPct != null ? econ.acquiringPct : 1.5) + (econ.taxPct || 0);
        const price = (targetNet + (econ.logistics || 0)) / (1 - pctSum / 100);
        return Math.max(1, Math.ceil(price));
    }
    return floor;
}

/**
 * Главное решение ladder.
 * @param {object} state  состояние эксперимента: { current_price, step_percent, direction, best_price, best_metric, bad_steps }
 * @param {object} obs    наблюдения на текущей цене: { units, days }
 * @param {object} econ   юнит-экономика { cost, commissionPct, acquiringPct, taxPct, logistics }
 * @param {object} opts   { strategy, floor, ceiling, targetMargin, liquidationMaxLossPct,
 *                          nMin=12, tMax=14, deltaHysteresis=0.05, riskQuantile=0.25, minStepPct=3, prior }
 * @returns {{ action, nextPrice, direction, stepPercent, bestPrice, bestMetric, badSteps, metric, lambda, reason }}
 */
function decide(state, obs, econ, opts) {
    const {
        strategy, floor, ceiling, targetMargin, liquidationMaxLossPct,
        nMin = 12, tMax = 14, minDays = 3, deltaHysteresis = 0.05, riskQuantile = 0.25, minStepPct = 3,
        // Слабый приор: при малом days не должен перетягивать оценку λ (иначе низкоценовые
        // точки с быстрым накоплением продаж недооцениваются → движок избегает низких цен).
        prior = { alpha: 0.5, beta: 0.5 },
    } = opts;

    const lo = lowerBound({ strategy, floor, econ, liquidationMaxLossPct });
    const hi = ceiling != null ? ceiling : (state.current_price || lo);

    // Слив — без эксперимента: просто опускаем цену до допустимого минимума (lo) и помечаем дни грязными.
    if (strategy === 'liquidation') {
        return { action: 'liquidate', nextPrice: round2(Math.max(1, lo)), reason: `Слив: цена опущена до минимума (допуст. минус ${liquidationMaxLossPct || 0}%)` };
    }

    if (lo >= hi) {
        return { action: 'no_room', nextPrice: round2(clamp(state.current_price, lo, hi)), reason: `Нет коридора: нижняя ${lo} ≥ верхняя ${hi}` };
    }

    // Event-based стоп: держим цену, пока не накопится сигнал.
    // Нужны И продажи (≥nMin), И минимум дней (≥minDays) для стабильной оценки λ — иначе
    // при низкой цене продажи копятся за 1 день и оценка λ нестабильна. Потолок — tMax дней.
    const u = obs.units || 0, dy = obs.days || 0;
    const enough = (u >= nMin && dy >= minDays) || dy >= tMax;
    if (!enough) {
        return { action: 'hold', reason: `Копим сигнал: ${u}/${nMin} продаж, ${dy}/${minDays}..${tMax} дн` };
    }

    // Сигнал накоплен → апостериорная риск-аверсная оценка λ и метрика на текущей цене.
    const rate = posteriorRate({ units: obs.units || 0, days: obs.days || 1 }, prior, { quantile: riskQuantile });
    const lambda = rate.pLo; // риск-аверсия: нижний перцентиль
    const m = metric(strategy, state.current_price, lambda, econ, targetMargin);

    // === Фаза первичного скана: зондируем сетку цен по коридору, чтобы бракетить оптимум ===
    // (простой ladder из одной точки при низком объёме не доходит до далёкого оптимума).
    const scanPoints = opts.scanPoints != null ? opts.scanPoints : 4;
    const phase = state.phase || (scanPoints >= 2 ? 'scan' : 'ladder');
    if (phase === 'scan') {
        const grid = state.scan_grid || Array.from({ length: scanPoints }, (_, i) =>
            round2(lo + (hi - lo) * i / (scanPoints - 1)));
        const idx = state.scan_idx == null ? -1 : state.scan_idx; // -1 = старт ещё не на сетке
        const scan = [...(state.scan || []), { price: state.current_price, metric: m }];
        if (idx + 1 < grid.length) {
            return { action: 'scan', nextPrice: grid[idx + 1], phase: 'scan', scan, scan_grid: grid, scan_idx: idx + 1, metric: m, lambda, reason: `Скан коридора ${idx + 2}/${grid.length} (цена ${grid[idx + 1]})` };
        }
        // Скан завершён → лучшая точка становится стартом ladder.
        const best = scan.reduce((a, b) => (b.metric > a.metric ? b : a), scan[0]);
        return { action: 'scan_done', nextPrice: best.price, phase: 'ladder', bestPrice: best.price, bestMetric: best.metric, badSteps: 0, scan, metric: m, lambda, reason: `Скан завершён, оптимум-бракет ${best.price}, переход к ladder` };
    }

    const step = state.step_percent || 8;
    const initialDir = state.direction || -1; // по умолчанию пробуем вниз (ниже цена → больше штук)

    // Первый замер или улучшение с запасом (гистерезис) — фиксируем лучшее, шагаем дальше в ту же сторону.
    if (state.best_metric == null || m > state.best_metric * (1 + deltaHysteresis)) {
        let next = state.current_price * (1 + initialDir * step / 100);
        next = clamp(next, lo, hi);
        // Если упёрлись в границу и не сдвинулись — считаем сошедшимися.
        if (Math.abs(next - state.current_price) < 0.01) {
            return { action: 'converged', nextPrice: round2(state.current_price), bestPrice: round2(state.current_price), bestMetric: m, metric: m, lambda, reason: 'Достигли границы коридора — оптимум на границе' };
        }
        return {
            action: 'step', nextPrice: round2(next), direction: initialDir,
            bestPrice: round2(state.current_price), bestMetric: m, badSteps: 0, metric: m, lambda,
            reason: `Улучшение (метрика ${m.toFixed(2)}), шаг ${initialDir > 0 ? 'вверх' : 'вниз'} ${step}%`,
        };
    }

    // Хуже лучшего.
    const bad = (state.bad_steps || 0) + 1;
    if (bad >= 2) {
        const newStep = Math.max(minStepPct, step / 2);
        return {
            action: 'rollback', nextPrice: round2(state.best_price), stepPercent: newStep,
            bestPrice: round2(state.best_price), bestMetric: state.best_metric, badSteps: 0, metric: m, lambda,
            reason: `2 плохих замера подряд → откат к лучшей цене ${state.best_price}, шаг уменьшен до ${newStep}%`,
        };
    }
    // Разворот от лучшей точки.
    const dir = -initialDir;
    let next = clamp(state.best_price * (1 + dir * step / 100), lo, hi);
    return {
        action: 'step', nextPrice: round2(next), direction: dir, badSteps: bad,
        bestPrice: round2(state.best_price), bestMetric: state.best_metric, metric: m, lambda,
        reason: `Хуже лучшего → разворот, шаг ${dir > 0 ? 'вверх' : 'вниз'}`,
    };
}

module.exports = { STRATEGIES, unitProfit, marginPct, metric, lowerBound, decide, round2, clamp };
