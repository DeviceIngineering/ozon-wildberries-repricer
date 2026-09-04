const { createOzonClient } = require('./lib/ozonClient.cjs');
const Sentry = require('./sentry.server.cjs');
const db = require('./db.cjs');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function fetchAllProductIds(clientId, apiKey, antiban, storeId) {
    const client = createOzonClient(clientId, apiKey, { source: 'sync', storeId });
    const limit = 1000;
    const allIds = new Set();

    // 'ALL' = active+invisible, 'ARCHIVED' = archived (separate in Ozon API)
    for (const visibility of ['ALL', 'ARCHIVED']) {
        let lastId = '';
        let hasMore = true;
        while (hasMore) {
            try {
                const response = await client.post('/v3/product/list', {
                    filter: { visibility },
                    limit,
                    last_id: lastId || undefined
                }, { metadata: { itemsCount: limit, summary: `${visibility}, last_id=${lastId || 'start'}` } });

                const { items, last_id: newLastId } = response.data.result;
                if (!items || items.length === 0) break;

                items.forEach(i => allIds.add(i.product_id));
                lastId = newLastId;
                if (items.length < limit) hasMore = false;

                if (antiban) await sleep(1000);
            } catch (error) {
                console.error(`Error fetching product list (${visibility}):`, error.message);
                if (visibility === 'ALL') throw error; // critical
                // ARCHIVED не получен — синк продолжится, но архивные товары в этом проходе отсутствуют
                console.warn(`[Sync] ARCHIVED product list failed — archived products will be MISSING this sync: ${error.message}`);
                break;
            }
        }
    }
    return [...allIds];
}

async function fetchDetailsAndPrices(clientId, apiKey, productIds, antiban, onProgress, storeId) {
    const client = createOzonClient(clientId, apiKey, { source: 'sync', storeId });
    const BATCH_SIZE = antiban ? 50 : 100;
    const DELAY_MS = antiban ? 3000 : 500;

    let allDetails = [];
    let processedCount = 0;
    let failedBatches = 0;
    const totalBatches = Math.ceil(productIds.length / BATCH_SIZE);

    for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
        const batchIds = productIds.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;

        try {
            const infoResp = await client.post('/v3/product/info/list', {
                product_id: batchIds
            }, { metadata: { itemsCount: batchIds.length, summary: `info batch ${batchNum}/${totalBatches}` } });

            const pricesResp = await client.post('/v5/product/info/prices', {
                filter: { product_id: batchIds, visibility: 'ALL' },
                limit: BATCH_SIZE
            }, { metadata: { itemsCount: batchIds.length, summary: `prices batch ${batchNum}/${totalBatches}` } });

            const infoMap = new Map();
            if (infoResp.data.items) infoResp.data.items.forEach(item => infoMap.set(item.id, item));

            const priceMap = new Map();
            if (pricesResp.data.items) pricesResp.data.items.forEach(item => priceMap.set(item.product_id, item));

            const merged = batchIds.map(id => {
                const info = infoMap.get(id);
                const priceData = priceMap.get(id);
                const pObj = priceData?.price;

                return {
                    product_id: id,
                    offer_id: info?.offer_id || priceData?.offer_id,
                    name: info?.name,
                    primary_image: info?.primary_image ? (Array.isArray(info.primary_image) ? info.primary_image[0] : info.primary_image) : null,
                    price: pObj?.price || info?.price,
                    old_price: pObj?.old_price || info?.old_price,
                    marketing_price: pObj?.marketing_seller_price,
                    min_price: pObj?.min_price,
                    currency_code: pObj?.currency_code || info?.currency_code || 'RUB'
                };
            });

            allDetails.push(...merged);
            processedCount += merged.length;
            if (onProgress) onProgress(processedCount);

            console.log(`Fetched batch ${batchNum}/${totalBatches} (Antiban: ${antiban})`);
            if (i + BATCH_SIZE < productIds.length) await sleep(DELAY_MS);
        } catch (error) {
            failedBatches++;
            console.error(`Error fetching details batch ${batchNum}/${totalBatches} (${batchIds.length} products):`, error.message);
        }
    }
    if (failedBatches > 0) {
        // Частичные данные: вызывающий код увидит расхождение counts в sync_logs
        console.error(`[Sync] ${failedBatches}/${totalBatches} detail batches FAILED — returning partial data (${allDetails.length}/${productIds.length} products)`);
        Sentry.withScope(scope => {
            scope.setTag('operation', 'fetchDetailsAndPrices');
            scope.setTag('store_id', storeId);
            Sentry.captureMessage(`Sync partial data: ${failedBatches}/${totalBatches} batches failed`, 'warning');
        });
    }
    return allDetails;
}

