const { createYandexClient } = require('./lib/yandexClient.cjs');
const db = require('./db.cjs');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Получить список товаров из Yandex Market через offer-mappings.
 * archived=true — отдельный запрос для архивных товаров.
 */
async function fetchProducts(businessId, apiKey, storeId, archived = false) {
    const client = createYandexClient(apiKey, { source: 'sync', storeId });
    const allProducts = [];
    let pageToken = undefined;
    let pageNum = 0;

    while (true) {
        try {
            pageNum++;
            const params = { limit: 200 };
            if (pageToken) params.pageToken = pageToken;

            const body = archived ? { archived: true } : {};
            const response = await client.post(
                `/v2/businesses/${businessId}/offer-mappings`,
                body,
                {
                    params,
                    metadata: { itemsCount: 200, summary: `offer-mappings${archived ? ' archived' : ''} page ${pageNum}` }
                }
            );

            const result = response.data.result || response.data;
            const offerMappings = result.offerMappings || [];

            for (const offerMapping of offerMappings) {
                const offer = offerMapping.offer || {};
                const basicPrice = offer.basicPrice || {};

                // Определяем ошибку через наличие маппинга в ответе API:
                // approved/awaiting → товар активен; rejected/отсутствует → ошибка
                const hasApproved = !!(offerMapping.mapping?.marketSku || offerMapping.mapping?.categoryId);
                const hasAwaiting = !!(offerMapping.awaitingModerationMapping?.marketSku || offerMapping.awaitingModerationMapping?.categoryId);
                const hasRejected = !!(offerMapping.rejectedMapping?.marketSku || offerMapping.rejectedMapping?.categoryId);
                const isError = hasRejected || (!hasApproved && !hasAwaiting);

                allProducts.push({
                    offer_id: offer.offerId || '',
                    name: offer.name || '',
                    product_id: offer.offerId || '',
                    price: basicPrice.value || 0,
                    old_price: basicPrice.discountBase || 0,
                    currency_code: basicPrice.currencyId || 'RUR',
                    purchasePrice: offer.purchasePrice?.value || null,
                    isError,
                    // Превью для UI: первая картинка товара из offer.pictures
                    primary_image: (Array.isArray(offer.pictures) && offer.pictures.length) ? offer.pictures[0] : null,
                    // Для расчёта тарифов (floor): категория Маркета и габариты
                    ym_category_id: offerMapping.mapping?.marketCategoryId || null,
                    ym_dims: offer.weightDimensions || null,
                });
            }

            const paging = result.paging || {};
            pageToken = paging.nextPageToken || null;
            if (!pageToken || offerMappings.length === 0) break;

            await sleep(300);
        } catch (error) {
            console.error('Error fetching YM offer-mappings:', error.response?.status, error.message);
            throw error;
        }
    }

    return allProducts;
}

/**
 * Получить offer IDs товаров в карантине цен.
 * Карантин = Yandex заблокировал цену как слишком высокую/низкую.
 * Возвращает { ids, error } — ошибка НЕ маскируется пустым Set
 * (пустой Set при ошибке неотличим от «карантин пуст» — паттерн инцидента с 405).
 */
async function fetchQuarantineOfferIds(campaignId, apiKey, storeId) {
    if (!campaignId) return { ids: new Set(), error: null };
    const client = createYandexClient(apiKey, { source: 'sync', storeId });
    const ids = new Set();
    let pageToken = undefined;
    let pageNum = 0;
    try {
        while (true) {
            pageNum++;
            const params = { limit: 200 };
            if (pageToken) params.page_token = pageToken;

            // Endpoint требует POST с телом-фильтром (GET возвращает 405)
            const response = await client.post(
                `/v2/campaigns/${campaignId}/price-quarantine`,
                {},
                { params, metadata: { summary: `price-quarantine page ${pageNum}` } }
            );
            const result = response.data.result || response.data;
            const offers = result.offers || [];
            for (const o of offers) {
                if (o.offerId) ids.add(o.offerId);
            }

            const paging = result.paging || {};
            pageToken = paging.nextPageToken || null;
            if (!pageToken || offers.length === 0) break;

            await sleep(300);
        }
    } catch (e) {
        const errMsg = `HTTP ${e.response?.status || 'network'}: ${e.message} (page ${pageNum})`;
        console.error('[YM] Could not fetch quarantine:', errMsg);
        return { ids, error: errMsg };
    }
    return { ids, error: null };
}

