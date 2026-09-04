/**
 * Анти-автоакции Wildberries.
 *
 * У WB нет отдельного API «выхода из акции» — выход делается через Prices API:
 * восстанавливаем нашу пару {price, discount}, удерживая РРЦ (= max(РРЦ, floor)).
 * WB может добавлять товары в автоакции повторно — следующий запуск снова восстановит цену
 * (diff-ретрай по живым данным акций), аналогично Ozon promoExiter.
 *
 * Самозапрет автоучастия / «минимальная цена» в публичном API WB не подтверждён —
 * пишем рекомендацию в лог (включить в кабинете), а экономику держим восстановлением РРЦ + floor.
 */
const db = require('./db.cjs');
const Sentry = require('./sentry.server.cjs');
const wbFetcher = require('./wbFetcher.cjs');
const { computeWbPricePair, discountedFromPair } = require('./lib/wbPricing.cjs');

function logRepricerSafe(storeId, logId, entry) {
    db.insertRepricerLog(storeId, logId, entry).catch(err => {
        console.error(`[WB PromoExit] Failed to write repricer_log (offer ${entry.offerId}):`, err.message);
        Sentry.withScope(scope => {
            scope.setTag('operation', 'wb_promo_exit_log_write');
            scope.setTag('store_id', storeId);
            Sentry.captureException(err);
        });
    });
}

async function checkStore(storeId) {
    const store = await db.getStoreById(storeId);
    if (!store || !store.promo_exit_enabled) return null;
    if (store.platform !== 'wildberries') return null;

    const apiKey = store.wb_api_key;
    let logId = null;
    const summary = { promos: 0, participating: 0, restored: 0, no_ref: 0, errors: 0 };

    try {
        // Окно: сейчас → +30 дней (захватываем текущие и ближайшие акции)
        const now = new Date();
        const end = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
        const startISO = now.toISOString();
        const endISO = end.toISOString();

        const promos = await wbFetcher.fetchPromotions(apiKey, storeId, startISO, endISO);
        summary.promos = promos.length;
        if (promos.length === 0) return summary;

        // Собираем участвующие nmID по всем акциям
        const participating = new Map(); // nmID -> { promoName, planDiscount }
        for (const promo of promos) {
            try {
                const noms = await wbFetcher.fetchPromoNomenclatures(apiKey, storeId, promo.id);
                for (const n of noms) {
                    if (n.nmID == null) continue;
                    if (!participating.has(n.nmID)) participating.set(n.nmID, { promoName: promo.name, promoId: promo.id, planDiscount: n.planDiscount });
                }
            } catch (e) {
                // 422 на части акций — товар не подходит/акция закрыта; не критично
                console.warn(`[WB PromoExit] promo ${promo.id} nomenclatures: ${e.response?.status || ''} ${e.message}`);
            }
        }
        summary.participating = participating.size;
        if (participating.size === 0) return summary;

        logId = await db.createLog(storeId);
        await db.addLogEntry(logId, 'INFO', 'WB_PROMO_EXIT',
            `Акций в окне: ${promos.length}; наших товаров в акциях: ${participating.size}. Восстанавливаем РРЦ.`);

        // Данные товаров: РРЦ, скидка-якорь, floor
        const products = await db.getStoreProducts(storeId);
        const byNm = new Map(products.map(p => [p.product_id, p]));

        const updates = [];
        for (const [nmID, info] of participating) {
            const p = byNm.get(nmID);
            if (!p) { continue; }
            if (!(p.ref_price > 0)) { summary.no_ref++; continue; }

            // Предохранитель: РРЦ ниже себестоимости — ошибка в данных, не восстанавливаем к ней
            if (p.cost_price > 0 && p.ref_price < parseFloat(p.cost_price)) { summary.no_ref++; continue; }

            const floor = p.floor_min_price != null ? parseFloat(p.floor_min_price) : null;
            const target = (floor != null && floor > p.ref_price) ? floor : parseFloat(p.ref_price);
            const anchorDiscount = p.wb_discount != null ? p.wb_discount : 0;
            const pair = computeWbPricePair(target, anchorDiscount);
            const newDiscounted = discountedFromPair(pair.price, pair.discount);

            updates.push({ nmID, price: pair.price, discount: pair.discount });
            logRepricerSafe(storeId, logId, {
                offerId: p.offer_id || String(nmID),
                productName: p.name || String(nmID),
                oldPrice: 0, newPrice: newDiscounted, refPrice: parseFloat(p.ref_price), deviationPercent: null,
                action: 'promo_removed',
                reason: `Восстановление РРЦ после автоакции «${info.promoName}» (planDiscount ${info.planDiscount ?? '?'}%)`,
            });
        }

        if (updates.length > 0) {
            const res = await wbFetcher.updateProductPrices(apiKey, updates, storeId, 'promo_exit');
            if (res.success) {
                summary.restored = updates.length;
                for (const u of updates) await db.saveWbProductMeta(storeId, u.nmID, { priceBase: u.price, discount: u.discount });
            } else {
                summary.errors++;
                await db.addLogEntry(logId, 'WARNING', 'WB_PROMO_EXIT', `Ошибки восстановления: ${JSON.stringify(res._itemErrors).slice(0, 400)}`);
            }
        }

        await db.addLogEntry(logId, 'WARNING', 'WB_PROMO_SELFBAN_HINT',
            'Для постоянной защиты включите в кабинете WB бессрочный самозапрет автоучастия и «минимальную цену» (=floor) — публичного API для этого нет.');
        await db.addLogEntry(logId, summary.errors > 0 ? 'WARNING' : 'INFO', 'WB_PROMO_EXIT_SUMMARY', JSON.stringify(summary));
        await db.updateLog(logId, {
            status: summary.errors > 0 ? 'WARNING' : 'SUCCESS',
            items_processed: summary.participating,
            items_changed: summary.restored,
            log_text: `WB PromoExit: restored ${summary.restored}, participating ${summary.participating}`,
            completed: true,
        });

        await db.updateStorePromoExitTimestamp(storeId);
        return summary;
    } catch (err) {
        console.error(`[WB PromoExit] Unexpected error for store ${storeId}:`, err.message);
        Sentry.withScope(scope => {
            scope.setTag('operation', 'wb_promo_exit');
            scope.setTag('store_id', storeId);
            Sentry.captureException(err);
        });
        if (logId) {
            await db.addLogEntry(logId, 'ERROR', 'WB_PROMO_EXIT', err.message).catch(() => {});
            await db.updateLog(logId, { status: 'ERROR', log_text: err.message, completed: true }).catch(() => {});
        }
        throw err;
    }
}

module.exports = { checkStore };
