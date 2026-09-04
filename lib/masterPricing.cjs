/**
 * Мастер-цена → производные цены по площадкам (юнит-тестируемая, без сети).
 *
 * Мастер-цена ≡ эталон (`ref_price`) изделия = целевая ЦЕНА ПОКУПАТЕЛЯ (цена со скидкой),
 * единая для всех магазинов группы (группировка по `offer_id`).
 * Из неё для каждого магазина выводится пара/тройка цен под правила площадки:
 *   - Ozon/Yandex: price = master; old_price (зачёркнутая) и min_price выводятся.
 *   - Wildberries: держим скидку продавца, двигаем базовую цену (см. lib/wbPricing.cjs),
 *     чтобы discountedPrice (цена покупателя) = master.
 */

const { computeOldPrice } = require('./priceHelpers.cjs');
const { computeWbPricePair, discountedFromPair } = require('./wbPricing.cjs');

/**
 * Выводит цену к отправке для одного магазина из мастер-цены.
 *
 * @param {number} masterPrice целевая цена покупателя (эталон), ₽
 * @param {{platform?:string}} store магазин (нужна platform)
 * @param {{offer_id:string, ozon_id?:number, wb_discount?:number, ref_min_price?:number, cost_price?:number}} product
 * @returns {{
 *   ok:boolean, reason?:string, platform:string, belowCost:boolean,
 *   update:object,            // payload для fetcher.updateProductPrices
 *   buyerPrice:number,        // фактическая цена покупателя (цена со скидкой)
 *   priceNoDiscount:number,   // цена без скидки (зачёркнутая/базовая)
 *   discountPercent:number    // скидка, %
 * }}
 */
function deriveStorePrice(masterPrice, store, product) {
    const master = Math.round(Number(masterPrice));
    const platform = store.platform || 'ozon';
    if (!(master > 0)) {
        return { ok: false, reason: 'bad_master', platform, belowCost: false };
    }
    const cost = Number(product.cost_price) || 0;
    const belowCost = cost > 0 && master < cost;

    if (platform === 'wildberries') {
        const pair = computeWbPricePair(master, product.wb_discount);
        const buyerPrice = Math.round(discountedFromPair(pair.price, pair.discount));
        const nmID = Number(product.ozon_id ?? product.offer_id);
        return {
            ok: true,
            platform,
            belowCost,
            update: {
                nmID,
                offer_id: product.offer_id,
                price: String(pair.price),
                discount: pair.discount,
            },
            buyerPrice,
            priceNoDiscount: pair.price,
            discountPercent: pair.discount,
        };
    }

    // Ozon / Yandex: master — это price (цена продавца ≈ цена покупателя без соинвеста площадки).
    const minPrice = Number(product.ref_min_price) > 0
        ? Math.round(Number(product.ref_min_price))
        : Math.round(master * 0.5);
    const oldPrice = computeOldPrice(master, minPrice);
    const discountPercent = oldPrice > 0 ? Math.round((1 - master / oldPrice) * 100) : 0;
    return {
        ok: true,
        platform,
        belowCost,
        update: {
            offer_id: product.offer_id,
            price: String(master),
            min_price: String(minPrice),
            old_price: String(oldPrice),
        },
        buyerPrice: master,
        priceNoDiscount: oldPrice,
        discountPercent,
    };
}

module.exports = { deriveStorePrice };
