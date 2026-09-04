const db = require('./db.cjs');
const Sentry = require('./sentry.server.cjs');
const ozonFetcher = require('./ozonFetcher.cjs');

// Запись в repricer_log с гарантией видимости ошибки записи
function logRepricerSafe(storeId, logId, entry) {
    db.insertRepricerLog(storeId, logId, entry).catch(err => {
        console.error(`[PromoExit] Failed to write repricer_log (offer ${entry.offerId}):`, err.message);
        Sentry.withScope(scope => {
            scope.setTag('operation', 'promo_exit_log_write');
            scope.setTag('store_id', storeId);
            Sentry.captureException(err);
        });
    });
}

/**
 * Автовывод товаров из акций Ozon (политика: вне акций — все товары).
 * Работает по ЖИВЫМ данным Ozon (/v1/actions), а не по локальной БД.
 *
 * Цикл одного запуска:
 *   1. Живой список акций с участием; замороженные (freeze_date) пропускаем
 *   2. По каждой акции — живой список товаров → deactivate батчами
 *   3. Ответ deactivate: подтверждённые → снимаем in_promo в БД; rejected → лог с причиной
 *   4. Недоудалённые товары подберёт следующий запуск (diff-ретрай по живым данным)
 *   5. Самозапрет автодобавления (auto_add_to_ozon_actions_list_enabled=false)
 *      порциями для товаров, где ещё не установлен
 *
 * Возвращает summary для логов/UI.
 */