/**
 * Получить offer IDs товаров «Можно улучшить».
 * Endpoint: POST /businesses/{businessId}/offer-cards
 * Body: { contentRatingStatuses: ["CAN_BE_IMPROVED"] } — серверный фильтр, клиентская фильтрация не нужна.
 * Возвращает { ids, error } — обрыв пагинации фиксируется маркером, а не молчаливым break.
 */
async function fetchCanImproveOfferIds(businessId, apiKey, storeId) {
    const client = createYandexClient(apiKey, { source: 'sync', storeId });
    const ids = new Set();
    let pageToken = undefined;
    let pageNum = 0;

    while (true) {
        try {
            pageNum++;
            const params = { limit: 200 };
            if (pageToken) params.page_token = pageToken;

            const response = await client.post(
                `/v2/businesses/${businessId}/offer-cards`,
                { contentRatingStatuses: ['CAN_BE_IMPROVED'] },
                { params, metadata: { summary: `offer-cards can_improve page ${pageNum}` } }
            );

            const result = response.data.result || response.data;
            const offerCards = result.offerCards || [];

            for (const card of offerCards) {
                if (card.offerId) ids.add(card.offerId);
            }

            const paging = result.paging || {};
            pageToken = paging.nextPageToken || null;
            if (!pageToken || offerCards.length === 0) break;

            await sleep(300);
        } catch (e) {
            const errMsg = `HTTP ${e.response?.status || 'network'}: ${e.message} (page ${pageNum})`;
            console.error('[YM] fetchCanImproveOfferIds failed:', errMsg);
            return { ids, error: errMsg };
        }
    }
    return { ids, error: null };
}

/**
 * Получить цены для списка офферов через campaign endpoint.
 * Возвращает { priceMap, failedBatches } — частичные данные помечаются явно,
 * чтобы вызывающий код не принял неполный priceMap за полный.
 */
async function fetchPrices(campaignId, apiKey, offerIds, storeId) {
    const client = createYandexClient(apiKey, { source: 'sync', storeId });
    const priceMap = new Map();
    const BATCH_SIZE = 500;
    const totalBatches = Math.ceil(offerIds.length / BATCH_SIZE);
    let failedBatches = 0;

    for (let i = 0; i < offerIds.length; i += BATCH_SIZE) {
        const batchIds = offerIds.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        try {
            const response = await client.post(
                `/v2/campaigns/${campaignId}/offer-prices`,
                { offerIds: batchIds },
                { metadata: { itemsCount: batchIds.length, summary: `prices batch ${batchNum}` } }
            );

            const result = response.data.result || response.data;
            const offers = result.offers || [];

            for (const offer of offers) {
                const priceInfo = offer.price || {};
                priceMap.set(offer.offerId, {
                    price: priceInfo.value || 0,
                    discountBase: priceInfo.discountBase || 0,
                    currencyId: priceInfo.currencyId || 'RUR',
                });
            }

            if (i + BATCH_SIZE < offerIds.length) await sleep(500);
        } catch (error) {
            failedBatches++;
            console.error(`[YM] Error fetching prices batch ${batchNum}/${totalBatches} (${batchIds.length} offers):`, error.response?.status, error.message);
        }
    }

    return { priceMap, failedBatches };
}

/**
 * Расчёт удержаний YM по товарам через tariffs/calculate.
 *
 * items: [{ offerId, categoryId, price, length, width, height, weight }]
 * Возвращает Map offerId → { percentSum, absoluteSum } — сумма процентных
 * (FEE, PAYMENT_TRANSFER, DELIVERY_TO_CUSTOMER...) и абсолютных (MIDDLE_MILE,
 * SORTING...) удержаний. Природа тарифа определяется по valueType параметров.
 */
