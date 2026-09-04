const cron = require('node-cron');
const Sentry = require('./sentry.server.cjs');
const db = require('./db.cjs');
const ozonFetcher = require('./ozonFetcher.cjs');
const repricer = require('./repricer.cjs');
const promoGuard = require('./promoGuard.cjs');
const promoExiter = require('./promoExiter.cjs');
const wbPromoExiter = require('./wbPromoExiter.cjs');

const { createOzonClient } = require('./lib/ozonClient.cjs');
const { runBackup } = require('./lib/s3backup.cjs');
const { db: rawDb } = require('./db/connection.cjs');

function captureJobError(err, tags) {
    Sentry.withScope(scope => {
        scope.setTag('component', 'scheduler');
        for (const [k, v] of Object.entries(tags || {})) scope.setTag(k, v);
        Sentry.captureException(err);
    });
}

function getFetcher(platform) {
    if (platform === 'yandex') return require('./yandexFetcher.cjs');
    if (platform === 'wildberries') return require('./wbFetcher.cjs');
    return ozonFetcher;
}

let task;
let backupTask;
let diagTask;
let salesTask;
const runningJobs = new Set();

let lastRotation = null;

// ─── Verifier ────────────────────────────────────────────────────────────────

async function runVerifier() {
    const key = 'verifier';
    if (runningJobs.has(key)) {
        console.log('[Verifier] Skipping — already running');
        return;
    }
    runningJobs.add(key);
    try {
        const pending = await db.getPendingToVerify();
        if (pending.length === 0) return;

        console.log(`[Verifier] Checking ${pending.length} pending price updates`);

        // Group by store_id
        const byStore = new Map();
        for (const p of pending) {
            if (!byStore.has(p.store_id)) byStore.set(p.store_id, []);
            byStore.get(p.store_id).push(p);
        }

        for (const [storeId, items] of byStore) {
            try {
                const store = await db.getStoreById(storeId);
                if (!store) {
                    console.warn(`[Verifier] Store ${storeId} not found — skipping ${items.length} pending updates`);
                    continue;
                }

                // Yandex/Wildberries don't use Ozon API/pending-table for verification
                // (WB применяет цены асинхронно task'ами, контроль — через карантин в syncStore)
                if (store.platform === 'yandex' || store.platform === 'wildberries') continue;

                const { client_id, api_key } = store;
                const client = createOzonClient(client_id, api_key, { source: 'verifier', storeId });

                // Collect all offer_ids we need to verify
                const offerIds = [...new Set(items.map(i => i.offer_id))];

                // Fetch current prices from Ozon using v5/product/info/prices with offer_id filter.
                // Ozon ограничивает Filters.OfferIds 1000 элементами — режем на чанки.
                let currentPricesMap = new Map();
                try {
                    const CHUNK = 1000;
                    for (let i = 0; i < offerIds.length; i += CHUNK) {
                        const chunk = offerIds.slice(i, i + CHUNK);
                        const resp = await client.post('/v5/product/info/prices', {
                            filter: { offer_id: chunk, visibility: 'ALL' },
                            limit: 1000,
                        }, { metadata: { itemsCount: chunk.length, summary: `verify prices ${i + 1}-${i + chunk.length}/${offerIds.length}` } });
                        if (resp.data.items) {
                            for (const item of resp.data.items) {
                                currentPricesMap.set(item.offer_id, parseFloat(item.price?.price || '0'));
                            }
                        }
                    }
                } catch (err) {
                    console.error(`[Verifier] Failed to fetch prices for store ${storeId} — ${items.length} pending updates NOT verified this round:`, err.message);
                    captureJobError(err, { job: 'verifier-fetch', store_id: storeId, items_skipped: items.length });
                    continue;
                }

                // Verify each pending update
                for (const item of items) {
                    const actualPrice = currentPricesMap.get(item.offer_id);
                    if (actualPrice === undefined) {
                        await db.updatePendingStatus(item.id, 'VERIFIED_FAIL', null, 'Товар не найден в Ozon');
                        continue;
                    }

                    const sentPrice = item.sent_price;
                    const tolerance = sentPrice * 0.01; // 1% tolerance
                    const matches = Math.abs(actualPrice - sentPrice) <= tolerance;

                    if (matches) {
                        await db.updatePendingStatus(item.id, 'VERIFIED_OK', actualPrice, null);
                    } else {
                        await db.updatePendingStatus(
                            item.id,
                            'VERIFIED_FAIL',
                            actualPrice,
                            `Ожидалась цена ${sentPrice}, фактически ${actualPrice}`
                        );
                    }
                }

                console.log(`[Verifier] Store ${storeId}: verified ${items.length} updates`);
            } catch (err) {
                console.error(`[Verifier] Error processing store ${storeId}:`, err.message);
            }
        }
    } catch (err) {
        console.error('[Verifier] Unexpected error:', err);
    } finally {
        runningJobs.delete(key);
    }
}

