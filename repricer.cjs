const db = require('./db.cjs');
const Sentry = require('./sentry.server.cjs');
const ozonFetcher = require('./ozonFetcher.cjs');
const { createOzonClient } = require('./lib/ozonClient.cjs');
const { computeOldPrice } = require('./lib/priceHelpers.cjs');
const { computeFloorMinPrice } = require('./lib/priceFloor.cjs');

// Запись в repricer_log с гарантией видимости ошибки записи (SQLITE_BUSY и т.п.)
function logRepricerSafe(storeId, logId, entry) {
    db.insertRepricerLog(storeId, logId, entry).catch(err => {
        console.error(`[Repricer] Failed to write repricer_log (offer ${entry.offerId}, action ${entry.action}):`, err.message);
        Sentry.withScope(scope => {
            scope.setTag('operation', 'repricer_log_write');
            scope.setTag('store_id', storeId);
            Sentry.captureException(err);
        });
    });
}

async function checkStore(storeId) {
    let logId = null;
    try {
        const store = await db.getStoreById(storeId);
        if (!store || !store.repricer_enabled) return;

        console.log(`[Repricer] Starting check for store ${store.name} (ID: ${storeId})`);

        logId = await db.createLog(storeId);
        await db.addLogEntry(logId, 'INFO', 'REPRICER_INIT', `Started Repricer Check. Thresholds: -${store.threshold_drop_percent}% / +${store.threshold_rise_percent}%`);

        // Load reference prices from DB (saved during Excel import).
        // Товары в ценовом эксперименте (strategy_type != ref_price) ведёт strategyRunner —
        // обычный репрайсер их НЕ трогает (иначе конфликт цен).
        const dbProductsJSON = (await db.getStoreProducts(storeId))
            .filter(p => !(p.in_experiment && p.strategy_type && p.strategy_type !== 'ref_price'))
            // Governance: SKU в утилизации (disposal) не трогаем вовсе — цена заморожена до вывоза.
            .filter(p => p.management_mode !== 'disposal');
        const dbProdMap = new Map();
        const refMap = new Map();
        const productsToCheck = [];

        for (const p of dbProductsJSON) {
            dbProdMap.set(p.offer_id, p);
            if (p.ref_price != null && p.ref_price > 0) {
                refMap.set(p.offer_id, { price: parseFloat(p.ref_price) });
                productsToCheck.push(p.product_id);
            }
        }

        if (refMap.size === 0) {
            await db.addLogEntry(logId, 'WARNING', 'REPRICER_NO_REF', 'Нет эталонных цен в БД. Загрузите цены через импорт Excel.');
            await db.updateLog(logId, { status: 'WARNING', log_text: 'No reference prices in DB', completed: true });
            return;
        }

        await db.addLogEntry(logId, 'INFO', 'REPRICER_REF_LOAD', `Loaded ${refMap.size} reference prices from DB`);

        if (productsToCheck.length === 0) {
            await db.addLogEntry(logId, 'WARNING', 'REPRICER_NO_MATCH', 'No products from reference list found in Ozon DB. Run Sync first?');
            await db.updateLog(logId, { status: 'WARNING', completed: true });
            return;
        }

        const platform = store.platform || 'ozon';
        await db.addLogEntry(logId, 'INFO', 'REPRICER_FETCH', `Fetching prices for ${productsToCheck.length} products from ${platform}...`);

        // Wildberries: отдельная стратегия «держим РРЦ» (не competitor-follower).
        // Целевая discountedPrice = max(РРЦ, floor), регулируем скидку при якоре-базе.
        if (platform === 'wildberries') {
            await enforceWbRepricing(store, dbProductsJSON, dbProdMap, refMap, logId);
            await db.updateLog(logId, { status: 'SUCCESS', items_processed: refMap.size, log_text: 'WB repricer finished', completed: true });
            await db.updateStoreRepricerLastRun(storeId);
            return;
        }

        // Fetch current prices — platform-specific
        const currentPrices = new Map();
        let fetchErrors = 0; // упавшие батчи → частичные данные, фиксируем явно

        if (platform === 'yandex') {
            // Yandex Market: fetch prices via yandexFetcher
            try {
                const ymFetcher = require('./yandexFetcher.cjs');
                const offerIds = [...refMap.keys()];
                const { priceMap, failedBatches } = await ymFetcher.fetchPrices(store.ym_campaign_id, store.ym_api_key, offerIds, storeId);
                fetchErrors += failedBatches;
                for (const [offerId, priceData] of priceMap) {
                    currentPrices.set(offerId, {
                        price: priceData.price,
                        marketing_price: priceData.price,
                        min_price: 0,
                        discount_base: priceData.discountBase || 0,
                        currency: priceData.currencyId || 'RUR'
                    });
                }
            } catch (pkErr) {
                fetchErrors++;
                await db.addLogEntry(logId, 'ERROR', 'REPRICER_FETCH_ERR', `Failed to fetch YM prices: ${pkErr.message}`);
            }
        } else {
            // Ozon: fetch prices via ozonClient
            const client = createOzonClient(store.client_id, store.api_key, { source: 'repricer', storeId });
            const chunkSize = 1000;
            const totalBatches = Math.ceil(productsToCheck.length / chunkSize);

            for (let i = 0; i < productsToCheck.length; i += chunkSize) {
                const batchIds = productsToCheck.slice(i, i + chunkSize);
                const batchNum = Math.floor(i / chunkSize) + 1;
                try {
                    const res = await client.post('/v5/product/info/prices', {
                        filter: { product_id: batchIds, visibility: 'ALL' },
                        limit: 1000
                    }, { metadata: { itemsCount: batchIds.length, summary: `repricer prices batch` } });

                    if (res.data && res.data.items) {
                        for (const item of res.data.items) {
                            const p = item.price;
                            // Use best available commission: FBO > FBS > 0
                            const commFbo = parseFloat(item.commissions?.sales_percent_fbo || 0);
                            const commFbs = parseFloat(item.commissions?.sales_percent_fbs || 0);
                            const commissionPercent = commFbo > 0 ? commFbo : commFbs;
                            const logisticsFbo = parseFloat(item.commissions?.fbo_direct_flow_trans_min_amount || 0);
                            const logisticsFbs = parseFloat(item.commissions?.fbs_direct_flow_trans_min_amount || 0);
                            const logistics = logisticsFbo > 0 ? logisticsFbo : logisticsFbs;
                            currentPrices.set(item.offer_id, {
                                price: parseFloat(p.price),
                                marketing_price: parseFloat(p.marketing_seller_price),
                                min_price: parseFloat(p.min_price),
                                currency: p.currency_code,
                                commission_percent: commissionPercent,
                                logistics,
                                acquiring: parseFloat(item.acquiring || 0),
                            });
                        }
                    }
                } catch (pkErr) {
                    fetchErrors++;
                    const msg = `Failed to fetch price batch ${batchNum}/${totalBatches} (${batchIds.length} items): ${pkErr.message}`;
                    console.error(`[Repricer] store ${storeId}: ${msg}`);
                    await db.addLogEntry(logId, 'ERROR', 'REPRICER_FETCH_ERR', msg);
                }
            }
        }

        if (fetchErrors > 0) {
            await db.addLogEntry(logId, 'WARNING', 'REPRICER_PARTIAL',
                `${fetchErrors} price batch(es) failed — analysis will cover only ${currentPrices.size}/${refMap.size} products`);
            Sentry.withScope(scope => {
                scope.setTag('operation', 'repricer');
                scope.setTag('store_id', storeId);
                Sentry.captureMessage(`Repricer partial data: ${fetchErrors} failed batches, ${currentPrices.size}/${refMap.size} products covered`, 'warning');
            });
        }

        // Compare and analyze
        const updatesToSend = [];
        let criticalDrops = 0;
        let okCount = 0;
        let skippedNoPrice = 0;      // нет в ответе API (не вернулся / упавший батч)
        let skippedInvalidPrice = 0; // цена 0 или отрицательная
        let skippedPromo = 0;
        let skippedQuarantine = 0;
        let skippedBelowCost = 0;

        for (const [offerId, refData] of refMap) {
            const curr = currentPrices.get(offerId);
            if (!curr) { skippedNoPrice++; continue; }

            const dbP = dbProdMap.get(offerId);

            const refPrice = refData.price;
            // Use seller-controlled price (not Ozon co-funded promo price) for comparison
            const currentPrice = curr.price > 0 ? curr.price : curr.marketing_price;
            if (currentPrice <= 0 || refPrice <= 0) { skippedInvalidPrice++; continue; }

            const diff = refPrice - currentPrice;
            const diffPercent = (diff / refPrice) * 100;
            const productName = dbP?.name || offerId;

            // Skip products in promo
            if (dbP && dbP.in_promo) {
                skippedPromo++;
                await db.addLogEntry(logId, 'INFO', 'REPRICER_SKIP', `Skipping ${offerId}: in promo`);
                logRepricerSafe(storeId, logId, {
                    offerId, productName, oldPrice: currentPrice, newPrice: currentPrice,
                    refPrice, deviationPercent: diffPercent, action: 'skipped_promo', reason: 'Товар в промо-акции'
                });
                continue;
            }

            // Skip products in quarantine
            if (dbP && dbP.is_quarantine) {
                skippedQuarantine++;
                await db.addLogEntry(logId, 'INFO', 'REPRICER_SKIP', `Skipping ${offerId}: quarantine`);
                logRepricerSafe(storeId, logId, {
                    offerId, productName, oldPrice: currentPrice, newPrice: currentPrice,
                    refPrice, deviationPercent: diffPercent, action: 'skipped_quarantine', reason: 'Товар в карантине'
                });
                continue;
            }

            if (diff > 0) {
                // Any drop below ref_price must be corrected regardless of threshold
                // Skip if corrected price would be below cost_price
                if (dbP && dbP.cost_price != null && refPrice < dbP.cost_price) {
                    skippedBelowCost++;
                    await db.addLogEntry(logId, 'INFO', 'REPRICER_SKIP', `Skipping ${offerId}: result below cost price (ref: ${refPrice}, cost: ${dbP.cost_price})`);
                    logRepricerSafe(storeId, logId, {
                        offerId, productName, oldPrice: currentPrice, newPrice: refPrice,
                        refPrice, deviationPercent: diffPercent, action: 'skipped_below_cost',
                        reason: `Цена ${refPrice} ниже себестоимости ${dbP.cost_price}`
                    });
                    continue;
                }

                criticalDrops++;
                const logLevel = diffPercent >= store.threshold_drop_percent ? 'WARNING' : 'INFO';
                const dropLabel = diffPercent >= store.threshold_drop_percent ? 'CRITICAL_DROP' : 'MINOR_DROP';
                await db.addLogEntry(logId, logLevel, dropLabel,
                    `[${offerId}] Ref: ${refPrice}, Curr: ${currentPrice}. Drop: ${diffPercent.toFixed(2)}%. Preparing restore.`);

                logRepricerSafe(storeId, logId, {
                    offerId, productName, oldPrice: currentPrice, newPrice: refPrice,
                    refPrice, deviationPercent: diffPercent, action: 'corrected',
                    reason: `Цена упала на ${diffPercent.toFixed(1)}%`
                });

                let effectiveMinPrice = parseFloat(curr.min_price) || 0;
                // Правило Ozon: min_price не меньше 50% от цены, иначе весь апдейт позиции
                // отклоняется с min_auto_price_too_small (и цена НЕ восстанавливается).
                if (effectiveMinPrice > 0 && effectiveMinPrice < refPrice * 0.5) {
                    effectiveMinPrice = Math.ceil(refPrice * 0.5);
                }
                updatesToSend.push({
                    offer_id: offerId,
                    price: String(refPrice),
                    old_price: String(computeOldPrice(refPrice, effectiveMinPrice)),
                    min_price: String(effectiveMinPrice),
                    currency_code: curr.currency,
                    _oldPrice: currentPrice
                });
            } else {
                okCount++;
                logRepricerSafe(storeId, logId, {
                    offerId, productName, oldPrice: currentPrice, newPrice: currentPrice,
                    refPrice, deviationPercent: diffPercent, action: 'ok',
                    reason: null
                });
            }
        }

        // Полный итог: каждая ref-позиция учтена в одной из категорий
        const summary = {
            total_ref: refMap.size,
            ok: okCount,
            corrected: criticalDrops,
            skipped_promo: skippedPromo,
            skipped_quarantine: skippedQuarantine,
            skipped_below_cost: skippedBelowCost,
            skipped_no_price: skippedNoPrice,
            skipped_invalid_price: skippedInvalidPrice,
            fetch_errors: fetchErrors,
        };
        const summaryLevel = (skippedNoPrice > 0 || fetchErrors > 0) ? 'WARNING' : 'INFO';
        await db.addLogEntry(logId, summaryLevel, 'REPRICER_SUMMARY', JSON.stringify(summary));
        console.log(`[Repricer] store ${storeId} summary:`, JSON.stringify(summary));

        // === Price Floor Enforcement ===
        // Работает для ВСЕХ товаров с cost_price, включая промо — независимо от ref_price.
        // YM floor запускается ВСЕГДА (при tax_rate=0 внутри будет WARNING, а не тихий пропуск).
        if (platform === 'yandex') {
            await enforceYandexFloor(store, dbProductsJSON, currentPrices, logId);
        } else if (store.tax_rate != null) {
            const floorUpdates = [];
            let floorAdjusted = 0;
            let floorNoPriceData = 0; // есть cost_price, но цена не получена от API

            for (const p of dbProductsJSON) {
                if (!p.cost_price || p.cost_price <= 0) continue;
                const curr = currentPrices.get(p.offer_id);
                if (!curr) { floorNoPriceData++; continue; }

                const floor = computeFloorMinPrice({
                    costPrice: parseFloat(p.cost_price),
                    commissionRate: curr.commission_percent,
                    logisticsAmount: curr.logistics,
                    acquiringAmount: curr.acquiring,
                    taxRate: parseFloat(store.tax_rate),
                    marginPercent: parseFloat(store.min_margin_percent || 0),
                });

                if (floor === null) continue;

                // Сохраняем расчётный пол в БД для отображения в UI
                db.updateProductFloorPrice(storeId, p.offer_id, floor);

                const minPriceBelowFloor = curr.min_price < floor;
                const priceBelowFloor = curr.price > 0 && curr.price < floor;

                // Detect Ozon co-funded promo: seller's price is OK but marketing_price is lower
                // (Ozon applies its own discount — seller can't override via API)
                if (!minPriceBelowFloor && !priceBelowFloor && curr.marketing_price > 0 && curr.marketing_price < floor) {
                    await db.addLogEntry(logId, 'WARNING', 'OZON_PROMO_BELOW_FLOOR',
                        `[${p.offer_id}] Ozon co-funded promo selling below floor: marketing_price ${curr.marketing_price} < floor ${floor}. ` +
                        `Seller price ${curr.price} is correct. Remove product from Ozon promotion manually.`);
                }

                if (minPriceBelowFloor || priceBelowFloor) {
                    floorAdjusted++;
                    const reason = priceBelowFloor
                        ? `price ${curr.price} < floor ${floor}`
                        : `min_price ${curr.min_price} < floor ${floor}`;
                    await db.addLogEntry(logId, 'WARNING', 'FLOOR_BREACH',
                        `[${p.offer_id}] ${reason} ` +
                        `(cost: ${p.cost_price}, tax: ${store.tax_rate}%, commission: ${curr.commission_percent}%, logistics: ${curr.logistics}). Setting min_price=${floor}.`);
                    // price must be >= min_price (Ozon validation rule)
                    const effectivePrice = Math.max(curr.price > 0 ? curr.price : floor, floor);
                    const effectiveOldPrice = computeOldPrice(effectivePrice, floor);
                    floorUpdates.push({
                        offer_id: p.offer_id,
                        price: String(effectivePrice),
                        old_price: String(effectiveOldPrice),
                        min_price: String(floor),
                        currency_code: curr.currency || 'RUB',
                    });
                }
            }

            if (floorUpdates.length > 0) {
                await db.addLogEntry(logId, 'INFO', 'FLOOR_ACTION', `Enforcing price floor for ${floorUpdates.length} products...`);
                try {
                    const BATCH_SIZE = 1000;
                    for (let i = 0; i < floorUpdates.length; i += BATCH_SIZE) {
                        const batch = floorUpdates.slice(i, i + BATCH_SIZE);
                        await ozonFetcher.updateProductPrices(store.client_id, store.api_key, batch, storeId, 'repricer-floor');
                    }
                    await db.addLogEntry(logId, 'INFO', 'FLOOR_DONE', `Price floor enforced for ${floorAdjusted} products.`);
                } catch (floorErr) {
                    await db.addLogEntry(logId, 'ERROR', 'FLOOR_SEND_FAIL', `Failed to enforce floor: ${floorErr.message}`);
                }
            } else {
                const withCost = dbProductsJSON.filter(p => p.cost_price > 0).length;
                await db.addLogEntry(logId, 'INFO', 'FLOOR_OK', `All ${withCost} products with cost_price are above floor.`);
            }

            if (floorNoPriceData > 0) {
                await db.addLogEntry(logId, 'WARNING', 'FLOOR_NO_DATA',
                    `${floorNoPriceData} products with cost_price had no current price from API — floor not checked for them`);
            }
        }

        // Send updates
        if (updatesToSend.length > 0) {
            // Create repricer snapshot before sending
            const snapshotData = updatesToSend.map(u => ({
                offer_id: u.offer_id,
                price: u._oldPrice,
                new_price: parseFloat(u.price),
            }));
            await db.createSnapshot(storeId, 'repricer', updatesToSend.length, JSON.stringify(snapshotData), 'repricer', `Repricer: скорректировано ${updatesToSend.length} позиций`);

            await db.addLogEntry(logId, 'INFO', 'REPRICER_ACTION', `Sending ${updatesToSend.length} price corrections to ${platform}...`);
            try {
                if (platform === 'yandex') {
                    const ymFetcher = require('./yandexFetcher.cjs');
                    const ymUpdates = updatesToSend.map(u => {
                        const newPrice = parseFloat(u.price);
                        // discountBase обязан сохраняться при каждом обновлении —
                        // иначе Яндекс удаляет зачёркнутую цену (правило API).
                        // Требование YM: скидка от discountBase — 5–99%.
                        const existingBase = currentPrices.get(u.offer_id)?.discount_base || 0;
                        const discountBase = existingBase >= Math.ceil(newPrice * 1.06)
                            ? existingBase
                            : Math.ceil(newPrice * 1.25);
                        return {
                            offerId: u.offer_id,
                            price: { value: newPrice, discountBase, currencyId: 'RUR' }
                        };
                    });
                    const res = await ymFetcher.updatePrices(store.ym_campaign_id, store.ym_api_key, ymUpdates, storeId, 'repricer');
                    await db.addLogEntry(logId, 'INFO', 'REPRICER_SENT', `YM batch sent. Result: ${JSON.stringify(res)}`);
                } else {
                    const BATCH_SIZE = 1000;
                    for (let i = 0; i < updatesToSend.length; i += BATCH_SIZE) {
                        const batch = updatesToSend.slice(i, i + BATCH_SIZE).map(({ _oldPrice, ...rest }) => rest);
                        const res = await ozonFetcher.updateProductPrices(store.client_id, store.api_key, batch, storeId, 'repricer');
                        await db.addLogEntry(logId, 'INFO', 'REPRICER_SENT', `Batch sent. Result: ${JSON.stringify(res)}`);
                        // Per-item отказы Ozon (HTTP 200, но errors[] у позиции) — иначе
                        // «corrected» в логе врёт, а цена на площадке не меняется.
                        if (Array.isArray(res?._itemErrors) && res._itemErrors.length > 0) {
                            for (const ie of res._itemErrors) {
                                const sent = updatesToSend.find(u => u.offer_id === ie.offer_id);
                                const errText = (ie.errors || []).map(e => `${e.code}: ${e.message || ''}`).join('; ').slice(0, 300);
                                await db.addLogEntry(logId, 'WARNING', 'REPRICER_ITEM_REJECT', `[${ie.offer_id}] Ozon отклонил цену: ${errText}`);
                                logRepricerSafe(storeId, logId, {
                                    offerId: ie.offer_id, productName: null,
                                    oldPrice: sent ? sent._oldPrice : 0,
                                    newPrice: sent ? parseFloat(sent.price) : 0,
                                    refPrice: sent ? parseFloat(sent.price) : null,
                                    deviationPercent: null, action: 'rejected',
                                    reason: errText,
                                });
                            }
                        }
                    }
                }
            } catch (sendErr) {
                await db.addLogEntry(logId, 'ERROR', 'REPRICER_SEND_FAIL', `Failed to send corrections: ${sendErr.message}`);
                throw sendErr;
            }
        } else {
            await db.addLogEntry(logId, 'INFO', 'REPRICER_NO_ACTION', 'No critical deviations found.');
        }

        await db.updateLog(logId, {
            status: 'SUCCESS',
            items_processed: okCount + criticalDrops,
            items_changed: updatesToSend.length,
            log_text: `Repricer Finished. Corrected: ${updatesToSend.length}`,
            completed: true
        });

        await db.updateStoreRepricerLastRun(storeId);

    } catch (err) {
        console.error(`[Repricer] Error store ${storeId}:`, err);
        Sentry.withScope(scope => {
            scope.setTag('operation', 'repricer');
            scope.setTag('store_id', storeId);
            if (logId) scope.setTag('run_id', String(logId));
            Sentry.captureException(err);
        });
        if (logId) {
            await db.addLogEntry(logId, 'ERROR', 'REPRICER_CRASH', err.message);
            await db.updateLog(logId, { status: 'ERROR', log_text: err.message, completed: true });
        }
    }
}