async function fetchTariffs(campaignId, apiKey, items, storeId) {
    const client = createYandexClient(apiKey, { source: 'repricer', storeId });
    const result = new Map();
    const BATCH = 150;
    let failedBatches = 0;

    for (let i = 0; i < items.length; i += BATCH) {
        const batch = items.filter(it => it.categoryId && it.price > 0).slice(i, i + BATCH);
        if (batch.length === 0) continue;
        try {
            const r = await client.post('/v2/tariffs/calculate', {
                parameters: { campaignId: Number(campaignId), frequency: 'DAILY' },
                offers: batch.map(it => ({
                    categoryId: it.categoryId,
                    price: it.price,
                    length: it.length || 10,
                    width: it.width || 10,
                    height: it.height || 5,
                    weight: it.weight || 0.2,
                    quantity: 1,
                })),
            }, { metadata: { itemsCount: batch.length, summary: `tariffs batch ${Math.floor(i / BATCH) + 1}` } });

            const offers = r.data.result?.offers || [];
            // Ответ в порядке запроса — сопоставляем по индексу
            offers.forEach((o, idx) => {
                let percentSum = 0, absoluteSum = 0;
                for (const t of (o.tariffs || [])) {
                    const params = Object.fromEntries((t.parameters || []).map(p => [p.name, p.value]));
                    if (params.valueType === 'relative') percentSum += parseFloat(params.value || 0);
                    else absoluteSum += parseFloat(t.amount || 0);
                }
                result.set(batch[idx].offerId, { percentSum, absoluteSum });
            });
            await sleep(500);
        } catch (e) {
            failedBatches++;
            console.error(`[YM] tariffs/calculate batch failed:`, e.response?.status, JSON.stringify(e.response?.data?.errors || e.message).slice(0, 200));
        }
    }
    return { tariffMap: result, failedBatches };
}

/**
 * Обновить БАЗОВЫЕ цены кабинета (business-level) с minimumForBestseller —
 * минимальной ценой, ниже которой Маркет не может опускать товар в авто-акциях.
 * Главная защита от автоучастия в акциях себе в убыток.
 */
async function updateBusinessPrices(businessId, apiKey, updates, storeId, source = 'repricer-floor') {
    const client = createYandexClient(apiKey, { source, storeId });
    const BATCH_SIZE = 500;
    const results = [];
    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
        const batch = updates.slice(i, i + BATCH_SIZE);
        const offers = batch.map(u => {
            const price = {
                value: u.price,
                currencyId: 'RUR',
            };
            if (u.discountBase) price.discountBase = u.discountBase;
            if (u.minimumForBestseller) price.minimumForBestseller = u.minimumForBestseller;
            return { offerId: u.offerId, price };
        });
        const r = await client.post(
            `/v2/businesses/${businessId}/offer-prices/updates`,
            { offers },
            { metadata: { itemsCount: offers.length, summary: `business prices+minForBestseller ${offers.length}` } }
        );
        results.push(r.data);
        if (i + BATCH_SIZE < updates.length) await sleep(700);
    }
    return results;
}

/**
 * Товары, участвующие в акциях Маркета прямо сейчас (включая автодобавленные).
 * Возвращает Map offerId → { promoId, promoName, status } для статусов участия.
 */
async function fetchPromoParticipation(businessId, apiKey, storeId) {
    const client = createYandexClient(apiKey, { source: 'sync', storeId });
    const participating = new Map();
    let promos = [];
    try {
        const r = await client.post(
            `/v2/businesses/${businessId}/promos`,
            { participation: 'PARTICIPATING_NOW' },
            { metadata: { summary: 'promos participating-now' } }
        );
        promos = r.data.result?.promos || [];
    } catch (e) {
        return { participating, error: `promos: HTTP ${e.response?.status || 'network'} ${e.message}` };
    }

    for (const promo of promos) {
        let pageToken;
        try {
            do {
                const params = { limit: 500 };
                if (pageToken) params.page_token = pageToken;
                const r = await client.post(
                    `/v2/businesses/${businessId}/promos/offers`,
                    { promoId: promo.id },
                    { params, metadata: { summary: `promo offers ${promo.id}` } }
                );
                const offers = r.data.result?.offers || [];
                for (const o of offers) {
                    // Участвует: статус AUTO / PARTIALLY_AUTO / MANUAL (не NOT_PARTICIPATING)
                    const st = o.status || '';
                    if (st && st !== 'NOT_PARTICIPATING') {
                        participating.set(o.offerId, { promoId: promo.id, promoName: promo.name || '', status: st });
                    }
                }
                pageToken = r.data.result?.paging?.nextPageToken;
                await sleep(400);
            } while (pageToken);
        } catch (e) {
            return { participating, error: `promos/offers ${promo.id}: HTTP ${e.response?.status || 'network'} ${e.message}` };
        }
    }
    return { participating, error: null };
}

