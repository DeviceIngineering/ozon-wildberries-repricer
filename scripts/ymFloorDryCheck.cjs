/**
 * READ-ONLY проверка floor для магазина Яндекс.Маркета.
 * Считает floor по новой формуле (налог-gross + boost + удержания) на РЕАЛЬНЫХ данных
 * и печатает таблицу — НИЧЕГО не записывает в Маркет (ни цены, ни вывод из акций).
 *
 * Запуск:  node scripts/ymFloorDryCheck.cjs "My Yandex Store"
 *          node scripts/ymFloorDryCheck.cjs 7            (по id магазина)
 */
const db = require('../db.cjs');
const ymFetcher = require('../yandexFetcher.cjs');
const { computeYmFloor, computeYmSellerPayout } = require('../lib/ymFloor.cjs');

async function main() {
    const arg = process.argv[2];
    if (!arg) { console.error('Укажите имя или id магазина'); process.exit(1); }

    const stores = await db.getAllStores();
    const store = stores.find(s => String(s.id) === String(arg) || s.name === arg);
    if (!store) { console.error('Магазин не найден:', arg); process.exit(1); }
    if (store.platform !== 'yandex') { console.error('Не YM-магазин:', store.platform); process.exit(1); }

    const taxRate = parseFloat(store.tax_rate) || 0;
    const marginPct = parseFloat(store.min_margin_percent) || 0;
    const boostCap = store.ym_boost_cap_percent != null ? parseFloat(store.ym_boost_cap_percent) : 30;
    console.log(`\n=== ${store.name} | налог ${taxRate}% | маржа ${marginPct}% | потолок буста ${boostCap}% ===\n`);

    const products = (await db.getStoreProducts(store.id)).filter(p => p.cost_price > 0 && p.ym_category_id);
    if (products.length === 0) { console.error('Нет товаров с cost_price и ym_category_id (сделайте Sync)'); process.exit(1); }

    const offerIds = products.map(p => p.offer_id);
    const { priceMap } = await ymFetcher.fetchPrices(store.ym_campaign_id, store.ym_api_key, offerIds, store.id);

    const candidates = products.map(p => {
        const dims = p.ym_dims || {};
        const live = priceMap.get(p.offer_id)?.price;
        return {
            offerId: p.offer_id, categoryId: p.ym_category_id,
            price: (live > 0 ? live : parseFloat(p.price)) || 0,
            length: dims.length, width: dims.width, height: dims.height, weight: dims.weight,
            costPrice: parseFloat(p.cost_price),
        };
    }).filter(c => c.price > 0);

    const { tariffMap } = await ymFetcher.fetchTariffs(store.ym_campaign_id, store.ym_api_key, candidates, store.id);
    const sold = await ymFetcher.fetchOrdersEconomics(store.ym_campaign_id, store.ym_api_key, store.id, 7);
    const boostByOffer = ymFetcher.aggregateBoostByOffer(sold, { minUnits: 3 });

    let breaches = 0, withBoost = 0;
    const rows = [];
    for (const c of candidates) {
        const fees = tariffMap.get(c.offerId);
        if (!fees) continue;
        const rawBoost = boostByOffer.get(c.offerId);
        const boostPct = rawBoost ? Math.min(rawBoost.boostPct, boostCap) : 0;
        if (boostPct > 0) withBoost++;
        const floorNew = computeYmFloor({ costPrice: c.costPrice, pctFees: fees.percentSum, absFees: fees.absoluteSum, taxPercent: taxRate, boostPercent: boostPct, marginPercent: marginPct });
        // старая формула для сравнения
        const beforeTax = c.costPrice * (1 + marginPct / 100) / (1 - taxRate / 100);
        const floorOld = fees.percentSum >= 95 ? null : Math.ceil((beforeTax + fees.absoluteSum) / (1 - fees.percentSum / 100));
        const breach = floorNew && c.price < floorNew;
        if (breach) breaches++;
        rows.push({ offerId: c.offerId, price: c.price, floorOld, floorNew, pct: fees.percentSum.toFixed(1), abs: Math.round(fees.absoluteSum), boost: boostPct.toFixed(1), breach });
    }

    rows.sort((a, b) => (b.breach - a.breach) || ((b.floorNew - b.price) - (a.floorNew - a.price)));
    console.log('offerId           price   floorOld floorNew  удерж%  абс₽  буст%  ниже?');
    for (const r of rows.slice(0, 40)) {
        console.log(
            r.offerId.padEnd(16).slice(0, 16),
            String(r.price).padStart(7), String(r.floorOld ?? '—').padStart(8), String(r.floorNew ?? '—').padStart(8),
            String(r.pct).padStart(6), String(r.abs).padStart(5), String(r.boost).padStart(6), r.breach ? '  ⚠️МИНУС' : ''
        );
    }

    // фактическая выплата по продажам
    let lossSales = 0;
    for (const it of sold) {
        const fees = tariffMap.get(it.offerId);
        const prod = candidates.find(c => c.offerId === it.offerId);
        if (!fees || !prod || it.sellerPrice == null) continue;
        const net = prod.costPrice * (1 + marginPct / 100);
        const payout = computeYmSellerPayout({ sellerPrice: it.sellerPrice, pctFees: fees.percentSum, absFees: fees.absoluteSum, taxPercent: taxRate, boostAmount: (it.bidFee || 0) / (it.count || 1) });
        if (payout < net) lossSales++;
    }

    console.log(`\nИТОГО: товаров ${rows.length}, ниже floor ${breaches}, с бустом ${withBoost}, ` +
        `продаж за 7д ${sold.length}, из них в минус по выплате ${lossSales}.`);
    console.log('(read-only — ничего не записано)\n');
    process.exit(0);
}

main().catch(e => { console.error('Ошибка:', e.message); process.exit(1); });