// === YM Price Floor ===
// Безубыточность для Яндекс.Маркета: реальные удержания из tariffs/calculate
// (комиссия категории, перевод платежа, доставка, средняя миля) + защита от
// авто-акций через minimumForBestseller + контроль фактических продаж.
async function enforceYandexFloor(store, dbProductsJSON, currentPrices, logId) {
    const storeId = store.id;
    const ymFetcher = require('./yandexFetcher.cjs');
    const { computeYmFloor, computeYmSellerPayout } = require('./lib/ymFloor.cjs');

    // Параметры экономики магазина
    const taxRate = parseFloat(store.tax_rate) || 0;          // налог С ВЫРУЧКИ (УСН «Доходы»)
    const marginPct = parseFloat(store.min_margin_percent) || 0;
    // Потолок буст-буфера и шаг роста цены за прогон (мягкий предохранитель)
    const boostCap = store.ym_boost_cap_percent != null ? parseFloat(store.ym_boost_cap_percent) : 30;
    const maxRaisePct = store.ym_floor_max_raise_percent != null ? parseFloat(store.ym_floor_max_raise_percent) : 20;

    // Гард: не молчим, если налог не задан — floor посчитается (как % с выручки = 0),
    // но защита неполная. Раньше при tax_rate=0 весь блок тихо пропускался.
    if (taxRate <= 0) {
        await db.addLogEntry(logId, 'WARNING', 'YM_FLOOR_NO_TAX',
            'Налоговая ставка магазина не задана (0%). Floor считается без налога — защита от минуса неполная. Укажите ставку УСН «Доходы» в настройках магазина.');
    }

    // Кандидаты: есть себестоимость + категория Маркета (для тарифов)
    const candidates = [];
    let noCategory = 0;
    for (const p of dbProductsJSON) {
        if (!p.cost_price || p.cost_price <= 0) continue;
        const livePrice = currentPrices.get(p.offer_id)?.price;
        const price = (livePrice > 0 ? livePrice : parseFloat(p.price)) || 0;
        if (price <= 0) continue;
        if (!p.ym_category_id) { noCategory++; continue; }
        const dims = p.ym_dims || {};
        candidates.push({
            offerId: p.offer_id,
            categoryId: p.ym_category_id,
            price,
            length: dims.length, width: dims.width, height: dims.height, weight: dims.weight,
            costPrice: parseFloat(p.cost_price),
            storedFloor: p.floor_min_price != null ? parseFloat(p.floor_min_price) : null,
            discountBase: currentPrices.get(p.offer_id)?.discount_base || parseFloat(p.old_price) || 0,
        });
    }
    if (noCategory > 0) {
        await db.addLogEntry(logId, 'WARNING', 'YM_FLOOR_NO_CATEGORY',
            `${noCategory} товаров с cost_price без категории Маркета — floor не рассчитан (нужен Sync после обновления)`);
    }
    if (candidates.length === 0) {
        await db.addLogEntry(logId, 'INFO', 'YM_FLOOR_SKIP', 'Нет кандидатов для расчёта floor (нет cost_price или категорий — запустите Sync)');
        return;
    }

    await db.addLogEntry(logId, 'INFO', 'YM_FLOOR_TARIFFS', `Расчёт удержаний YM для ${candidates.length} товаров...`);
    const { tariffMap, failedBatches } = await ymFetcher.fetchTariffs(store.ym_campaign_id, store.ym_api_key, candidates, storeId);
    if (failedBatches > 0) {
        await db.addLogEntry(logId, 'WARNING', 'YM_FLOOR_PARTIAL', `${failedBatches} батч(ей) тарифов упало — floor рассчитан частично (${tariffMap.size}/${candidates.length})`);
    }

    // === Фактическая ставка буста по офферам (из stats/orders за 7 дней) ===
    // Буст НЕ возвращается tariffs/calculate — берём из факта списаний. B1: только
    // офферы, реально продвигавшиеся (bidFee>0) и с достаточной выборкой (≥3 продаж).
    let soldItems = [];
    try {
        soldItems = await ymFetcher.fetchOrdersEconomics(store.ym_campaign_id, store.ym_api_key, storeId, 7);
    } catch (e) {
        await db.addLogEntry(logId, 'WARNING', 'YM_ORDERS_CHECK_FAIL', `Заказы за 7 дней не получены (буст/контроль по факту пропущены): ${e.message}`);
    }
    const boostByOffer = ymFetcher.aggregateBoostByOffer(soldItems, { minUnits: 3 });
    if (boostByOffer.size > 0) {
        await db.addLogEntry(logId, 'INFO', 'YM_BOOST_DETECTED',
            `Буст по факту продаж учтён в floor для ${boostByOffer.size} товаров (потолок ${boostCap}%).`);
    }

    const priceUpdates = [];       // кампанийные цены: поднять (с учётом шага)
    const bestsellerUpdates = [];  // business: minimumForBestseller = floor
    const floorByOffer = new Map();
    const netByOffer = new Map();
    const feesByOffer = new Map();
    let breaches = 0, computed = 0, cappedRaises = 0, maxJumpPct = 0, boostedCount = 0;

    for (const c of candidates) {
        const fees = tariffMap.get(c.offerId);
        if (!fees) continue;
        const rawBoost = boostByOffer.get(c.offerId);
        const boostPct = rawBoost ? Math.min(rawBoost.boostPct, boostCap) : 0;
        if (boostPct > 0) boostedCount++;

        const floor = computeYmFloor({
            costPrice: c.costPrice,
            pctFees: fees.percentSum,
            absFees: fees.absoluteSum,
            taxPercent: taxRate,
            boostPercent: boostPct,
            marginPercent: marginPct,
        });
        if (floor === null) {
            await db.addLogEntry(logId, 'WARNING', 'YM_FLOOR_ANOMALY',
                `[${c.offerId}] удержания+налог+буст (${fees.percentSum.toFixed(1)}%+${taxRate}%+${boostPct.toFixed(1)}%) ≥ 95% — floor не считаем, проверьте категорию`);
            continue;
        }
        computed++;
        const netNeeded = c.costPrice * (1 + marginPct / 100);
        floorByOffer.set(c.offerId, floor);
        netByOffer.set(c.offerId, netNeeded);
        feesByOffer.set(c.offerId, fees);

        db.updateProductFloorPrice(storeId, c.offerId, floor);

        // Требование YM: скидка от discountBase — 5–99% от ЦЕНЫ обновления
        const baseFor = (value) => c.discountBase >= Math.ceil(value * 1.06) ? c.discountBase : Math.ceil(value * 1.25);

        if (c.price < floor) {
            breaches++;
            // Мягкий предохранитель: за один прогон не задираем цену больше чем на maxRaisePct.
            // Floor достигается за несколько прогонов — не теряем buybox разом.
            const capByStep = Math.ceil(c.price * (1 + maxRaisePct / 100));
            const target = Math.min(floor, capByStep);
            const jumpPct = (target - c.price) / c.price * 100;
            maxJumpPct = Math.max(maxJumpPct, jumpPct);
            const partial = target < floor;
            if (partial) cappedRaises++;
            await db.addLogEntry(logId, 'WARNING', 'YM_FLOOR_BREACH',
                `[${c.offerId}] цена ${c.price} < floor ${floor} ` +
                `(себест. ${c.costPrice}, удержания ${fees.percentSum.toFixed(1)}% + ${fees.absoluteSum.toFixed(0)}₽, налог ${taxRate}%` +
                `${boostPct > 0 ? `, буст ${boostPct.toFixed(1)}%` : ''}). ` +
                (partial ? `Поднимаем до ${target} (шаг +${maxRaisePct}%, дойдём за неск. прогонов).` : `Поднимаем до floor.`));
            priceUpdates.push({
                offerId: c.offerId,
                price: { value: target, discountBase: baseFor(target), currencyId: 'RUR' },
            });
        }

        // minimumForBestseller = ПОЛНЫЙ floor (защита от авто-акций бьёт независимо от
        // постепенного роста кампанийной цены). Обновляем только при изменении floor.
        if (c.storedFloor === null || Math.abs(c.storedFloor - floor) >= 1) {
            const value = Math.max(c.price, floor);
            bestsellerUpdates.push({
                offerId: c.offerId,
                price: value,
                discountBase: baseFor(value),
                minimumForBestseller: floor,
            });
        }
    }

    await db.addLogEntry(logId, 'INFO', 'YM_FLOOR_SUMMARY',
        `floor рассчитан для ${computed} товаров, с бустом: ${boostedCount}, нарушений: ${breaches} ` +
        `(из них рост ограничен шагом: ${cappedRaises}, макс. скачок ${maxJumpPct.toFixed(1)}%), minimumForBestseller: ${bestsellerUpdates.length}.`);

    if (priceUpdates.length > 0) {
        try {
            await ymFetcher.updatePrices(store.ym_campaign_id, store.ym_api_key, priceUpdates, storeId, 'repricer-floor');
            await db.addLogEntry(logId, 'INFO', 'YM_FLOOR_DONE', `Цены подняты к floor: ${priceUpdates.length} товаров.`);
        } catch (e) {
            await db.addLogEntry(logId, 'ERROR', 'YM_FLOOR_SEND_FAIL', `Не удалось поднять цены до floor: ${e.message}`);
        }
    }

    if (bestsellerUpdates.length > 0) {
        try {
            await ymFetcher.updateBusinessPrices(store.ym_business_id, store.ym_api_key, bestsellerUpdates, storeId, 'repricer-floor');
            await db.addLogEntry(logId, 'INFO', 'YM_BESTSELLER_MIN',
                `minimumForBestseller (защита от авто-акций) выставлен для ${bestsellerUpdates.length} товаров.`);
        } catch (e) {
            await db.addLogEntry(logId, 'ERROR', 'YM_BESTSELLER_FAIL', `Не удалось выставить minimumForBestseller: ${e.message}`);
        }
    }

    // === Контроль фактической экономики: по ВЫПЛАТЕ ПРОДАВЦА, а не цене покупателя ===
    // Считаем реальную выплату на руки (sellerPrice − комиссии − налог − фикс − буст)
    // и сравниваем с себестоимостью+маржой. buyerPrice искажён кешбэком/софинансированием.
    const lossSales = [];   // { offerId, sellerPrice, payout, net }
    let totalSales = 0, boostedSales = 0;
    for (const it of soldItems) {
        totalSales++;
        if (it.bidFee) boostedSales++;
        const fees = feesByOffer.get(it.offerId);
        const net = netByOffer.get(it.offerId);
        if (!fees || net == null || it.sellerPrice == null) continue;
        const cnt = it.count || 1;
        const payout = computeYmSellerPayout({
            sellerPrice: it.sellerPrice,
            pctFees: fees.percentSum,
            absFees: fees.absoluteSum,
            taxPercent: taxRate,
            boostAmount: (it.bidFee || 0) / cnt,   // буст на единицу
        });
        if (payout < net) lossSales.push({ offerId: it.offerId, sellerPrice: it.sellerPrice, payout: Math.round(payout), net: Math.round(net) });
    }
    if (lossSales.length > 0) {
        const ex = lossSales.slice(0, 5).map(l => `${l.offerId}: выплата ${l.payout}₽ < нужно ${l.net}₽ (цена прод. ${l.sellerPrice})`);
        await db.addLogEntry(logId, 'WARNING', 'YM_SOLD_BELOW_FLOOR',
            `За 7 дней ${lossSales.length}/${totalSales} позиций проданы В МИНУС по фактической выплате продавца ` +
            `(комиссии+налог+буст превысили маржу). Примеры: ${ex.join('; ')}.`);
    }
    if (totalSales > 0 && boostedSales / totalSales > 0.5) {
        await db.addLogEntry(logId, 'WARNING', 'YM_BOOST_HEAVY',
            `Буст продаж на ${boostedSales}/${totalSales} (${Math.round(boostedSales / totalSales * 100)}%) проданных позиций — рекламный расход поверх комиссий. Учтён в floor, но проверьте ставки буста в кабинете.`);
    }

    // === Активный вывод убыточных товаров из акций (dry-run по умолчанию) ===
    await exitLossMakingPromos(store, candidates, floorByOffer, currentPrices, lossSales, logId);
}