async function syncStore(storeId) {
    console.log(`Starting sync for Store ID: ${storeId}`);
    let logId;

    const log = async (level, stage, msg) => {
        if (logId) await db.addLogEntry(logId, level, stage, msg);
        console.log(`[${stage}] ${msg}`);
        Sentry.addBreadcrumb({
            category: 'sync',
            level: level === 'ERROR' ? 'error' : 'info',
            message: `${stage}: ${msg}`,
            data: { storeId, logId },
        });
    };

    try {
        logId = await db.createLog(storeId);
        await log('INFO', 'INIT', `Sync started for Store ID ${storeId}`);

        const store = await db.getStoreById(storeId);
        if (!store) throw new Error('Store not found');

        const { client_id, api_key, antiban_enabled } = store;

        await log('INFO', 'FETCH_IDS', 'Fetching product IDs list...');
        const ids = await fetchAllProductIds(client_id, api_key, !!antiban_enabled, storeId);
        await log('INFO', 'FETCH_IDS', `Found ${ids.length} product IDs.`);
        await db.updateLog(logId, { log_text: `Found ${ids.length} products. Fetching details...` });

        await log('INFO', 'FETCH_DETAILS', `Starting to fetch details for ${ids.length} products...`);
        const products = await fetchDetailsAndPrices(client_id, api_key, ids, !!antiban_enabled, (count) => {
            db.updateLog(logId, { items_processed: count });
        }, storeId);
        await log('INFO', 'FETCH_DETAILS', `Finished fetching details. Got ${products.length} products.`);
        if (products.length < ids.length) {
            await log('WARNING', 'FETCH_DETAILS', `Partial data: ${ids.length - products.length} of ${ids.length} products NOT fetched (failed batches) — their prices/statuses will be stale this sync`);
        }

        let itemsChanged = 0;
        await log('INFO', 'SAVE_DB', `Saving snapshots to database...`);
        await db.updateLog(logId, { log_text: `Saving ${products.length} products...` });

        for (const p of products) {
            const dbProductId = await db.saveProduct(storeId, p);
            const lastHistory = await db.getLastPrice(dbProductId);
            await db.savePrice(dbProductId, p);

            if (lastHistory) {
                const oldPrice = lastHistory.price;
                const newPrice = parseFloat(p.price || 0);
                if (oldPrice !== newPrice) itemsChanged++;
            }
        }
        await log('INFO', 'SAVE_DB', `Database save complete. ${itemsChanged} price changes detected.`);

        // Fetch and update visibility for all synced products
        if (ids.length > 0) {
            await log('INFO', 'SYNC_VISIBILITY', `Fetching visibility for ${ids.length} products...`);
            try {
                const visibilityData = await fetchProductVisibility(client_id, api_key, ids, !!antiban_enabled, storeId);
                const now_iso = new Date().toISOString();
                for (const v of visibilityData) {
                    await db.updateProductStatus(storeId, v.product_id, {
                        visibility: v.visibility,
                        is_quarantine: v.is_quarantine,
                        is_archived: v.is_archived,
                        has_price: v.has_price,
                        has_stock: v.has_stock,
                        ozon_is_created: v.ozon_is_created,
                        ozon_status: v.ozon_status,
                        in_promo: undefined,
                        promo_price: undefined,
                        last_status_check: now_iso
                    });
                }
                await log('INFO', 'SYNC_VISIBILITY', `Updated visibility for ${visibilityData.length} products`);
            } catch (visErr) {
                await log('ERROR', 'SYNC_VISIBILITY', `Failed to fetch visibility: ${visErr.message}`);
            }
        }

        // Per-product FBO/FBS stocks (non-critical)
        await log('INFO', 'FETCH_STOCKS', 'Fetching per-product FBO/FBS stocks...');
        try {
            const stocks = await fetchProductStocks(client_id, api_key, !!antiban_enabled, storeId);
            if (stocks.length > 0) await db.updateProductStocks(storeId, stocks);
            const totalFbo = stocks.reduce((a, s) => a + s.stocks_fbo, 0);
            const totalFbs = stocks.reduce((a, s) => a + s.stocks_fbs, 0);
            await log('INFO', 'FETCH_STOCKS', `${stocks.length} товаров, суммарно FBO=${totalFbo}, FBS=${totalFbs}`);
        } catch (stockErr) {
            await log('ERROR', 'FETCH_STOCKS', `Failed to fetch stocks: ${stockErr.message}`);
        }

        await db.updateStoreTimestamp(storeId);
        await db.updateLog(logId, {
            status: 'SUCCESS',
            items_processed: products.length,
            items_changed: itemsChanged,
            completed: true,
            log_text: 'Sync completed successfully'
        });

        await log('INFO', 'FINISH', `Sync completed successfully.`);
        return { success: true, count: products.length };

    } catch (error) {
        console.error(`Sync failed for Store ${storeId}:`, error);
        Sentry.withScope(scope => {
            scope.setTag('operation', 'syncStore');
            scope.setTag('store_id', storeId);
            scope.setTag('platform', 'ozon');
            Sentry.captureException(error);
        });
        if (logId) {
            await log('ERROR', 'Run', `Failed: ${error.message}`);
            await db.updateLog(logId, { status: 'ERROR', log_text: error.message, completed: true });
        }
        return { success: false, error: error.message };
    }
}

