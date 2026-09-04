/**
 * How far a price is allowed to move in a single run.
 *
 * Marketplaces punish sudden moves, and the punishment is silent: the price
 * simply does not apply, or the product drops out of search. Wildberries sends
 * an item to quarantine when the price falls by 1.5x or more — a threshold that
 * cost us a live incident before it was known, when the experiment engine tried
 * to drop a price straight to the floor, 40-50% in one step.
 *
 * The guard therefore walks: each run moves as far as the platform tolerates,
 * and the target is reached over several runs. Between runs the price is read
 * back from the marketplace, so the next step starts from what actually
 * applied rather than from what was sent.
 *
 * This module exists because the same rule used to live in three places —
 * twice for drops (repricer.cjs, strategyRunner.cjs) and once for raises, in a
 * Yandex-specific branch with a Yandex-specific setting name, even though the
 * idea is common to every marketplace.
 */

/**
 * Fall ratios that put a product in quarantine, per platform.
 *
 * Only Wildberries has a published, observed threshold. For the others the
 * guard is off by default rather than guessed: inventing a limit would either
 * do nothing or hold prices back for no reason. A seller who has measured one
 * can set it per store.
 */
const DEFAULT_DROP_RATIO = {
    wildberries: 1.5,
    ozon: null,
    yandex: null,
};

/** Rise per run, percent. Not a platform rule — a guard against losing buybox in one jump. */
const DEFAULT_RAISE_PCT = 20;

/** Step just inside the threshold, so a rounding error cannot land exactly on it. */
const RATIO_MARGIN = 0.05;

/**
 * Read the limits for a store, falling back to platform defaults.
 * `ym_floor_max_raise_percent` is honoured as the previous name of
 * `max_raise_percent` so existing installations keep their configuration.
 */
function limitsFor(store = {}) {
    const platform = store.platform || 'ozon';

    const rawDrop = store.max_drop_ratio;
    const dropRatio = rawDrop === null || rawDrop === undefined || rawDrop === ''
        ? DEFAULT_DROP_RATIO[platform] ?? null
        : parseFloat(rawDrop);

    const rawRaise = store.max_raise_percent ?? store.ym_floor_max_raise_percent;
    const raisePct = rawRaise === null || rawRaise === undefined || rawRaise === ''
        ? DEFAULT_RAISE_PCT
        : parseFloat(rawRaise);

    return {
        // A ratio at or below 1 would mean "never move down", which is not a
        // limit anyone wants; treat it as unset.
        dropRatio: Number.isFinite(dropRatio) && dropRatio > 1 ? dropRatio : null,
        raisePct: Number.isFinite(raisePct) && raisePct > 0 ? raisePct : null,
    };
}

/**
 * Cap one price move.
 *
 * @param {object}  p
 * @param {number}  p.current Price on the marketplace right now
 * @param {number}  p.target  Where we want to end up
 * @param {object} [p.store]  Store row: platform, max_drop_ratio, max_raise_percent
 * @param {number} [p.floor]  Break-even price; a capped step never lands below it
 * @returns {{applied: number, capped: boolean, direction: 'down'|'up'|'none', reason: string|null}}
 *   `applied` is what to send now. When `capped` is true the target is not yet
 *   reached and the next run should continue from the price that landed.
 */
function capStep({ current, target, store = {}, floor = null }) {
    const cur = Number(current);
    const tgt = Number(target);

    if (!Number.isFinite(cur) || cur <= 0 || !Number.isFinite(tgt) || tgt <= 0) {
        return { applied: tgt, capped: false, direction: 'none', reason: null };
    }
    if (tgt === cur) return { applied: tgt, capped: false, direction: 'none', reason: null };

    const { dropRatio, raisePct } = limitsFor(store);

    if (tgt < cur) {
        if (!dropRatio) return { applied: tgt, capped: false, direction: 'down', reason: null };
        const lowest = cur / dropRatio;
        if (tgt >= lowest) return { applied: tgt, capped: false, direction: 'down', reason: null };

        const stepped = Math.ceil(cur / (dropRatio - RATIO_MARGIN));
        // Never cap into a worse position than the target itself.
        const applied = Math.max(stepped, tgt);
        return {
            applied,
            capped: applied !== tgt,
            direction: 'down',
            reason: `шаг вниз ограничен до ${applied} (цель ${tgt}): падение более чем в ${dropRatio}× уводит товар в карантин`,
        };
    }

    if (!raisePct) return { applied: tgt, capped: false, direction: 'up', reason: null };
    const highest = Math.ceil(cur * (1 + raisePct / 100));
    if (tgt <= highest) return { applied: tgt, capped: false, direction: 'up', reason: null };

    let applied = highest;
    // A raise is usually a move towards the floor. Stopping short of it is the
    // point of walking, but overshooting it is not — clamp when floor is known.
    if (floor != null && Number.isFinite(Number(floor))) applied = Math.min(applied, Math.ceil(Number(floor)));
    applied = Math.max(applied, cur);

    return {
        applied,
        capped: applied !== tgt,
        direction: 'up',
        reason: applied !== tgt
            ? `шаг вверх ограничен до ${applied} (цель ${tgt}): не поднимаем больше ${raisePct}% за прогон`
            : null,
    };
}

module.exports = {
    capStep, limitsFor,
    DEFAULT_DROP_RATIO, DEFAULT_RAISE_PCT, RATIO_MARGIN,
};