/**
 * Вывод товаров из акции Маркета (отказ от участия).
 * Группирует офферы по promoId и шлёт DELETE-запросы пачками ≤500.
 * Изменения у Маркета применяются в течение 4–6 часов.
 *
 * @param {string} businessId
 * @param {string} apiKey
 * @param {Array<{offerId:string, promoId:string}>} items офферы с их акцией
 * @param {number} storeId
 * @returns {{removed:number, byPromo:Object, errors:Array}}
 */
async function removeFromPromo(businessId, apiKey, items, storeId) {
    const client = createYandexClient(apiKey, { source: 'promo-exit', storeId });
    const byPromo = new Map();
    for (const it of (items || [])) {
        if (!it.offerId || !it.promoId) continue;
        if (!byPromo.has(it.promoId)) byPromo.set(it.promoId, new Set());
        byPromo.get(it.promoId).add(it.offerId);
    }
    let removed = 0;
    const errors = [];
    const byPromoCount = {};
    for (const [promoId, offerSet] of byPromo) {
        const offerIds = [...offerSet];
        for (let i = 0; i < offerIds.length; i += 500) {
            const batch = offerIds.slice(i, i + 500);
            try {
                await client.post(
                    `/v2/businesses/${businessId}/promos/offers/delete`,
                    { promoId, offerIds: batch },
                    { metadata: { itemsCount: batch.length, summary: `promo/delete ${promoId} ×${batch.length}` } }
                );
                removed += batch.length;
                byPromoCount[promoId] = (byPromoCount[promoId] || 0) + batch.length;
                await sleep(500);
            } catch (e) {
                errors.push(`promo ${promoId}: HTTP ${e.response?.status || 'network'} ${e.message}`);
            }
        }
    }
    return { removed, byPromo: byPromoCount, errors };
}

/**
 * Сводка по фактическим заказам за период: реальная цена покупателя vs цена
 * продавца, буст продаж. Для контроля «торговли в минус».
 */
async function fetchOrdersEconomics(campaignId, apiKey, storeId, days = 7) {
    const client = createYandexClient(apiKey, { source: 'repricer', storeId });
    const dateTo = new Date().toISOString().slice(0, 10);
    const dateFrom = new Date(Date.now() - days * 86400 * 1000).toISOString().slice(0, 10);
    const items = [];
    let pageToken;
    do {
        const params = { limit: 200 };
        if (pageToken) params.page_token = pageToken;
        const r = await client.post(
            `/v2/campaigns/${campaignId}/stats/orders`,
            { dateFrom, dateTo, statuses: ['DELIVERED', 'DELIVERY', 'PROCESSING', 'PICKUP'] },
            { params, metadata: { summary: `stats/orders ${dateFrom}..${dateTo}` } }
        );
        for (const o of (r.data.result?.orders || [])) {
            for (const it of (o.items || [])) {
                const market = (it.prices || []).find(p => p.type === 'MARKETPLACE');
                const buyer = (it.prices || []).find(p => p.type === 'BUYER');
                items.push({
                    orderId: o.id,
                    offerId: it.shopSku,
                    count: it.count || 1,
                    sellerPrice: market ? market.costPerItem : null,
                    buyerPrice: buyer ? buyer.costPerItem : null,
                    bidFee: it.bidFee || 0,
                });
            }
        }
        pageToken = r.data.result?.paging?.nextPageToken;
        await sleep(400);
    } while (pageToken);
    return items;
}

/**
 * Фактическая ставка буста по офферу из заказов stats/orders за период.
 * boostPct = Σ bidFee / Σ (sellerPrice·count) × 100 — доля рекламного расхода в выручке продавца.
 * tariffs/calculate НЕ возвращает буст, поэтому единственный надёжный источник — факт списаний.
 *
 * Возвращает Map offerId → { boostPct, units, boostRubles, sellerRevenue }.
 * B1: в карту попадают ТОЛЬКО офферы с реальным бустом (Σ bidFee > 0).
 * minUnits — порог выборки против шума от единичных продаж (по умолчанию 3).
 *
 * @param {Array} items результат fetchOrdersEconomics()
 */