async function updateProductPrices(clientId, apiKey, priceUpdates, storeId, source = 'sync') {
    const client = createOzonClient(clientId, apiKey, { source, storeId });
    const MAX_RETRIES = 5;
    // Лимит Ozon: /v1/product/import/prices принимает максимум 1000 цен за запрос.
    // Больше — режем на батчи (иначе Ozon отвечает 400 "must contain between 1 and 1000 items").
    const CHUNK_SIZE = 1000;

    // Отправка одного батча (≤1000) с ретраями 429 и логированием per-item ошибок Ozon.
    async function sendBatch(batch) {
        let attempt = 0;
        while (attempt < MAX_RETRIES) {
            try {
                const response = await client.post('/v1/product/import/prices', {
                    prices: batch
                }, { metadata: { itemsCount: batch.length, summary: `update ${batch.length} prices`, retryAttempt: attempt } });

                const data = response.data;
                // Parse per-item errors from Ozon response
                if (data.result) {
                    const itemErrors = [];
                    for (const item of data.result) {
                        if (item.errors && item.errors.length > 0) {
                            itemErrors.push({
                                offer_id: item.offer_id,
                                errors: item.errors,
                                updated: item.updated
                            });
                        }
                    }
                    if (itemErrors.length > 0) {
                        data._itemErrors = itemErrors;
                        console.warn(`Price update: ${itemErrors.length} items had errors:`,
                            JSON.stringify(itemErrors, null, 2));
                        // В api_logs — переживает ротацию docker logs и видно в UI
                        db.insertApiLog(storeId, {
                            endpoint: '/v1/product/import/prices',
                            method: 'POST',
                            statusCode: 200,
                            itemsCount: itemErrors.length,
                            requestSummary: `item errors (source: ${source})`,
                            errorMessage: `${itemErrors.length}/${batch.length} items rejected by Ozon: ${JSON.stringify(itemErrors).slice(0, 900)}`,
                            source,
                        }).catch(logErr => console.error('[updatePrices] Failed to log item errors:', logErr.message));
                        Sentry.withScope(scope => {
                            scope.setTag('operation', 'price_update_item_errors');
                            scope.setTag('store_id', storeId);
                            scope.setTag('source', source);
                            Sentry.captureMessage(`Ozon rejected ${itemErrors.length}/${batch.length} price updates`, 'warning');
                        });
                    }
                }
                return data;
            } catch (error) {
                if (error.response && error.response.status === 429) {
                    attempt++;
                    const delay = 1000 * Math.pow(2, attempt);
                    console.warn(`Rate limit hit (429). Retrying attempt ${attempt}/${MAX_RETRIES} in ${delay}ms...`);
                    await sleep(delay);
                    continue;
                }
                console.error('Error updating prices:', error.response?.data || error.message);
                throw error;
            }
        }
        // Все ретраи исчерпаны — фиксируем финальный отказ как rate-limit, а не generic error
        const rateLimitErr = new Error(`Failed to update ${batch.length} prices after ${MAX_RETRIES} retries due to rate limits (429), source: ${source}`);
        db.insertApiLog(storeId, {
            endpoint: '/v1/product/import/prices',
            method: 'POST',
            statusCode: 429,
            itemsCount: batch.length,
            requestSummary: `FINAL FAILURE after ${MAX_RETRIES} retries (source: ${source})`,
            errorMessage: rateLimitErr.message,
            source,
            retryAttempt: MAX_RETRIES,
        }).catch(logErr => console.error('[updatePrices] Failed to log final 429:', logErr.message));
        throw rateLimitErr;
    }

    // ≤1000 — один запрос (форма ответа без изменений, обратная совместимость)
    if (priceUpdates.length <= CHUNK_SIZE) {
        return sendBatch(priceUpdates);
    }
    // >1000 — режем на батчи и агрегируем результат + per-item ошибки
    const merged = { result: [], _itemErrors: [], _batches: 0 };
    for (let i = 0; i < priceUpdates.length; i += CHUNK_SIZE) {
        const data = await sendBatch(priceUpdates.slice(i, i + CHUNK_SIZE));
        merged._batches++;
        if (Array.isArray(data?.result)) merged.result.push(...data.result);
        if (Array.isArray(data?._itemErrors)) merged._itemErrors.push(...data._itemErrors);
    }
    if (merged._itemErrors.length === 0) delete merged._itemErrors;
    return merged;
}

