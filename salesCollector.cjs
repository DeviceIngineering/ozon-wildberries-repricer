/**
 * Сбор истории продаж по площадкам в sales_daily (РФ2). См. docs/STRATEGIES.md.
 *
 * Платформо-агностичный оркестратор: вызывает fetchSales(store, from, to) у фетчера площадки
 * (возвращает [{ offer_id, date, units, revenue, price_buyer_est? }]), обогащает контекстом
 * (себестоимость, floor, промо/слив/стокаут → is_dirty_flag) и пишет append-only.
 *
 * is_dirty_flag=1 → день НЕ использовать для оценки спроса (промо, слив, стокаут) —
 * иначе всплеск от акции/слива примем за реакцию на цену.
 */
const db = require('./db.cjs');
const Sentry = require('./sentry.server.cjs');

function getFetcher(platform) {
    if (platform === 'yandex') return require('./yandexFetcher.cjs');
    if (platform === 'wildberries') return require('./wbFetcher.cjs');
    return require('./ozonFetcher.cjs');
}

function isoDate(d) { return d.toISOString().slice(0, 10); }

/**
 * Собрать продажи магазина за последние `days` дней и записать в sales_daily.
 * @returns {Promise<{ collected:number, dirty:number } | null>}
 */
async function collectStoreSales(storeId, { days = 1 } = {}) {
    const store = await db.getStoreById(storeId);
    if (!store) return null;
    const fetcher = getFetcher(store.platform);
    if (typeof fetcher.fetchSales !== 'function') {
        console.warn(`[SalesCollector] ${store.platform}: fetchSales не реализован — пропуск`);
        return null;
    }

    const to = new Date();
    const from = new Date(); from.setDate(from.getDate() - days);
    let raw;
    try {
        raw = await fetcher.fetchSales(store, isoDate(from), isoDate(to));
    } catch (e) {
        console.error(`[SalesCollector] store ${store.name}: ошибка fetchSales: ${e.message}`);
        Sentry.withScope(s => { s.setTag('operation', 'sales_collect'); s.setTag('store_id', storeId); Sentry.captureException(e); });
        return null;
    }
    if (!raw || raw.length === 0) return { collected: 0, dirty: 0 };

    // Контекст товаров для обогащения
    const products = await db.getStoreProducts(storeId);
    const byOffer = new Map(products.map(p => [p.offer_id, p]));

    let dirty = 0;
    const enriched = raw.map(r => {
        const p = byOffer.get(r.offer_id) || {};
        // День С продажами по определению «в наличии» (нельзя продать без остатка).
        // Стокаут-грязь применима только к дням без продаж (которых тут нет — fetchSales
        // возвращает только дни с продажами), поэтому units>0 → in_stock.
        const hadSales = (r.units || 0) > 0;
        const inStock = hadSales || (p.stocks_fbo || 0) > 0 || (p.stocks_fbs || 0) > 0;
        const promo = p.in_promo ? 1 : 0;
        const liquidation = p.liquidation_active ? 1 : 0;
        const stockout = inStock ? 0 : 1;
        const isDirty = (promo || liquidation || stockout) ? 1 : 0;
        if (isDirty) dirty++;
        const cost = p.cost_price != null ? parseFloat(p.cost_price) : null;
        const priceSeller = r.price_seller != null ? r.price_seller : (r.units > 0 ? r.revenue / r.units : null);
        return {
            product_id: p.product_id != null ? p.product_id : null,
            offer_id: r.offer_id,
            marketplace: store.platform,
            date: r.date,
            units: r.units || 0,
            revenue: r.revenue || 0,
            profit: (cost != null && r.units > 0) ? (r.revenue - cost * r.units) : null,
            price_seller: priceSeller,
            price_buyer_est: r.price_buyer_est != null ? r.price_buyer_est : null,
            cost_unit: cost,
            floor: p.floor_min_price != null ? parseFloat(p.floor_min_price) : null,
            promo_flag: promo,
            stock_qty: p.stocks_fbo != null ? p.stocks_fbo : null,
            in_stock_flag: inStock ? 1 : 0,
            spp_pct: r.spp_pct != null ? r.spp_pct : null,
            liquidation_flag: liquidation,
            is_dirty_flag: isDirty,
        };
    });

    db.upsertSalesDaily(storeId, enriched);
    return { collected: enriched.length, dirty };
}

/** Бэкфилл истории: собрать за N дней (на первом запуске). */
async function backfillStoreSales(storeId, days = 30) {
    return collectStoreSales(storeId, { days });
}

module.exports = { collectStoreSales, backfillStoreSales };