function aggregateBoostByOffer(items, { minUnits = 3 } = {}) {
    const agg = new Map();
    for (const it of (items || [])) {
        if (!it.offerId) continue;
        const cnt = it.count || 1;
        const sp = parseFloat(it.sellerPrice);
        const fee = parseFloat(it.bidFee) || 0;
        let a = agg.get(it.offerId);
        if (!a) { a = { units: 0, boostRubles: 0, sellerRevenue: 0 }; agg.set(it.offerId, a); }
        a.units += cnt;
        a.boostRubles += fee;
        if (sp > 0) a.sellerRevenue += sp * cnt;
    }
    const result = new Map();
    for (const [offerId, a] of agg) {
        // Только реально продвигавшиеся, с достаточной выборкой и валидной выручкой
        if (a.boostRubles <= 0 || a.units < minUnits || a.sellerRevenue <= 0) continue;
        const boostPct = a.boostRubles / a.sellerRevenue * 100;
        result.set(offerId, { boostPct, units: a.units, boostRubles: a.boostRubles, sellerRevenue: a.sellerRevenue });
    }
    return result;
}

/**
 * Best-effort чтение ставок буста, выставленных ЧЕРЕЗ API (PUT bids).
 * ⚠️ Ручные ставки из кабинета этот метод НЕ возвращает (ограничение API) —
 * поэтому источник истины для floor всё равно факт продаж (aggregateBoostByOffer).
 * Возвращает Map offerId → boostPct (bid в ответе — проценты ×100, делим на 100).
 */
async function fetchBoostBids(businessId, apiKey, offerIds, storeId) {
    const result = new Map();
    if (!businessId || !offerIds || offerIds.length === 0) return result;
    const client = createYandexClient(apiKey, { source: 'repricer', storeId });
    const BATCH = 500;
    for (let i = 0; i < offerIds.length; i += BATCH) {
        const skus = offerIds.slice(i, i + BATCH);
        try {
            const r = await client.post(
                `/v2/businesses/${businessId}/bids/info`,
                { skus },
                { params: { limit: 500 }, metadata: { summary: `bids/info ${skus.length}` } }
            );
            for (const b of (r.data.result?.bids || [])) {
                if (b.sku && b.bid != null) result.set(b.sku, parseFloat(b.bid) / 100);
            }
            await sleep(400);
        } catch (e) {
            // Нет API-кампании буста / нет прав — не критично, опираемся на факт продаж
            console.warn(`[YM] bids/info batch failed (некритично):`, e.response?.status, e.message);
            break;
        }
    }
    return result;
}

/**
 * Продажи по SKU/день для стратегий (РФ2). Источник — stats/orders, агрегируем по дате заказа.
 * Возвращает [{ offer_id, date, units, revenue, price_seller, price_buyer_est }].
 */
function ymNormDate(s) {
    if (!s) return null;
    const str = String(s);
    const m = str.match(/^(\d{2})-(\d{2})-(\d{4})/); // "DD-MM-YYYY" → "YYYY-MM-DD"
    if (m) return `${m[3]}-${m[2]}-${m[1]}`;
    return str.slice(0, 10); // ISO
}
async function fetchSales(store, fromDate, toDate) {
    const campaignId = store.ym_campaign_id, apiKey = store.ym_api_key;
    const client = createYandexClient(apiKey, { source: 'sales', storeId: store.id });
    const agg = new Map();
    let pageToken;
    do {
        const params = { limit: 200 };
        if (pageToken) params.page_token = pageToken;
        const r = await client.post(
            `/v2/campaigns/${campaignId}/stats/orders`,
            { dateFrom: fromDate, dateTo: toDate, statuses: ['DELIVERED', 'DELIVERY', 'PROCESSING', 'PICKUP'] },
            { params, metadata: { summary: `sales ${fromDate}..${toDate}` } }
        );
        for (const o of (r.data.result?.orders || [])) {
            const date = ymNormDate(o.creationDate || o.statusUpdateDate);
            if (!date || date > toDate) continue;
            for (const it of (o.items || [])) {
                const offer = it.shopSku;
                if (!offer) continue;
                const market = (it.prices || []).find(p => p.type === 'MARKETPLACE');
                const buyer = (it.prices || []).find(p => p.type === 'BUYER');
                const cnt = it.count || 1;
                const key = `${offer}|${date}`;
                let a = agg.get(key);
                if (!a) { a = { offer_id: offer, date, units: 0, revenue: 0, _seller: 0, _buyer: 0, _n: 0 }; agg.set(key, a); }
                a.units += cnt;
                const sp = market ? market.costPerItem : null;
                const bp = buyer ? buyer.costPerItem : null;
                if (sp != null) { a.revenue += sp * cnt; a._seller += sp; a._n += 1; }
                if (bp != null) a._buyer += bp;
            }
        }
        pageToken = r.data.result?.paging?.nextPageToken;
        await sleep(400);
    } while (pageToken);
    return [...agg.values()].map(a => ({
        offer_id: a.offer_id, date: a.date, units: a.units, revenue: Math.round(a.revenue),
        price_seller: a._n ? Math.round(a._seller / a._n) : null,
        price_buyer_est: a._n ? Math.round(a._buyer / a._n) : null,
    }));
}

