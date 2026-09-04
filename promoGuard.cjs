const db = require('./db.cjs');
const Sentry = require('./sentry.server.cjs');
const { deactivatePromoProducts } = require('./ozonFetcher.cjs');

async function checkStore(storeId) {
  try {
    const store = await db.getStoreById(storeId);
    if (!store || !store.promo_guard_enabled) return;
    if (store.platform !== 'ozon') return;

    console.log(`[PromoGuard] Checking store ${store.name} (ID: ${storeId})`);

    const promoProducts = await db.getPromoProducts(storeId);
    if (!promoProducts || promoProducts.length === 0) return;

    // Group products to remove by action_id
    const toRemove = new Map(); // action_id → [{ ozon_id, offer_id, name, promo_price, threshold }]
    let skipped = 0;

    for (const p of promoProducts) {
        const threshold = p.floor_min_price || p.cost_price || null;
        if (!threshold) { skipped++; continue; }
        if (p.promo_price >= threshold) continue;

        const actionId = p.promo_action_id;
        if (!toRemove.has(actionId)) toRemove.set(actionId, []);
        toRemove.get(actionId).push({
            ozon_id: p.ozon_id,
            offer_id: p.offer_id,
            name: p.name,
            promo_price: p.promo_price,
            threshold
        });
    }

    if (toRemove.size === 0) {
        console.log(`[PromoGuard] ${store.name}: all promo prices OK (${promoProducts.length} checked, ${skipped} skipped — no threshold)`);
        return;
    }

    // Get the max run_id for this store from repricer_log to assign our own
    const logId = await db.createLog(storeId);
    await db.addLogEntry(logId, 'INFO', 'PROMO_GUARD', `Found ${[...toRemove.values()].reduce((s, a) => s + a.length, 0)} products to remove from ${toRemove.size} action(s)`);

    let totalRemoved = 0;

    for (const [actionId, products] of toRemove) {
        const productIds = products.map(p => p.ozon_id);
        try {
            const result = await deactivatePromoProducts(store.client_id, store.api_key, storeId, actionId, productIds);
            if (result.success) {
                totalRemoved += products.length;
                // Log each removed product
                for (const p of products) {
                    await db.insertRepricerLog(storeId, logId, {
                        offerId: p.offer_id,
                        productName: p.name || p.offer_id,
                        oldPrice: p.promo_price,
                        newPrice: p.threshold,
                        refPrice: p.threshold,
                        deviationPercent: ((p.threshold - p.promo_price) / p.threshold * 100).toFixed(1),
                        action: 'promo_removed',
                        reason: `Removed from action ${actionId}: promo ${p.promo_price} < threshold ${p.threshold}`
                    });
                }
                await db.addLogEntry(logId, 'INFO', 'PROMO_GUARD', `Removed ${products.length} products from action ${actionId}`);
            } else {
                await db.addLogEntry(logId, 'ERROR', 'PROMO_GUARD', `Failed to remove from action ${actionId}: ${result.error}`);
            }
        } catch (err) {
            console.error(`[PromoGuard] Error removing from action ${actionId}:`, err.message);
            await db.addLogEntry(logId, 'ERROR', 'PROMO_GUARD', `Error: ${err.message}`);
        }
    }

    await db.updateLog(logId, { status: 'DONE', items_processed: promoProducts.length, items_changed: totalRemoved, completed: true });
    console.log(`[PromoGuard] ${store.name}: removed ${totalRemoved} products from promotions`);
  } catch (err) {
    console.error(`[PromoGuard] Unexpected error for store ${storeId}:`, err);
    Sentry.withScope(scope => {
      scope.setTag('operation', 'promoGuard');
      scope.setTag('store_id', storeId);
      Sentry.captureException(err);
    });
    throw err;
  }
}

module.exports = { checkStore };