async function syncProduct(storeId, ozonProductId) {
    console.log(`Starting single product sync for Store ID: ${storeId}, Product ID: ${ozonProductId}`);
    try {
        const store = await db.getStoreById(storeId);
        if (!store) throw new Error('Store not found');

        const { client_id, api_key, antiban_enabled } = store;
        const products = await fetchDetailsAndPrices(client_id, api_key, [ozonProductId], !!antiban_enabled, null, storeId);

        if (products.length === 0) throw new Error('Product not found in Ozon');

        const p = products[0];
        const dbProductId = await db.saveProduct(storeId, p);
        await db.savePrice(dbProductId, p);

        console.log(`Single sync complete for Product ${ozonProductId}`);
        return { success: true, product: p };
    } catch (error) {
        console.error(`Single sync failed for Store ${storeId}, Product ${ozonProductId}:`, error);
        return { success: false, error: error.message };
    }
}

// Загружает все product_id с заданным visibility-фильтром Ozon
async function fetchVisibilityIdSet(client, visibility, antiban) {
    const ids = new Set();
    let lastId = '';
    let hasMore = true;
    while (hasMore) {
        try {
            const r = await client.post('/v3/product/list', {
                filter: { visibility },
                limit: 1000,
                last_id: lastId || undefined
            }, { metadata: { summary: `vis-set:${visibility}` } });
            const { items, last_id: newLastId } = r.data.result;
            if (!items || items.length === 0) break;
            items.forEach(i => ids.add(i.product_id));
            lastId = newLastId;
            if (items.length < 1000) hasMore = false;
            if (antiban) await sleep(500);
        } catch (e) {
            console.error(`Error fetching visibility set ${visibility}:`, e.message);
            throw e; // propagate — empty VISIBLE set would corrupt all visibility data
        }
    }
    return ids;
}