/**
 * Обновить цены на Yandex Market.
 */
async function updatePrices(campaignId, apiKey, updates, storeId, source = 'sync') {
    const client = createYandexClient(apiKey, { source, storeId });
    const MAX_RETRIES = 5;
    // Лимит Yandex Market: /offer-prices/updates принимает максимум 500 товаров за запрос
    // (как и read-путь fetchPrices). Больше — Яндекс отвечает ошибкой валидации.
    const BATCH_SIZE = 500;
    const results = [];

    for (let i = 0; i < updates.length; i += BATCH_SIZE) {
        const batch = updates.slice(i, i + BATCH_SIZE);
        const offers = batch.map(u => ({
            offerId: u.offerId || u.offer_id,
            price: {
                value: u.price?.value ?? u.price ?? 0,
                discountBase: u.price?.discountBase ?? u.discountBase ?? undefined,
                currencyId: 'RUR',
            },
        }));

        let attempt = 0;
        while (attempt < MAX_RETRIES) {
            try {
                const response = await client.post(
                    `/v2/campaigns/${campaignId}/offer-prices/updates`,
                    { offers },
                    { metadata: { itemsCount: offers.length, summary: `update ${offers.length} prices`, retryAttempt: attempt } }
                );
                results.push(response.data);
                break;
            } catch (error) {
                if (error.response && error.response.status === 429) {
                    attempt++;
                    const delay = 1000 * Math.pow(2, attempt);
                    console.warn(`YM rate limit (429). Retry ${attempt}/${MAX_RETRIES} in ${delay}ms...`);
                    await sleep(delay);
                    continue;
                }
                console.error('Error updating YM prices:', error.response?.data || error.message);
                throw error;
            }
        }
        if (attempt >= MAX_RETRIES) {
            throw new Error(`Failed to update YM prices after ${MAX_RETRIES} retries due to rate limits (429), batch ${Math.floor(i / BATCH_SIZE) + 1}`);
        }
    }

    return results;
}

/**
 * Полная синхронизация магазина Yandex Market: товары + цены → БД.
 */