/**
 * Выводит из акций Маркета товары, которые из-за акционной/софинансируемой скидки
 * торгуются ниже floor. По умолчанию РЕЖИМ DRY-RUN: только логируем кандидатов.
 * Реальный вывод — только при store.ym_promo_exit_enabled === 1.
 * Уважает promo_allowed_actions (из этих акций НЕ выводим) и лимит на прогон.
 */
async function exitLossMakingPromos(store, candidates, floorByOffer, currentPrices, lossSales, logId) {
    const storeId = store.id;
    const ymFetcher = require('./yandexFetcher.cjs');
    const dryRun = store.ym_promo_exit_enabled !== 1;
    const MAX_EXITS = 100; // предохранитель: не выводим лавину за один прогон

    // Кандидаты на вывод: участвуют в акции И текущая цена ниже floor (акция топит ниже пола)
    const offersByFloorBreach = new Set();
    for (const c of candidates) {
        const floor = floorByOffer.get(c.offerId);
        const live = currentPrices.get(c.offerId)?.price;
        if (floor && live > 0 && live < floor) offersByFloorBreach.add(c.offerId);
    }
    for (const l of (lossSales || [])) offersByFloorBreach.add(l.offerId);
    if (offersByFloorBreach.size === 0) return;

    let participation;
    try {
        const res = await ymFetcher.fetchPromoParticipation(store.ym_business_id, store.ym_api_key, storeId);
        if (res.error) {
            await db.addLogEntry(logId, 'WARNING', 'YM_PROMO_CHECK_FAIL', `Участие в акциях не получено: ${res.error}`);
            return;
        }
        participation = res.participating;
    } catch (e) {
        await db.addLogEntry(logId, 'WARNING', 'YM_PROMO_CHECK_FAIL', `Участие в акциях не получено: ${e.message}`);
        return;
    }

    let allowed = [];
    try { allowed = JSON.parse(store.promo_allowed_actions || '[]'); } catch { allowed = []; }
    const allowedSet = new Set(allowed.map(String));

    const toExit = [];
    for (const offerId of offersByFloorBreach) {
        const part = participation.get(offerId);
        if (!part) continue;                              // в акциях не участвует — выводить нечего
        if (allowedSet.has(String(part.promoId))) continue; // акция в белом списке — не трогаем
        toExit.push({ offerId, promoId: part.promoId, promoName: part.promoName, status: part.status });
        if (toExit.length >= MAX_EXITS) break;
    }
    if (toExit.length === 0) return;

    const ex = toExit.slice(0, 8).map(t => `${t.offerId}→«${t.promoName || t.promoId}» (${t.status})`);
    if (dryRun) {
        await db.addLogEntry(logId, 'WARNING', 'YM_PROMO_EXIT_DRYRUN',
            `[DRY-RUN] ${toExit.length} убыточных товаров участвуют в акциях ниже floor — кандидаты на вывод: ${ex.join('; ')}. ` +
            `Включите ym_promo_exit_enabled для автоматического вывода.`);
        return;
    }

    try {
        const res = await ymFetcher.removeFromPromo(store.ym_business_id, store.ym_api_key, toExit, storeId);
        await db.addLogEntry(logId, res.removed > 0 ? 'INFO' : 'WARNING', 'YM_PROMO_EXIT_DONE',
            `Выведено из акций: ${res.removed} товаров. ${ex.join('; ')}` +
            (res.errors.length ? ` Ошибки: ${res.errors.slice(0, 3).join('; ')}` : ''));
    } catch (e) {
        await db.addLogEntry(logId, 'ERROR', 'YM_PROMO_EXIT_FAIL', `Не удалось вывести из акций: ${e.message}`);
    }
}