async function fetchProductVisibility(clientId, apiKey, productIds, antiban, storeId) {
    const client = createOzonClient(clientId, apiKey, { source: 'monitor', storeId });

    // Получаем авторитетные наборы ID от Ozon по visibility-фильтрам (последовательно — защита от rate limit).
    // VISIBLE включает и "В продаже", и "Готовы к продаже" (EMPTY_STOCK — подмножество VISIBLE).
    // QUARANTINE, DISABLED — подмножества INVISIBLE.
    // Остаток INVISIBLE (не QUARANTINE, не DISABLED, не EMPTY_STOCK) = "Сняты с продажи".
    const visibleIds    = await fetchVisibilityIdSet(client, 'VISIBLE',    antiban);
    const quarantineIds = await fetchVisibilityIdSet(client, 'QUARANTINE', antiban);
    const emptyStockIds = await fetchVisibilityIdSet(client, 'EMPTY_STOCK', antiban);
    const disabledIds   = await fetchVisibilityIdSet(client, 'DISABLED',   antiban);
    console.log(`[Monitor] Visibility sets: VISIBLE=${visibleIds.size}, QUARANTINE=${quarantineIds.size}, EMPTY_STOCK=${emptyStockIds.size}, DISABLED=${disabledIds.size}`);

    const BATCH_SIZE = antiban ? 100 : 1000;
    const DELAY_MS = antiban ? 2000 : 500;
    const results = [];
    let failedBatches = 0;
    const totalVisBatches = Math.ceil(productIds.length / BATCH_SIZE);

    for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
        const batchIds = productIds.slice(i, i + BATCH_SIZE);
        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        try {
            const response = await client.post('/v3/product/info/list', {
                product_id: batchIds
            }, { metadata: { itemsCount: batchIds.length, summary: `visibility batch ${Math.floor(i / BATCH_SIZE) + 1}` } });

            const items = response.data.items || [];
            for (const item of items) {
                const statuses = item.statuses || {};
                const visDetails = item.visibility_details || {};
                const hasPrice = visDetails.has_price !== false;
                const hasStock = visDetails.has_stock !== false;
                const isArchived = item.is_archived === true;
                const isCreated = statuses.is_created !== false;

                const is_archived_val = isArchived ? 1 : 0;

                // Классификация по авторитетным наборам Ozon
                let visibility, is_quarantine, ozon_is_created_val;

                if (quarantineIds.has(item.id)) {
                    // Ошибки — ценовой карантин
                    visibility = 'INVISIBLE';
                    is_quarantine = 1;
                    ozon_is_created_val = isCreated ? 1 : 0;
                } else if (disabledIds.has(item.id)) {
                    // На доработку — карточка не создана/не прошла валидацию
                    visibility = 'INVISIBLE';
                    is_quarantine = 0;
                    ozon_is_created_val = 0;
                } else if (emptyStockIds.has(item.id)) {
                    // Готовы к продаже — карточка ок, нет стока
                    visibility = 'INVISIBLE';
                    is_quarantine = 0;
                    ozon_is_created_val = 1;
                } else if (visibleIds.has(item.id)) {
                    // В продаже
                    visibility = 'VISIBLE';
                    is_quarantine = 0;
                    ozon_is_created_val = 1;
                } else {
                    // Сняты с продажи (INVISIBLE, но не в спец-наборах) или архив
                    visibility = 'INVISIBLE';
                    is_quarantine = 0;
                    ozon_is_created_val = isCreated ? 1 : 0;
                }

                results.push({
                    product_id: item.id,
                    visibility,
                    is_quarantine,
                    is_archived: is_archived_val,
                    has_price: hasPrice ? 1 : 0,
                    has_stock: hasStock ? 1 : 0,
                    ozon_is_created: ozon_is_created_val,
                    ozon_status: statuses.status || '',
                });
            }

            if (i + BATCH_SIZE < productIds.length && antiban) await sleep(DELAY_MS);
        } catch (error) {
            failedBatches++;
            console.error(`Error fetching visibility batch ${batchNum}/${totalVisBatches} (${batchIds.length} products):`, error.message);
        }
    }

    if (failedBatches > 0) {
        // Частичные данные — видимость части товаров останется устаревшей
        console.error(`[Monitor] ${failedBatches}/${totalVisBatches} visibility batches FAILED — visibility updated for ${results.length}/${productIds.length} products only`);
        Sentry.withScope(scope => {
            scope.setTag('operation', 'fetchProductVisibility');
            scope.setTag('store_id', storeId);
            Sentry.captureMessage(`Visibility partial data: ${failedBatches}/${totalVisBatches} batches failed`, 'warning');
        });
    }

    return results;
}

// Получает остатки FBO/FBS для каждого товара магазина через /v4/product/info/stocks.
// Доступный остаток = present - reserved. Crossborder игнорируется.
// Возвращает массив [{ ozon_id, stocks_fbo, stocks_fbs }, ...].
async function fetchProductStocks(clientId, apiKey, antiban, storeId) {
    const client = createOzonClient(clientId, apiKey, { source: 'sync', storeId });
    const limit = 1000;
    let cursor = '';
    let page = 0;
    const byProduct = new Map(); // product_id -> { fbo, fbs }

    while (true) {
        page++;
        const response = await client.post('/v4/product/info/stocks', {
            cursor,
            limit,
            filter: { visibility: 'ALL' }
        }, { metadata: { itemsCount: limit, summary: `stocks page ${page}, cursor=${cursor ? 'yes' : 'start'}` } });

        const items = response.data.items || [];
        for (const item of items) {
            let fbo = 0;
            let fbs = 0;
            for (const s of (item.stocks || [])) {
                if (s.type !== 'fbo' && s.type !== 'fbs') continue;
                const available = Math.max(0, (s.present || 0) - (s.reserved || 0));
                if (s.type === 'fbo') fbo += available;
                else fbs += available;
            }
            if (item.product_id != null) {
                const prev = byProduct.get(item.product_id) || { fbo: 0, fbs: 0 };
                byProduct.set(item.product_id, { fbo: prev.fbo + fbo, fbs: prev.fbs + fbs });
            }
        }

        cursor = response.data.cursor || '';
        if (!cursor || items.length < limit) break;
        if (antiban) await sleep(1000);
    }

    const result = [];
    for (const [ozon_id, v] of byProduct) {
        result.push({ ozon_id, stocks_fbo: v.fbo, stocks_fbs: v.fbs });
    }
    return result;
}