async function syncStore(storeId) {
    console.log(`[YM] Starting sync for Store ID: ${storeId}`);
    let logId;

    const log = async (level, stage, msg) => {
        if (logId) await db.addLogEntry(logId, level, stage, msg);
        console.log(`[YM][${stage}] ${msg}`);
    };

    try {
        logId = await db.createLog(storeId);
        await log('INFO', 'INIT', `YM sync started for Store ID ${storeId}`);

        const store = await db.getStoreById(storeId);
        if (!store) throw new Error('Store not found');

        const { ym_business_id, ym_api_key, ym_campaign_id } = store;
        if (!ym_business_id || !ym_api_key) {
            throw new Error('Missing YM credentials (ym_business_id, ym_api_key)');
        }

        // Fetch active products with processingState
        await log('INFO', 'FETCH_IDS', 'Fetching YM products (offer-mappings with statuses)...');
        const products = await fetchProducts(ym_business_id, ym_api_key, storeId, false);
        await log('INFO', 'FETCH_IDS', `Found ${products.length} active products.`);

        // Fetch archived products separately
        await log('INFO', 'FETCH_IDS', 'Fetching archived products...');
        let archivedProducts = [];
        try {
            archivedProducts = await fetchProducts(ym_business_id, ym_api_key, storeId, true);
            await log('INFO', 'FETCH_IDS', `Found ${archivedProducts.length} archived products.`);
        } catch (e) {
            await log('WARN', 'FETCH_IDS', `Could not fetch archived: ${e.message}`);
        }

        if (products.length === 0 && archivedProducts.length === 0) {
            await db.updateLog(logId, { status: 'SUCCESS', items_processed: 0, items_changed: 0, completed: true, log_text: 'No products found' });
            return { success: true, count: 0 };
        }

        // Fetch price quarantine offer IDs
        await log('INFO', 'FETCH_STATUS', 'Fetching price quarantine...');
        const quarantineResult = await fetchQuarantineOfferIds(ym_campaign_id, ym_api_key, storeId);
        const quarantineSet = quarantineResult.ids;
        if (quarantineResult.error) {
            await log('WARNING', 'FETCH_STATUS', `Quarantine fetch FAILED (${quarantineResult.error}) — карантинные статусы в этом синке могут быть неполными`);
        } else {
            await log('INFO', 'FETCH_STATUS', `${quarantineSet.size} products in price quarantine.`);
        }

        // Ошибки определяются через поля mapping/awaitingModerationMapping/rejectedMapping
        // уже внутри fetchProducts — отдельный запрос не нужен
        const errorCount = products.filter(p => p.isError).length;
        await log('INFO', 'FETCH_STATUS', `${errorCount} products with content errors (no approved/awaiting mapping).`);

        // Fetch "Можно улучшить" offer IDs via offer-cards endpoint
        await log('INFO', 'FETCH_STATUS', 'Fetching "can improve" offer IDs...');
        const canImproveResult = await fetchCanImproveOfferIds(ym_business_id, ym_api_key, storeId);
        const canImproveSet = canImproveResult.ids;
        if (canImproveResult.error) {
            await log('WARNING', 'FETCH_STATUS', `Can-improve fetch FAILED (${canImproveResult.error}) — список «можно улучшить» неполный (получено ${canImproveSet.size})`);
        } else {
            await log('INFO', 'FETCH_STATUS', `${canImproveSet.size} products can be improved.`);
        }

        // Overlay campaign-specific prices (more up-to-date than basicPrice from offer-mappings)
        if (ym_campaign_id && products.length > 0) {
            await log('INFO', 'FETCH_PRICES', `Fetching campaign prices for ${products.length} products...`);
            const offerIds = products.map(p => p.offer_id);
            const { priceMap: campaignPrices, failedBatches } = await fetchPrices(ym_campaign_id, ym_api_key, offerIds, storeId);
            if (failedBatches > 0) {
                await log('WARNING', 'FETCH_PRICES', `${failedBatches} price batch(es) failed — campaign prices applied partially (${campaignPrices.size}/${offerIds.length})`);
            }
            let overrideCount = 0;
            for (const p of products) {
                const cp = campaignPrices.get(p.offer_id);
                if (cp && cp.price > 0) {
                    p.price = cp.price;
                    p.old_price = cp.discountBase || p.old_price;
                    overrideCount++;
                }
            }
            await log('INFO', 'FETCH_PRICES', `Applied campaign price for ${overrideCount} products.`);
        }

        // Reset visibility + quarantine + moderate_status before setting fresh values
        await db.resetStoreVisibility(storeId);
        await db.resetStoreQuarantine(storeId);
        await db.resetStoreModerateStatus(storeId);

        // Save active products and set status
        let itemsChanged = 0;
        await log('INFO', 'SAVE_DB', `Saving ${products.length} active + ${archivedProducts.length} archived products...`);

        for (const p of products) {
            const ozonId = hashOfferId(p.offer_id);
            const productData = {
                product_id: ozonId,
                offer_id: p.offer_id,
                name: p.name,
                price: String(p.price),
                old_price: String(p.old_price || 0),
                marketing_price: String(p.price),
                min_price: null,
                currency_code: p.currency_code || 'RUR',
                primary_image: p.primary_image || null,
                // Для tariffs/calculate (floor-защита репрайсера)
                ym_category_id: p.ym_category_id,
                ym_dims: p.ym_dims,
            };

            const dbProductId = await db.saveProduct(storeId, productData);

            if (p.purchasePrice) {
                await db.updateProductCostPrice(storeId, p.offer_id, p.purchasePrice);
            }

            const lastHistory = await db.getLastPrice(dbProductId);
            await db.savePrice(dbProductId, productData);

            if (lastHistory && parseFloat(lastHistory.price) !== parseFloat(p.price || 0)) itemsChanged++;

            // Set visibility based on mapping presence (determined in fetchProducts)
            const is_quarantine = quarantineSet.has(p.offer_id) ? 1 : 0;
            const moderate_status = canImproveSet.has(p.offer_id) ? 'can_improve' : null;

            await db.updateProductStatus(storeId, ozonId, {
                visibility: p.isError ? 'INVISIBLE' : 'VISIBLE',
                ozon_is_created: p.isError ? 0 : 1,
                is_quarantine,
                is_archived: 0,
                moderate_status,
            });
        }

        // Save archived products and mark as archived
        for (const p of archivedProducts) {
            const ozonId = hashOfferId(p.offer_id);
            const productData = {
                product_id: ozonId,
                offer_id: p.offer_id,
                name: p.name,
                price: String(p.price),
                old_price: String(p.old_price || 0),
                marketing_price: String(p.price),
                min_price: null,
                currency_code: p.currency_code || 'RUR',
                primary_image: p.primary_image || null,
            };
            await db.saveProduct(storeId, productData);
            await db.updateProductStatus(storeId, ozonId, {
                visibility: 'INVISIBLE',
                is_archived: 1,
                is_quarantine: 0,
            });
        }

        await log('INFO', 'SAVE_DB', `Done. ${itemsChanged} price changes detected.`);

        // Участие в акциях Маркета (включая АВТОдобавленные — источник продаж в минус)
        await log('INFO', 'SYNC_PROMOS', 'Fetching promo participation...');
        const promoResult = await fetchPromoParticipation(ym_business_id, ym_api_key, storeId);
        if (promoResult.error) {
            await log('WARNING', 'SYNC_PROMOS', `Promo fetch FAILED (${promoResult.error}) — промо-флаги в этом синке не обновлены`);
        } else {
            await db.resetStorePromo(storeId);
            let autoCount = 0;
            for (const [offerId, info] of promoResult.participating) {
                const ozonId = hashOfferId(offerId);
                await db.updateProductStatus(storeId, ozonId, {
                    in_promo: 1,
                    promo_action_id: info.promoId,
                });
                if (info.status === 'AUTO' || info.status === 'PARTIALLY_AUTO') autoCount++;
            }
            const lvl = autoCount > 0 ? 'WARNING' : 'INFO';
            await log(lvl, 'SYNC_PROMOS',
                `${promoResult.participating.size} товаров в акциях Маркета` +
                (autoCount > 0 ? `, из них ${autoCount} добавлены АВТОМАТИЧЕСКИ — проверьте экономику!` : ''));
        }

        await db.updateStoreTimestamp(storeId);
        await db.updateLog(logId, {
            status: 'SUCCESS',
            items_processed: products.length,
            items_changed: itemsChanged,
            completed: true,
            log_text: 'Sync completed successfully',
        });

        await log('INFO', 'FINISH', 'YM sync completed.');
        return { success: true, count: products.length };

    } catch (error) {
        console.error(`[YM] Sync failed for Store ${storeId}:`, error);
        if (logId) {
            await log('ERROR', 'FAIL', `Failed: ${error.message}`);
            await db.updateLog(logId, { status: 'ERROR', log_text: error.message, completed: true });
        }
        return { success: false, error: error.message };
    }
}

/**
 * Hash offerId string to a stable integer for product_id (Ozon uses numeric IDs, YM uses strings).
 */
function hashOfferId(offerId) {
    let hash = 0;
    for (let i = 0; i < offerId.length; i++) {
        const char = offerId.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
    }
    return Math.abs(hash);
}

module.exports = { syncStore, updatePrices, fetchPrices, fetchTariffs, updateBusinessPrices, fetchPromoParticipation, fetchOrdersEconomics, fetchSales, aggregateBoostByOffer, fetchBoostBids, removeFromPromo };