async function checkStore(storeId) {
    const store = await db.getStoreById(storeId);
    if (!store || !store.promo_exit_enabled) return null;
    if (store.platform !== 'ozon') return null;

    const { client_id, api_key } = store;
    let logId = null;
    const summary = { actions: 0, frozen: 0, removed: 0, rejected: 0, blocked_flag_set: 0, errors: 0 };

    try {
        // 1. Живой список акций с участием
        const actions = await ozonFetcher.fetchParticipatingActions(client_id, api_key, storeId);
        const active = actions.filter(a => !a.frozen);
        summary.actions = actions.length;
        summary.frozen = actions.filter(a => a.frozen).length;

        if (active.length > 0) {
            logId = await db.createLog(storeId);
            await db.addLogEntry(logId, 'INFO', 'PROMO_EXIT',
                `Found ${actions.length} participating action(s): ${active.length} active, ${summary.frozen} frozen (skipped)`);

            // Маппинг ozon_id → offer_id/name для логов
            const products = await db.getStoreProducts(storeId);
            const byOzonId = new Map(products.map(p => [p.ozon_id, p]));

            // Выборочное разрешение акций: из этих action_id НЕ выводим товары целиком —
            // оставляем те, у кого скидка ≤ порога, и выводим только со скидкой > порога.
            let allowedActions = new Set();
            try { allowedActions = new Set(JSON.parse(store.promo_allowed_actions || '[]').map(Number)); } catch {}
            const maxDiscount = store.promo_max_discount_percent != null ? Number(store.promo_max_discount_percent) : 5;
            const EPS = 0.05; // допуск на округление при сравнении скидки с порогом
            let keysLogged = false;

            for (const action of active) {
                try {
                    // 2. Живой список товаров акции
                    const actionProducts = await ozonFetcher.fetchActionProducts(client_id, api_key, storeId, action.action_id);
                    if (actionProducts.length === 0) continue;

                    // Контроль схемы ответа: на первом прогоне логируем поля товара (проверка наличия price)
                    if (!keysLogged) {
                        keysLogged = true;
                        await db.addLogEntry(logId, 'INFO', 'PROMO_EXIT',
                            `Поля товара акции: ${Object.keys(actionProducts[0]).join(', ')} | пример price=${actionProducts[0].price}, action_price=${actionProducts[0].action_price}`);
                    }

                    // Какие товары выводим из этой акции
                    const isAllowed = allowedActions.has(action.action_id);
                    let toRemove;
                    if (!isAllowed) {
                        toRemove = actionProducts; // акция вне whitelist — выводим всё (как раньше)
                    } else {
                        // разрешённая акция — выводим только товары со скидкой > порога
                        toRemove = actionProducts.filter(p => {
                            if (!(p.price > 0) || !(p.action_price > 0)) return false; // нет цены — не трогаем
                            const disc = (p.price - p.action_price) / p.price * 100;
                            return disc > maxDiscount + EPS;
                        });
                    }
                    if (toRemove.length === 0) continue; // в разрешённой акции все в пределах порога

                    const productIds = toRemove.map(p => p.product_id);
                    const result = await ozonFetcher.deactivatePromoProducts(
                        client_id, api_key, storeId, action.action_id, productIds, 'promo_exit');

                    // 3. Подтверждённые удаления → снять промо-флаги в БД + лог
                    if (result.removedIds.length > 0) {
                        await db.clearPromoFlags(storeId, result.removedIds);
                        summary.removed += result.removedIds.length;
                        for (const pid of result.removedIds) {
                            const prod = byOzonId.get(pid);
                            const ap = actionProducts.find(p => p.product_id === pid);
                            const disc = (ap && ap.price > 0 && ap.action_price > 0)
                                ? (ap.price - ap.action_price) / ap.price * 100 : null;
                            const reason = isAllowed
                                ? `Автовывод: скидка ${disc != null ? disc.toFixed(1) : '?'}% > ${maxDiscount}% в разрешённой акции ${action.action_id} «${action.title}»`
                                : `Автовывод из акции ${action.action_id} «${action.title}»${ap?.add_mode === 'AUTO' ? ' (автодобавление Ozon)' : ''}`;
                            logRepricerSafe(storeId, logId, {
                                offerId: prod?.offer_id || String(pid),
                                productName: prod?.name || String(pid),
                                oldPrice: ap?.price || ap?.action_price || 0,
                                newPrice: ap?.action_price || 0,
                                refPrice: null, deviationPercent: disc != null ? Number(disc.toFixed(2)) : null,
                                action: 'promo_removed',
                                reason
                            });
                        }
                    }

                    // Отказы Ozon — лог с причинами, ретраить будет следующий цикл
                    if (result.rejected.length > 0) {
                        summary.rejected += result.rejected.length;
                        const reasons = [...new Set(result.rejected.map(r => r.reason))].join('; ');
                        await db.addLogEntry(logId, 'WARNING', 'PROMO_EXIT',
                            `Action ${action.action_id}: ${result.rejected.length} deactivations rejected. Reasons: ${reasons}`);
                        for (const r of result.rejected.slice(0, 50)) {
                            const prod = byOzonId.get(r.product_id);
                            logRepricerSafe(storeId, logId, {
                                offerId: prod?.offer_id || String(r.product_id),
                                productName: prod?.name || String(r.product_id),
                                oldPrice: 0, newPrice: 0, refPrice: null, deviationPercent: null,
                                action: 'promo_exit_rejected',
                                reason: `Акция ${action.action_id}: ${r.reason}`
                            });
                        }
                    }

                    if (!result.success) {
                        summary.errors++;
                        await db.addLogEntry(logId, 'ERROR', 'PROMO_EXIT',
                            `Action ${action.action_id} deactivate failed: ${result.error}`);
                    }
                } catch (actionErr) {
                    summary.errors++;
                    console.error(`[PromoExit] store ${storeId}, action ${action.action_id}:`, actionErr.message);
                    if (logId) await db.addLogEntry(logId, 'ERROR', 'PROMO_EXIT',
                        `Action ${action.action_id}: ${actionErr.message}`);
                }
            }
        }

        // 5. Самозапрет автодобавления — порциями, чтобы не держать цикл долго.
        // ВАЖНО: вызывается из scheduler только когда репрайсер магазина не работает (защита от гонки цен).
        const unblocked = await db.getUnblockedProducts(storeId, 300);
        if (unblocked.length > 0) {
            try {
                const offerIds = unblocked.map(p => p.offer_id);
                const blockResult = await ozonFetcher.setAutoAddBlock(client_id, api_key, storeId, offerIds, false);
                summary.blocked_flag_set = blockResult.updated;
                // Помечаем ВСЕ проверенные (включая уже выключенные на стороне Ozon — setAutoAddBlock их пропустил как готовые)
                const failedOffers = new Set(blockResult.itemErrors.map(e => e.offer_id));
                const okOffers = offerIds.filter(o => !failedOffers.has(o));
                await db.markAutoAddBlocked(storeId, okOffers);
                if (blockResult.itemErrors.length > 0 && logId) {
                    await db.addLogEntry(logId, 'WARNING', 'PROMO_BLOCK',
                        `${blockResult.itemErrors.length} items failed to set auto-add block`);
                }
                if (blockResult.updated > 0) {
                    console.log(`[PromoExit] store ${store.name}: auto-add block set for ${blockResult.updated} products (${okOffers.length} marked done)`);
                }
            } catch (blockErr) {
                summary.errors++;
                console.error(`[PromoExit] store ${storeId} auto-add block failed:`, blockErr.message);
                Sentry.withScope(scope => {
                    scope.setTag('operation', 'promo_block');
                    scope.setTag('store_id', storeId);
                    Sentry.captureException(blockErr);
                });
            }
        }

        if (logId) {
            await db.addLogEntry(logId, summary.errors > 0 ? 'WARNING' : 'INFO', 'PROMO_EXIT_SUMMARY', JSON.stringify(summary));
            await db.updateLog(logId, {
                status: summary.errors > 0 ? 'WARNING' : 'SUCCESS',
                items_processed: summary.removed + summary.rejected,
                items_changed: summary.removed,
                log_text: `PromoExit: removed ${summary.removed}, rejected ${summary.rejected}, frozen actions ${summary.frozen}`,
                completed: true
            });
        }

        await db.updateStorePromoExitTimestamp(storeId);
        if (summary.removed > 0 || summary.rejected > 0 || summary.errors > 0) {
            console.log(`[PromoExit] store ${store.name}:`, JSON.stringify(summary));
        }
        return summary;
    } catch (err) {
        console.error(`[PromoExit] Unexpected error for store ${storeId}:`, err);
        Sentry.withScope(scope => {
            scope.setTag('operation', 'promo_exit');
            scope.setTag('store_id', storeId);
            Sentry.captureException(err);
        });
        if (logId) {
            await db.addLogEntry(logId, 'ERROR', 'PROMO_EXIT', err.message)
                .catch(e => console.error('[PromoExit] Failed to log error:', e.message));
            await db.updateLog(logId, { status: 'ERROR', log_text: err.message, completed: true })
                .catch(e => console.error('[PromoExit] Failed to mark log as error:', e.message));
        }
        throw err;
    }
}

module.exports = { checkStore };