async function fetchActivePromos(clientId, apiKey, storeId) {
    const client = createOzonClient(clientId, apiKey, { source: 'monitor', storeId });

    // Step 1: Get list of active promotions
    let promos = [];
    try {
        const response = await client.get('/v1/actions', { metadata: { summary: 'fetch active promos' } });
        promos = (response.data.result || []).filter(p => p.action_type !== undefined);
    } catch (error) {
        console.error('Error fetching promos list:', error.message);
        return new Map();
    }

    // Step 2: For each promo, paginate through all products
    const promoMap = new Map();
    const PAGE_LIMIT = 1000;

    for (let i = 0; i < promos.length; i++) {
        const promo = promos[i];
        const actionName = promo.title || promo.name || String(promo.id);

        try {
            let offset = 0;
            let hasMore = true;

            while (hasMore) {
                const response = await client.post('/v1/actions/products', {
                    action_id: promo.id,
                    offset,
                    limit: PAGE_LIMIT
                }, { metadata: { summary: `promo ${promo.id} products offset=${offset}` } });

                const products = response.data.result?.products || [];

                for (const p of products) {
                    if (p.id && p.action_price != null) {
                        const existing = promoMap.get(p.id);
                        // If product is in multiple promos, keep the one with the lowest price (worst case)
                        if (!existing || p.action_price < existing.promo_price) {
                            promoMap.set(p.id, {
                                promo_price: p.action_price,
                                action_id: promo.id,
                                action_name: actionName
                            });
                        }
                    }
                }

                hasMore = products.length >= PAGE_LIMIT;
                if (hasMore) offset += PAGE_LIMIT;
            }
        } catch (error) {
            console.error(`Error fetching products for promo ${promo.id}:`, error.message);
        }

        // Anti-ban delay between different promos
        if (i < promos.length - 1) await sleep(300);
    }

    return promoMap;
}

async function deactivatePromoProducts(clientId, apiKey, storeId, actionId, productIds, source = 'promo_guard') {
    const client = createOzonClient(clientId, apiKey, { source, storeId });
    const BATCH_SIZE = 100;
    const removedIds = [];
    const rejected = []; // { product_id, reason } — товары, которые Ozon отказался удалять

    try {
        for (let i = 0; i < productIds.length; i += BATCH_SIZE) {
            const batch = productIds.slice(i, i + BATCH_SIZE);
            const resp = await client.post('/v1/actions/products/deactivate', {
                action_id: actionId,
                product_ids: batch
            }, { metadata: { summary: `deactivate ${batch.length} products from promo ${actionId}` } });

            // Синхронный ответ: result.product_ids — реально удалённые, result.rejected — отказы с причинами
            const result = resp.data?.result || {};
            const okIds = result.product_ids || [];
            removedIds.push(...okIds);
            for (const r of (result.rejected || [])) {
                rejected.push({ product_id: r.product_id, reason: r.reason || 'unknown' });
            }
            // Если Ozon не вернул структуру (старый формат) — считаем батч принятым
            if (!result.product_ids && !result.rejected) removedIds.push(...batch);

            if (i + BATCH_SIZE < productIds.length) await sleep(300);
        }
        if (rejected.length > 0) {
            console.warn(`[Promo] Action ${actionId}: ${rejected.length}/${productIds.length} deactivations REJECTED. Reasons: ${JSON.stringify(rejected.slice(0, 5))}`);
        }
        return { success: true, removed: removedIds.length, removedIds, rejected };
    } catch (error) {
        console.error(`Error deactivating products from promo ${actionId}:`, error.message);
        return { success: false, error: error.message, removedIds, rejected };
    }
}

// Живой список акций, в которых магазин УЧАСТВУЕТ, с freeze-статусом.
// Источник истины — Ozon, не локальная БД (она устаревает до 30 мин).
async function fetchParticipatingActions(clientId, apiKey, storeId, source = 'promo_exit') {
    const client = createOzonClient(clientId, apiKey, { source, storeId });
    const response = await client.get('/v1/actions', { metadata: { summary: 'participating actions' } });
    const all = response.data.result || [];
    return all
        .filter(a => a.participating_products_count > 0)
        .map(a => ({
            action_id: a.id,
            title: a.title || String(a.id),
            date_end: a.date_end || null,
            participating_count: a.participating_products_count,
            frozen: !!a.freeze_date, // freeze_date заполнен → выйти из акции нельзя до конца
            freeze_date: a.freeze_date || null,
        }));
}