// === WB: удержание РРЦ + floor по юнит-экономике ===
// Целевая discountedPrice (выручка продавца) = max(РРЦ из Excel, floor).
// Базовую (зачёркнутую) цену держим якорем, регулируем скидку продавца (Math.floor → не ниже floor).
// СПП не трогаем — это соинвест WB поверх discountedPrice.
async function enforceWbRepricing(store, dbProductsJSON, dbProdMap, refMap, logId) {
    const storeId = store.id;
    const wbFetcher = require('./wbFetcher.cjs');
    const { computeWbFloor, computeBoxLogistics, computeWbPricePair, discountedFromPair } = require('./lib/wbPricing.cjs');
    const apiKey = store.wb_api_key;

    // 1. Текущие цены/скидки с площадки: Map nmID -> { priceBase, discount, discountedPrice }
    let priceMap = new Map();
    try {
        priceMap = await wbFetcher.fetchPrices(apiKey, storeId);
    } catch (e) {
        await db.addLogEntry(logId, 'ERROR', 'WB_FETCH_PRICES', `Не удалось получить цены WB: ${e.message}`);
        return;
    }

    // 2. Юнит-экономика: комиссии по категориям + тариф короба (некритично — без них floor пропускаем)
    let commissionMap = new Map();
    let boxTariff = { base: 0, liter: 0 };
    try { commissionMap = await wbFetcher.fetchCommissions(apiKey, storeId); }
    catch (e) { await db.addLogEntry(logId, 'WARNING', 'WB_COMMISSIONS', `Комиссии не получены: ${e.message}`); }
    try { boxTariff = await wbFetcher.fetchBoxTariffs(apiKey, storeId); }
    catch (e) { await db.addLogEntry(logId, 'WARNING', 'WB_BOX_TARIFFS', `Тариф короба не получен: ${e.message}`); }

    const taxRate = parseFloat(store.tax_rate || 0);
    const marginPercent = parseFloat(store.min_margin_percent || 0);
    const buyoutShare = 0.7; // оценка доли выкупа; обратную логистику закладываем на (1 - buyout)

    const updates = [];   // { nmID, price, discount }
    let repriced = 0, held = 0, raisedToFloor = 0, noRef = 0, noEcon = 0, skippedBelowFloor = 0, stepwise = 0, skippedBadRef = 0;
    const examples = [];
    const badRefExamples = [];

    for (const p of dbProductsJSON) {
        const nmID = p.product_id;
        const ref = refMap.get(p.offer_id); // РРЦ из Excel-импорта
        if (!ref || !(ref.price > 0)) { noRef++; continue; }

        const cost = p.cost_price > 0 ? parseFloat(p.cost_price) : null;

        // === ПРЕДОХРАНИТЕЛЬ от ошибки пользователя ===
        // РРЦ ниже себестоимости — почти наверняка опечатка/пустая ячейка в Excel.
        // НЕ репрайсим такой товар (иначе ступенчато уроним в убыток), фиксируем в алерт.
        if (cost != null && ref.price < cost) {
            skippedBadRef++;
            if (badRefExamples.length < 10) badRefExamples.push(`${p.offer_id}: РРЦ ${ref.price} < себест. ${cost}`);
            logRepricerSafe(storeId, logId, {
                offerId: p.offer_id, productName: p.name || p.offer_id,
                oldPrice: parseFloat(p.price || 0), newPrice: parseFloat(p.price || 0),
                refPrice: ref.price, deviationPercent: null, action: 'skipped_bad_ref',
                reason: `РРЦ ${ref.price} ниже себестоимости ${cost} — вероятна ошибка в Excel, пропуск`,
            });
            continue;
        }

        const live = priceMap.get(nmID);
        const currentBase = live?.priceBase ?? p.wb_price_base ?? 0;
        const currentDiscount = live?.discount ?? p.wb_discount ?? 0;

        // Floor по юнит-экономике (нужны себестоимость + комиссия категории; работает и при налоге 0)
        let floor = null;
        if (cost != null) {
            const comm = commissionMap.get(p.wb_subject_id);
            if (comm && comm.fbo > 0) {
                const logistics = computeBoxLogistics(p.wb_volume_liters, boxTariff);
                floor = computeWbFloor({
                    costPrice: cost,
                    commissionPercent: comm.fbo,
                    logisticsAmount: logistics,
                    returnLogisticsAmount: logistics * (1 - buyoutShare),
                    taxRate,
                    marginPercent,
                });
            } else { noEcon++; }
        }
        if (floor != null) db.updateProductFloorPrice(storeId, p.offer_id, floor);

        const currentDiscounted = live?.discountedPrice ?? discountedFromPair(currentBase, currentDiscount);

        // Целевая discountedPrice = max(РРЦ, floor)
        let target = ref.price;
        if (floor != null && floor > target) { target = floor; raisedToFloor++; }

        // Ступенчатое снижение: WB кладёт товар в карантин при резком падении цены (порог 1.5x–3x).
        // Если цель ниже текущей более чем в QUAR_RATIO раз — снижаем частично, добьём в следующих прогонах.
        const QUAR_RATIO = 1.5;            // WB кладёт в карантин при дропе ≥1.5x
        const QUAR_STEP = QUAR_RATIO - 0.05; // шаг чуть мягче порога, чтобы не сесть на границу
        if (currentDiscounted > 0 && target > 0 && target < currentDiscounted / QUAR_RATIO) {
            target = Math.ceil(currentDiscounted / QUAR_STEP);
            stepwise++;
        }

        const pair = computeWbPricePair(target, currentDiscount);
        const newDiscounted = discountedFromPair(pair.price, pair.discount);

        // Защита: ниже floor не уходим
        if (floor != null && newDiscounted < floor - 0.5) { skippedBelowFloor++; continue; }

        const productName = p.name || p.offer_id;
        // Антифлаппинг: шлём только при изменении итоговой цены продавца ≥1₽ или смене скидки
        const discountChanged = Math.abs((pair.discount || 0) - (currentDiscount || 0)) >= 1;
        const priceChanged = Math.abs(newDiscounted - (currentDiscounted || 0)) >= 1;
        if (!discountChanged && !priceChanged) {
            held++;
            logRepricerSafe(storeId, logId, { offerId: p.offer_id, productName, oldPrice: newDiscounted, newPrice: newDiscounted, refPrice: ref.price, deviationPercent: 0, action: 'ok', reason: null });
            continue;
        }

        repriced++;
        updates.push({ nmID, price: pair.price, discount: pair.discount });
        if (examples.length < 5) examples.push(`${p.offer_id}: ${currentBase}×-${currentDiscount}% → ${pair.price}×-${pair.discount}% (=${newDiscounted.toFixed(0)}, РРЦ ${ref.price}${floor != null ? `, floor ${floor}` : ''})`);
        logRepricerSafe(storeId, logId, { offerId: p.offer_id, productName, oldPrice: discountedFromPair(currentBase, currentDiscount), newPrice: newDiscounted, refPrice: ref.price, deviationPercent: 0, action: 'corrected', reason: `Держим РРЦ: скидка ${currentDiscount}%→${pair.discount}%` });
    }

    await db.addLogEntry(logId, 'INFO', 'WB_REPRICE_SUMMARY', JSON.stringify({
        total: dbProductsJSON.length, repriced, held, target_raised_to_floor: raisedToFloor,
        no_ref: noRef, no_econ: noEcon, skipped_below_floor: skippedBelowFloor, stepwise_capped: stepwise,
        skipped_bad_ref: skippedBadRef,
    }));
    if (skippedBadRef > 0) {
        await db.addLogEntry(logId, 'WARNING', 'WB_BAD_REF',
            `${skippedBadRef} товаров пропущено: РРЦ ниже себестоимости (вероятна ошибка в Excel). Исправьте эталон. Примеры: ${badRefExamples.join('; ')}`);
    }
    if (examples.length) await db.addLogEntry(logId, 'INFO', 'WB_REPRICE_EXAMPLES', examples.join(' | '));

    if (updates.length > 0) {
        await db.addLogEntry(logId, 'INFO', 'WB_REPRICE_ACTION', `Отправка ${updates.length} цен на WB (держим РРЦ)...`);
        const res = await wbFetcher.updateProductPrices(apiKey, updates, storeId, 'repricer');
        if (!res.success) {
            await db.addLogEntry(logId, 'WARNING', 'WB_REPRICE_ERRORS', `Ошибки при отправке: ${JSON.stringify(res._itemErrors).slice(0, 400)}`);
        } else {
            await db.addLogEntry(logId, 'INFO', 'WB_REPRICE_SENT', `Задачи на обновление цен созданы: ${JSON.stringify(res.taskIds)}`);
        }
        for (const u of updates) {
            await db.saveWbProductMeta(storeId, u.nmID, { priceBase: u.price, discount: u.discount });
        }
    } else {
        await db.addLogEntry(logId, 'INFO', 'WB_REPRICE_NOOP', 'Все товары уже на РРЦ — изменений нет.');
    }
}

module.exports = { checkStore };