// ─── Scheduled Executor ──────────────────────────────────────────────────────

async function runScheduledExecutor() {
    const key = 'executor';
    if (runningJobs.has(key)) {
        console.log('[Executor] Skipping — already running');
        return;
    }
    runningJobs.add(key);
    try {
        const due = await db.getDueScheduledUpdates();
        if (due.length === 0) return;

        console.log(`[Executor] Processing ${due.length} scheduled updates`);

        for (const scheduled of due) {
            try {
                let updates;
                try {
                    updates = JSON.parse(scheduled.updates_json || '[]');
                } catch (parseErr) {
                    // Повреждённый JSON в БД — фиксируем с ID записи и фрагментом данных
                    const raw = String(scheduled.updates_json || '').slice(0, 100);
                    console.error(`[Executor] Invalid JSON in scheduled update ${scheduled.id} (store ${scheduled.store_id}): ${parseErr.message}. Raw: ${raw}`);
                    captureJobError(parseErr, { job: 'executor-parse', scheduled_id: scheduled.id, store_id: scheduled.store_id });
                    await db.updateScheduledStatus(scheduled.id, 'ERROR', JSON.stringify({ error: `Invalid JSON: ${parseErr.message}` }));
                    continue;
                }
                if (!Array.isArray(updates) || updates.length === 0) {
                    await db.updateScheduledStatus(scheduled.id, 'EXECUTED', JSON.stringify({ success: true, count: 0 }));
                    continue;
                }

                const store = await db.getStoreById(scheduled.store_id);
                if (!store) {
                    await db.updateScheduledStatus(scheduled.id, 'ERROR', JSON.stringify({ error: 'Store not found' }));
                    continue;
                }

                const { client_id, api_key } = store;

                // Call marketplace API to update prices
                const storeFetcher = getFetcher(store.platform);
                const result = store.platform === 'yandex'
                    ? await storeFetcher.updatePrices(store.ym_campaign_id, store.ym_api_key, updates.map(u => ({ offerId: u.offer_id, price: { value: parseFloat(u.price), currencyId: 'RUR' } })), scheduled.store_id, 'scheduled')
                    : await storeFetcher.updateProductPrices(client_id, api_key, updates, scheduled.store_id, 'scheduled');

                // Create pending verification records (verify after 3 minutes)
                const verifyAfter = new Date(Date.now() + 3 * 60 * 1000).toISOString();

                // Один запрос вместо N+1 (раньше getStoreProducts вызывался для каждого товара)
                const products = await db.getStoreProducts(scheduled.store_id);
                const productByOffer = new Map(products.map(p => [p.offer_id, p]));

                let pendingFailed = 0;
                let pendingNotFound = 0;
                for (const upd of updates) {
                    try {
                        const product = productByOffer.get(upd.offer_id);
                        if (product) {
                            await db.createPendingUpdate({
                                store_id: scheduled.store_id,
                                product_id: product.id,
                                offer_id: upd.offer_id,
                                sent_price: parseFloat(upd.price || '0'),
                                sent_min_price: upd.min_price ? parseFloat(upd.min_price) : null,
                                sent_old_price: upd.old_price ? parseFloat(upd.old_price) : null,
                                verify_after: verifyAfter,
                            });
                        } else {
                            pendingNotFound++;
                        }
                    } catch (err) {
                        pendingFailed++;
                        console.error(`[Executor] Failed to create pending record for ${upd.offer_id}:`, err.message);
                    }
                }
                if (pendingFailed > 0 || pendingNotFound > 0) {
                    console.warn(`[Executor] Scheduled ${scheduled.id}: ${pendingFailed} pending records failed, ${pendingNotFound} offers not found in DB — these updates will NOT be verified`);
                }

                await db.updateScheduledStatus(
                    scheduled.id,
                    'EXECUTED',
                    JSON.stringify({
                        success: true,
                        count: updates.length,
                        ...(pendingFailed > 0 || pendingNotFound > 0 ? { pending_failed: pendingFailed, pending_not_found: pendingNotFound } : {}),
                        ozon_result: result
                    })
                );

                console.log(`[Executor] Executed scheduled update ${scheduled.id}: ${updates.length} prices updated`);
            } catch (err) {
                console.error(`[Executor] Error processing scheduled update ${scheduled.id}:`, err.message);
                captureJobError(err, { job: 'executor', scheduled_id: scheduled.id, store_id: scheduled.store_id });
                await db.updateScheduledStatus(
                    scheduled.id,
                    'ERROR',
                    JSON.stringify({ error: err.message })
                ).catch(dbErr => {
                    // Статус ERROR не записан — задача может зависнуть в очереди и выполниться повторно
                    console.error(`[Executor] CRITICAL: failed to mark scheduled ${scheduled.id} as ERROR:`, dbErr.message);
                    captureJobError(dbErr, { job: 'executor-status-write', scheduled_id: scheduled.id, critical: 'true' });
                });
            }
        }
    } catch (err) {
        console.error('[Executor] Unexpected error:', err);
    } finally {
        runningJobs.delete(key);
    }
}