// Живой список акций для выбора в UI: участвующие ИЛИ потенциальные (есть кандидаты).
// Нужен, чтобы можно было разрешить акцию ДО появления в ней товаров (и когда автовывод всё уже вывел).
async function fetchSelectableActions(clientId, apiKey, storeId, source = 'promo_list') {
    const client = createOzonClient(clientId, apiKey, { source, storeId });
    const response = await client.get('/v1/actions', { metadata: { summary: 'selectable actions' } });
    const all = response.data.result || [];
    return all
        .filter(a => (a.participating_products_count > 0) || (a.potential_products_count > 0))
        .map(a => ({
            action_id: a.id,
            title: a.title || String(a.id),
            date_start: a.date_start || null,
            date_end: a.date_end || null,
            participating_count: a.participating_products_count || 0,
            potential_count: a.potential_products_count || 0,
            action_type: a.action_type || null,
            frozen: !!a.freeze_date,
            freeze_date: a.freeze_date || null,
        }));
}

// Полный живой список товаров одной акции (с пагинацией).
async function fetchActionProducts(clientId, apiKey, storeId, actionId, source = 'promo_exit') {
    const client = createOzonClient(clientId, apiKey, { source, storeId });
    const PAGE_LIMIT = 100;
    const products = [];
    let offset = 0;
    while (true) {
        const resp = await client.post('/v1/actions/products', {
            action_id: actionId, offset, limit: PAGE_LIMIT
        }, { metadata: { summary: `action ${actionId} products offset=${offset}` } });
        const page = resp.data.result?.products || [];
        for (const p of page) {
            products.push({
                product_id: p.id,
                action_price: p.action_price ?? null,   // цена в акции
                price: p.price ?? null,                  // обычная цена (для расчёта скидки)
                max_action_price: p.max_action_price ?? null, // макс. цена для участия
                add_mode: p.add_mode || null,
            });
        }
        if (page.length < PAGE_LIMIT) break;
        offset += PAGE_LIMIT;
        await sleep(300);
    }
    return products;
}

// Самозапрет автодобавления в акции Ozon: auto_add_to_ozon_actions_list_enabled=false.
// ВАЖНО: /v1/product/import/prices требует price — берём ТЕКУЩУЮ цену из /v5/product/info/prices
// непосредственно перед отправкой, чтобы не изменить её. Вызывать только когда репрайсер не работает.
async function setAutoAddBlock(clientId, apiKey, storeId, offerIds, enabled = false) {
    const client = createOzonClient(clientId, apiKey, { source: 'promo_block', storeId });
    const BATCH = 100;
    let updated = 0;
    const itemErrors = [];

    for (let i = 0; i < offerIds.length; i += BATCH) {
        const batchOffers = offerIds.slice(i, i + BATCH);

        // 1. Текущие цены и флаги — отправляем цену как есть
        const infoResp = await client.post('/v5/product/info/prices', {
            filter: { offer_id: batchOffers, visibility: 'ALL' },
            limit: BATCH
        }, { metadata: { itemsCount: batchOffers.length, summary: `read prices+flag batch ${Math.floor(i / BATCH) + 1}` } });

        const prices = [];
        for (const item of (infoResp.data.items || [])) {
            const p = item.price || {};
            // Пропускаем товары, у которых флаг уже в нужном состоянии (в v5 — boolean)
            if (p.auto_add_to_ozon_actions_list_enabled === enabled) continue;
            if (!(parseFloat(p.price) > 0)) continue; // без цены import/prices отклонит
            prices.push({
                offer_id: item.offer_id,
                price: String(p.price),
                old_price: p.old_price != null ? String(p.old_price) : undefined,
                min_price: p.min_price != null ? String(p.min_price) : undefined,
                currency_code: p.currency_code || 'RUB',
                // В import/prices поле — enum (boolean даёт 400 «invalid value for enum field»)
                auto_add_to_ozon_actions_list_enabled: enabled ? 'ENABLED' : 'DISABLED',
            });
        }
        if (prices.length === 0) continue;

        // 2. Отправка флага с неизменённой ценой
        const resp = await client.post('/v1/product/import/prices', { prices }, {
            metadata: { itemsCount: prices.length, summary: `set auto_add_block=${!enabled} batch ${Math.floor(i / BATCH) + 1}` }
        });
        for (const r of (resp.data.result || [])) {
            if (r.errors && r.errors.length > 0) {
                itemErrors.push({ offer_id: r.offer_id, errors: r.errors });
            } else {
                updated++;
            }
        }
        if (i + BATCH < offerIds.length) await sleep(500);
    }

    if (itemErrors.length > 0) {
        console.warn(`[PromoBlock] store ${storeId}: ${itemErrors.length} items failed to set flag:`, JSON.stringify(itemErrors.slice(0, 5)));
    }
    return { updated, itemErrors };
}

