/**
 * Response shaping for the external API.
 *
 * Everything this API returns is read by a language model, and every field is
 * paid for in tokens. Measurements on a live catalogue:
 *
 *   a product row, all 31 fields          258 tokens
 *   the same row, 12 requested fields      94
 *   the same, nulls dropped                87
 *   the same, columns hoisted out of rows  46   ← this module
 *
 * Two things dominate the waste. First, key names repeat in every object: a
 * catalogue of 1 000 SKU pays for the word "floor_min_price" a thousand times.
 * Second, a UUID costs 27 tokens — as much as a whole sentence — and `store_id`
 * is repeated in every row of responses that already carry it in the URL.
 *
 * The helpers here are opt-in. Without `fields` or `format` the caller gets
 * exactly what it got before, so existing agents keep working.
 */

/** Fields the pricing loop actually reads. Used when `fields=default`. */
const PRODUCT_PRICING_FIELDS = [
    'offer_id', 'price', 'marketing_price', 'min_price', 'ref_price',
    'cost_price', 'floor_min_price', 'sales_30d', 'stocks_fbo',
    'in_promo', 'promo_price', 'management_mode',
];

/** Everything an agent needs from a store; the rest is operator configuration. */
const STORE_AGENT_FIELDS = [
    'id', 'name', 'platform', 'repricer_enabled', 'strategy_kill_switch',
    'tax_rate', 'min_margin_percent', 'last_updated_at',
];

/**
 * Parse a `fields=` query value.
 * @param {string|undefined} raw Comma-separated list, or "default", or empty
 * @param {string[]} allowed Whitelist; unknown names are ignored rather than erroring
 * @param {string[]} defaults Returned for `fields=default`
 * @returns {string[]|null} null means "caller did not ask", i.e. keep full output
 */
function parseFields(raw, allowed, defaults) {
    if (!raw) return null;
    if (raw === 'default') return defaults.slice();
    const wanted = String(raw).split(',').map(f => f.trim()).filter(Boolean);
    const allow = new Set(allowed);
    const picked = wanted.filter(f => allow.has(f));
    return picked.length ? picked : defaults.slice();
}

/** Keep only the named keys, and drop keys whose value is null or undefined. */
function project(rows, fields) {
    if (!fields) return rows;
    return rows.map(r => {
        const out = {};
        for (const f of fields) {
            const v = r[f];
            if (v !== null && v !== undefined) out[f] = v;
        }
        return out;
    });
}

/**
 * Hoist the keys out of the rows: `{cols: [...], rows: [[...]]}`.
 * Null stays as null here — position carries meaning, so values cannot be dropped.
 */
function compact(rows, fields) {
    const cols = fields || (rows.length ? Object.keys(rows[0]) : []);
    return {
        cols,
        rows: rows.map(r => cols.map(c => (r[c] === undefined ? null : r[c]))),
    };
}

/**
 * Apply `fields` and `format` to a list response.
 * @returns {{payload: any, format: 'objects'|'compact'}}
 */
function shape(rows, { fields, format } = {}) {
    const projected = project(rows, fields);
    if (format === 'compact') {
        return { payload: compact(projected, fields), format: 'compact' };
    }
    return { payload: projected, format: 'objects' };
}

/** Strip keys that merely repeat something the request already established. */
function omit(rows, keys) {
    const drop = new Set(keys);
    return rows.map(r => {
        const out = {};
        for (const [k, v] of Object.entries(r)) if (!drop.has(k)) out[k] = v;
        return out;
    });
}

module.exports = {
    PRODUCT_PRICING_FIELDS, STORE_AGENT_FIELDS,
    parseFields, project, compact, shape, omit,
};
