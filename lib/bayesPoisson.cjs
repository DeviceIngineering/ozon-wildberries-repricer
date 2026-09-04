/**
 * Байесовская оценка интенсивности продаж (Gamma-Poisson), чистая математика без сети.
 * См. docs/STRATEGIES.md. Используется движком стратегий для риск-аверсного решения
 * при малых выборках: вместо сырого числа продаж берём апостериорную оценку λ (шт/день)
 * и её нижний перцентиль (широкий апостериор у малых выборок → низкая нижняя граница → не выбираем сгоряча).
 */

// Обратная функция стандартного нормального распределения (аппроксимация Acklam).
function normInv(p) {
    if (p <= 0) return -Infinity;
    if (p >= 1) return Infinity;
    const a = [-3.969683028665376e+01, 2.209460984245205e+02, -2.759285104469687e+02, 1.383577518672690e+02, -3.066479806614716e+01, 2.506628277459239e+00];
    const b = [-5.447609879822406e+01, 1.615858368580409e+02, -1.556989798598866e+02, 6.680131188771972e+01, -1.328068155288572e+01];
    const c = [-7.784894002430293e-03, -3.223964580411365e-01, -2.400758277161838e+00, -2.549732539343734e+00, 4.374664141464968e+00, 2.938163982698783e+00];
    const d = [7.784695709041462e-03, 3.224671290700398e-01, 2.445134137142996e+00, 3.754408661907416e+00];
    const plow = 0.02425, phigh = 1 - plow;
    let q, r;
    if (p < plow) {
        q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    } else if (p <= phigh) {
        q = p - 0.5; r = q * q;
        return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
            (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
    } else {
        q = Math.sqrt(-2 * Math.log(1 - p));
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
}

/**
 * Апостериор Gamma после наблюдения units продаж за days дней.
 * Сопряжённость: Poisson-правдоподобие × Gamma(α0, β0)-приор = Gamma(α0+units, β0+days).
 * α0/β0 — слабый приор (по умолчанию среднее ~0.5 шт/день, малый вес).
 */
function gammaPosterior({ units = 0, days = 0 }, prior = { alpha: 1, beta: 2 }) {
    const alpha = (prior.alpha || 1) + Math.max(0, units);
    const beta = (prior.beta || 2) + Math.max(0, days);
    return { alpha, beta, mean: alpha / beta, variance: alpha / (beta * beta) };
}

/**
 * Квантиль распределения Gamma(shape=alpha, rate=beta) через приближение Wilson–Hilferty.
 * Для X~Gamma(a, rate=b): X ≈ (a/b)·(1 − 1/(9a) + z_p·√(1/(9a)))³.
 */
function gammaQuantile(alpha, beta, p) {
    if (alpha <= 0 || beta <= 0) return 0;
    const z = normInv(p);
    const t = 1 - 1 / (9 * alpha) + z * Math.sqrt(1 / (9 * alpha));
    const x = (alpha / beta) * Math.pow(Math.max(0, t), 3);
    return Math.max(0, x);
}

/**
 * Оценка интенсивности продаж λ (шт/день) с риск-аверсной нижней границей.
 * @returns {{ mean:number, p25:number, pLo:number }}
 */
function posteriorRate({ units = 0, days = 0 }, prior = { alpha: 1, beta: 2 }, opts = {}) {
    const post = gammaPosterior({ units, days }, prior);
    const qLo = opts.quantile != null ? opts.quantile : 0.25;
    return {
        mean: post.mean,
        p25: gammaQuantile(post.alpha, post.beta, 0.25),
        pLo: gammaQuantile(post.alpha, post.beta, qLo),
        alpha: post.alpha,
        beta: post.beta,
    };
}

module.exports = { normInv, gammaPosterior, gammaQuantile, posteriorRate };