// Lightweight: just fetch action list with names (no product pagination)
async function fetchPromoList(clientId, apiKey, storeId) {
    const client = createOzonClient(clientId, apiKey, { source: 'promo_list', storeId });
    try {
        const response = await client.get('/v1/actions', { metadata: { summary: 'fetch promo list' } });
        const promos = (response.data.result || []).filter(p => p.action_type !== undefined);
        return promos.map(p => ({
            action_id: p.id,
            title: p.title || p.name || String(p.id),
            date_start: p.date_start || null,
            date_end: p.date_end || null,
            action_type: p.action_type || null,
        }));
    } catch (err) {
        console.error('fetchPromoList error:', err.message);
        return [];
    }
}

/**
 * Продажи по SKU/день для стратегий (РФ2). Источник — /v1/analytics/data (ordered_units, revenue
 * по sku×day), маппинг sku→offer_id строим из /v3/product/info/list (sources[].sku).
 * Возвращает [{ offer_id, date, units, revenue }].
 */
async function fetchSales(store, fromDate, toDate) {
    const { client_id, api_key } = store;
    const client = createOzonClient(client_id, api_key, { source: 'sales', storeId: store.id });

    // 1. Аналитика продаж по sku/день.
    // /v1/analytics/data жёстко лимитирован (429 при конкуренции магазинов в кроне 04:00) —
    // ретраим с минутной паузой, иначе магазин молча остаётся без данных продаж.
    async function postAnalyticsWithRetry(body, meta) {
        const RETRIES = 5;
        for (let attempt = 0; ; attempt++) {
            try {
                return await client.post('/v1/analytics/data', body, meta);
            } catch (e) {
                if (e.response?.status === 429 && attempt < RETRIES) {
                    const delay = 65000;
                    console.warn(`[Ozon sales] 429 analytics (store ${store.id}), retry ${attempt + 1}/${RETRIES} in ${delay / 1000}s`);
                    await sleep(delay);
                    continue;
                }
                throw e;
            }
        }
    }
    const rows = [];
    let offset = 0;
    while (true) {
        const r = await postAnalyticsWithRetry({
            date_from: fromDate, date_to: toDate,
            metrics: ['ordered_units', 'revenue'], dimension: ['sku', 'day'],
            limit: 1000, offset,
        }, { metadata: { summary: `analytics ${fromDate}..${toDate} off=${offset}` } });
        const data = r.data.result?.data || [];
        for (const d of data) {
            const sku = Number(d.dimensions?.[0]?.id);
            const day = d.dimensions?.[1]?.id;
            if (!sku || !day) continue;
            rows.push({ sku, date: String(day).slice(0, 10), units: d.metrics?.[0] || 0, revenue: d.metrics?.[1] || 0 });
        }
        if (data.length < 1000) break;
        offset += 1000;
        await sleep(1000);
    }
    if (rows.length === 0) return [];

    // 2. Карта sku→offer_id из product info (sources)
    const products = await db.getStoreProducts(store.id);
    const ids = products.map(p => p.product_id).filter(Boolean);
    const skuToOffer = new Map();
    for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        try {
            const info = await client.post('/v3/product/info/list', { product_id: batch },
                { metadata: { summary: `info for sku map batch ${i / 100 + 1}` } });
            for (const item of (info.data.items || [])) {
                for (const s of (item.sources || [])) if (s.sku) skuToOffer.set(Number(s.sku), item.offer_id);
            }
        } catch (e) { console.warn('[Ozon sales] sku map batch failed:', e.message); }
        await sleep(500);
    }

    // 3. Маппинг + агрегация (sku одного offer могут дублироваться fbo/fbs → суммируем)
    const agg = new Map();
    for (const r of rows) {
        const offer = skuToOffer.get(r.sku);
        if (!offer) continue;
        const key = `${offer}|${r.date}`;
        let a = agg.get(key);
        if (!a) { a = { offer_id: offer, date: r.date, units: 0, revenue: 0 }; agg.set(key, a); }
        a.units += r.units; a.revenue += r.revenue;
    }
    return [...agg.values()];
}

module.exports = {
    syncStore, updateProductPrices, syncProduct, fetchProductVisibility, fetchActivePromos,
    deactivatePromoProducts, fetchProductStocks, fetchPromoList,
    fetchParticipatingActions, fetchActionProducts, setAutoAddBlock,
    fetchSelectableActions, fetchSales,
};