// ─── Status Monitor ──────────────────────────────────────────────────────────

async function runMonitorForStore(store) {
    const key = `monitor-${store.id}`;
    if (runningJobs.has(key)) throw new Error(`Monitor already running for store ${store.name}`);

    runningJobs.add(key);
    let logId = null;
    try {
        const { client_id, api_key, antiban_enabled } = store;

        const productIds = await db.getStoreProductIds(store.id);
        if (productIds.length === 0) {
            console.log(`[Monitor] Store ${store.name}: no products, skipping`);
            return;
        }

        logId = await db.createLog(store.id);
        await db.addLogEntry(logId, 'INFO', 'MONITOR_INIT', `Status monitor started for store ${store.name}. Products: ${productIds.length}`);

        // Fetch visibility
        await db.addLogEntry(logId, 'INFO', 'MONITOR_VISIBILITY', `Fetching visibility for ${productIds.length} products...`);
        const visibilityData = await ozonFetcher.fetchProductVisibility(client_id, api_key, productIds, !!antiban_enabled, store.id);

        const now_iso = new Date().toISOString();
        for (const v of visibilityData) {
            await db.updateProductStatus(store.id, v.product_id, {
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
        await db.addLogEntry(logId, 'INFO', 'MONITOR_VISIBILITY', `Updated visibility for ${visibilityData.length} products`);

        // Reset promo flags before re-fetching — products that left promo get cleared
        await db.resetStorePromo(store.id);

        // Fetch active promos
        await db.addLogEntry(logId, 'INFO', 'MONITOR_PROMOS', 'Fetching active promotions...');
        const promoMap = await ozonFetcher.fetchActivePromos(client_id, api_key, store.id);

        for (const [productId, promoData] of promoMap) {
            await db.updateProductStatus(store.id, productId, {
                visibility: undefined,
                is_quarantine: undefined,
                in_promo: 1,
                promo_price: promoData.promo_price,
                promo_action_id: promoData.action_id,
                last_status_check: now_iso
            });
        }
        await db.addLogEntry(logId, 'INFO', 'MONITOR_PROMOS', `Updated promo data for ${promoMap.size} products`);

        // PromoGuard: auto-remove products from unprofitable promotions
        // При включённом promo_exit_enabled не запускаем — PromoExiter выводит ВСЁ сам (иначе двойные deactivate)
        if (store.promo_guard_enabled && !store.promo_exit_enabled) {
            try {
                await promoGuard.checkStore(store.id);
            } catch (err) {
                console.error(`[PromoGuard] Error for store ${store.name}:`, err.message);
            }
        }

        await db.updateStoreMonitorTimestamp(store.id);
        await db.updateLog(logId, { status: 'SUCCESS', completed: true, log_text: `Monitor finished. Visibility: ${visibilityData.length}, Promos: ${promoMap.size}` });
        await db.addLogEntry(logId, 'INFO', 'MONITOR_FINISH', `Status monitor finished for store ${store.name}`);

        console.log(`[Monitor] Store ${store.name}: done. Visibility: ${visibilityData.length}, Promos: ${promoMap.size}`);
    } catch (err) {
        console.error(`[Monitor] Error for store ${store.name}:`, err.message);
        if (logId) {
            await db.addLogEntry(logId, 'ERROR', 'MONITOR_ERROR', err.message)
                .catch(logErr => console.error(`[Monitor] Failed to write error log entry (log ${logId}):`, logErr.message));
            await db.updateLog(logId, { status: 'ERROR', log_text: err.message, completed: true })
                .catch(logErr => console.error(`[Monitor] Failed to mark log ${logId} as ERROR:`, logErr.message));
        }
        throw err;
    } finally {
        runningJobs.delete(key);
    }
}

async function runStatusMonitor() {
    const stores = await db.getAllStores();
    const now = new Date();

    for (const store of stores) {
        // Монитор статусов использует Ozon API; WB-видимость/карантин обновляются в syncStore
        if (store.platform === 'yandex' || store.platform === 'wildberries') continue;
        if (!store.monitor_interval_min || store.monitor_interval_min <= 0) continue;

        const lastRun = store.last_monitor_run ? new Date(store.last_monitor_run) : new Date(0);
        const intervalMs = store.monitor_interval_min * 60 * 1000;
        if (now - lastRun <= intervalMs) continue;

        if (runningJobs.has(`monitor-${store.id}`)) {
            console.log(`[Monitor] Skipping store ${store.name} — already running`);
            continue;
        }

        // fire-and-forget, но внешний catch ловит ошибки ДО входа в try (например, гонку runningJobs)
        runMonitorForStore(store).catch(err => {
            if (/already running/.test(err.message)) return; // ожидаемая гонка — не шумим
            console.error(`[Monitor] Unhandled error for store ${store.name}:`, err.message);
            captureJobError(err, { job: 'monitor-outer', store_id: store.id });
        });
    }
}

// ─── Rotate old data (once per day) ──────────────────────────────────────────

async function maybeRotateOldData() {
    const now = new Date();
    if (lastRotation && now - lastRotation < 24 * 60 * 60 * 1000) return;
    lastRotation = now;
    try {
        await db.rotateOldData();
        console.log('[Scheduler] Old data rotated');
    } catch (err) {
        console.error('[Scheduler] rotateOldData error:', err);
    }
}

// ─── Main scheduler ──────────────────────────────────────────────────────────

function startScheduler() {
    if (task) return;

    console.log('Starting Scheduler...');

    // Daily S3 backup at 03:00 server time
    const BACKUP_HOUR = process.env.BACKUP_HOUR || '3';
    backupTask = cron.schedule(`0 ${BACKUP_HOUR} * * *`, () => {
        runBackup(rawDb).catch(err => {
            console.error('[Backup] Error:', err.message);
            captureJobError(err, { job: 'backup' });
        });
    });

    // Ежедневный сбор истории продаж в sales_daily (для ценовых стратегий, РФ2).
    // 04:00 — после бэкапа; собираем вчерашний день по всем магазинам.
    salesTask = cron.schedule('0 4 * * *', async () => {
        try {
            const salesCollector = require('./salesCollector.cjs');
            const strategyRunner = require('./strategyRunner.cjs');
            const stores = await db.getAllStores();
            for (const store of stores) {
                try {
                    const r = await salesCollector.collectStoreSales(store.id, { days: 2 });
                    if (r && r.collected > 0) console.log(`[Sales] ${store.name}: собрано ${r.collected} (грязных ${r.dirty})`);
                } catch (e) {
                    console.error(`[Sales] ${store.name}: ${e.message}`);
                    captureJobError(e, { job: 'sales_collect', store_id: store.id });
                }
                // Прогон ценовых стратегий после сбора продаж (event-based решения по накопленным данным)
                try {
                    const s = await strategyRunner.runStore(store.id);
                    if (s && s.count > 0) console.log(`[Strategy] ${store.name}: товаров ${s.count}, применено ${s.applied}`);
                } catch (e) {
                    console.error(`[Strategy] ${store.name}: ${e.message}`);
                    captureJobError(e, { job: 'strategy_run', store_id: store.id });
                }
            }
        } catch (err) {
            console.error('[Sales] collect error:', err.message);
            captureJobError(err, { job: 'sales_collect' });
        }
    });

    // Ежечасный контроль функций: деградации эндпоинтов Ozon по api_logs.
    // Без запросов к Ozon — анализ реального трафика репрайсера/фетчера.
    diagTask = cron.schedule('10 * * * *', async () => {
        try {
            const { getDegradations } = require('./lib/apiDiagnostics.cjs');
            const stores = await db.getAllStores();
            for (const store of stores) {
                if (store.platform === 'yandex') continue;
                const degraded = await getDegradations(store.id);
                for (const d of degraded) {
                    console.error(`[ApiDiag] ДЕГРАДАЦИЯ ${store.name}: ${d.endpoint} — ${d.consecutiveErrors} ошибок подряд (последний успех ${d.lastSuccess}). Функция: ${d.affectedFunction || '?'}. ${d.lastError}`);
                    captureJobError(
                        new Error(`Ozon API degradation: ${d.endpoint} (${store.name})`),
                        { job: 'apiDiagnostics', store_id: store.id, endpoint: d.endpoint }
                    );
                }
            }
        } catch (err) {
            console.error('[ApiDiag] Error:', err.message);
        }
    });

    // Expire stale pending verifications (e.g. Yandex stores that can't be verified)
    db.expireOldPending(3).then(result => {
        if (result && result.changes > 0) {
            console.log(`[Scheduler] Expired ${result.changes} stale pending price updates`);
        }
    }).catch(err => { console.error('[Scheduler] Error expiring old pending:', err); captureJobError(err, { job: 'expireOldPending' }); });

    task = cron.schedule('* * * * *', async () => {
        try {
            const stores = await db.getAllStores();
            const now = new Date();

            for (const store of stores) {
                // Full Sync
                const lastUpdate = store.last_updated_at ? new Date(store.last_updated_at) : new Date(0);
                const intervalMs = (store.update_interval_minutes || 60) * 60 * 1000;

                if (now - lastUpdate > intervalMs) {
                    const syncKey = `sync-${store.id}`;
                    if (!runningJobs.has(syncKey)) {
                        runningJobs.add(syncKey);
                        const storeFetcher = getFetcher(store.platform);
                        console.log(`[Scheduler] Triggering auto-update for store: ${store.name} (${store.platform || 'ozon'})`);
                        storeFetcher.syncStore(store.id)
                            .catch(err => { console.error(`[Scheduler] Sync error (${store.name}):`, err); captureJobError(err, { job: 'sync', store_id: store.id, platform: store.platform || 'ozon' }); })
                            .finally(() => runningJobs.delete(syncKey));
                    } else {
                        console.log(`[Scheduler] Skipping sync for ${store.name} — already running`);
                    }
                }

                // Repricer
                if (store.repricer_enabled) {
                    const lastReprice = store.last_repricer_run ? new Date(store.last_repricer_run) : new Date(0);
                    const repriceIntervalMs = (store.repricer_interval_min || 15) * 60 * 1000;

                    if (now - lastReprice > repriceIntervalMs) {
                        const repriceKey = `repricer-${store.id}`;
                        if (!runningJobs.has(repriceKey)) {
                            runningJobs.add(repriceKey);
                            console.log(`[Scheduler] Triggering Repricer for store: ${store.name}`);
                            repricer.checkStore(store.id)
                                .catch(err => { console.error(`[Scheduler] Repricer error (${store.name}):`, err); captureJobError(err, { job: 'repricer', store_id: store.id }); })
                                .finally(() => runningJobs.delete(repriceKey));
                        } else {
                            console.log(`[Scheduler] Skipping repricer for ${store.name} — already running`);
                        }
                    }
                }
            }

            // PromoExiter — автовывод/анти-автоакции каждые PROMO_EXIT_INTERVAL_MIN минут.
            // Ozon → promoExiter (deactivate + самозапрет); Wildberries → wbPromoExiter (восстановление РРЦ).
            const PROMO_EXIT_INTERVAL_MIN = 5;
            for (const store of stores) {
                const platform = store.platform || 'ozon';
                if (!store.promo_exit_enabled || (platform !== 'ozon' && platform !== 'wildberries')) continue;

                const lastExit = store.last_promo_exit_run ? new Date(store.last_promo_exit_run) : new Date(0);
                if (now - lastExit <= PROMO_EXIT_INTERVAL_MIN * 60 * 1000) continue;

                const exitKey = `promoexit-${store.id}`;
                if (runningJobs.has(exitKey)) continue;
                // Защита от гонки цен: вывод/восстановление шлёт цены —
                // нельзя выполнять одновременно с репрайсером этого магазина
                if (runningJobs.has(`repricer-${store.id}`)) {
                    console.log(`[Scheduler] PromoExit for ${store.name} postponed — repricer is running`);
                    continue;
                }

                const exiter = platform === 'wildberries' ? wbPromoExiter : promoExiter;
                runningJobs.add(exitKey);
                exiter.checkStore(store.id)
                    .catch(err => { console.error(`[Scheduler] PromoExit error (${store.name}):`, err.message); captureJobError(err, { job: 'promo_exit', store_id: store.id, platform }); })
                    .finally(() => runningJobs.delete(exitKey));
            }

            // Status monitor — update visibility and promo data per store
            runStatusMonitor().catch(err => { console.error('[Scheduler] Monitor error:', err); captureJobError(err, { job: 'monitor' }); });

            // Price verifier — check pending updates that need verification
            runVerifier().catch(err => { console.error('[Scheduler] Verifier error:', err); captureJobError(err, { job: 'verifier' }); });

            // Scheduled executor — run due scheduled updates
            runScheduledExecutor().catch(err => { console.error('[Scheduler] Executor error:', err); captureJobError(err, { job: 'executor' }); });

            // Rotate old data once per day
            maybeRotateOldData().catch(err => { console.error('[Scheduler] Rotate error:', err); captureJobError(err, { job: 'rotate' }); });

        } catch (err) {
            console.error('[Scheduler] Error in job:', err);
            captureJobError(err, { job: 'main-tick' });
        }
    });
}

function stopScheduler() {
    if (task) {
        task.stop();
        task = null;
    }
    if (backupTask) {
        backupTask.stop();
        backupTask = null;
    }
    if (diagTask) {
        diagTask.stop();
        diagTask = null;
    }
    if (salesTask) {
        salesTask.stop();
        salesTask = null;
    }
}

module.exports = { startScheduler, stopScheduler, runMonitorForStore };
