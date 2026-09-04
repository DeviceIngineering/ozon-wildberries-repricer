const express = require('express');
const router = express.Router();
const db = require('../db.cjs');
const fetcher = require('../ozonFetcher.cjs');
const { createOzonClient } = require('../lib/ozonClient.cjs');
const { validateId } = require('../middleware/validate.cjs');
const wrap = require('../middleware/asyncHandler.cjs');

// POST /api/stores/:id/mass-price-update
router.post('/:id/mass-price-update', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const { priceUpdates } = req.body;

    if (!priceUpdates || !Array.isArray(priceUpdates) || priceUpdates.length === 0) {
        return res.status(400).json({ error: 'priceUpdates array is required and must not be empty' });
    }

    const store = await db.getStoreById(storeId);
    if (!store) {
        return res.status(404).json({ error: 'Store not found' });
    }

    // Create snapshot of current prices of affected products
    const offerIds = priceUpdates.map(u => u.offer_id).filter(Boolean);
    const allProducts = await db.getStoreProducts(storeId);
    const affectedProducts = allProducts.filter(p => offerIds.includes(p.offer_id));

    const snapshotData = affectedProducts.map(p => ({
        offer_id: p.offer_id,
        price: p.price || '0',
        old_price: p.old_price || '0',
        min_price: p.min_price || '0',
        currency_code: p.currency_code || 'RUB'
    }));

    const snapshotId = await db.createSnapshot(
        storeId,
        'mass-price-update',
        snapshotData.length,
        JSON.stringify(snapshotData),
        'manual',
        req.body.comment || 'Массовое обновление цен'
    );

    // Send prices to Ozon API
    await fetcher.updateProductPrices(store.client_id, store.api_key, priceUpdates, storeId, 'mass-update');

    // Create pending records (verify_after = NOW + 3 minutes)
    const verifyAfter = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    let pendingCount = 0;

    // Build offer_id -> product_id map from already-fetched products
    const productByOfferId = new Map(allProducts.map(p => [p.offer_id, p]));

    for (const update of priceUpdates) {
        if (!update.offer_id) continue;

        const dbProduct = productByOfferId.get(update.offer_id);
        if (!dbProduct || !dbProduct.id) continue; // нет валидного PK — пропускаем (иначе FK-нарушение)

        await db.createPendingUpdate({
            store_id: storeId,
            product_id: dbProduct.id, // PK products.id (FK), не Ozon product_id
            offer_id: update.offer_id,
            sent_price: parseFloat(update.price) || 0,
            sent_min_price: update.min_price ? parseFloat(update.min_price) : null,
            sent_old_price: update.old_price ? parseFloat(update.old_price) : null,
            verify_after: verifyAfter
        });
        pendingCount++;
    }

    res.json({
        success: true,
        snapshot_id: snapshotId,
        updated_count: priceUpdates.length,
        pending_count: pendingCount
    });
}));

// POST /api/stores/:id/protect-min-price
// Bulk set min_price = max(cost_price × (1 + margin_percent/100), floor_min_price)
// Только повышает min_price — не снижает.
router.post('/:id/protect-min-price', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const { product_ids, margin_percent } = req.body;

    if (!Array.isArray(product_ids) || product_ids.length === 0) {
        return res.status(400).json({ error: 'product_ids array is required' });
    }
    const margin = Math.max(0, Math.min(500, Number(margin_percent) || 0));

    const store = await db.getStoreById(storeId);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    if (store.platform === 'yandex') return res.status(400).json({ error: 'Only Ozon supported' });

    const allProducts = await db.getStoreProducts(storeId);
    const idSet = new Set(product_ids.map(String));
    const selected = allProducts.filter(p => idSet.has(String(p.product_id)));

    const priceUpdates = [];
    const skipped = [];

    for (const p of selected) {
        const cost = Number(p.cost_price) || 0;
        const floor = Number(p.floor_min_price) || 0;
        const currentMin = parseFloat(p.min_price || '0');
        const price = parseFloat(p.price || '0');

        const fromCost = cost > 0 ? cost * (1 + margin / 100) : 0;
        const target = Math.max(fromCost, floor);

        if (target <= 0) {
            skipped.push({ offer_id: p.offer_id, reason: 'нет cost_price и floor_min_price' });
            continue;
        }
        if (target <= currentMin + 0.01) {
            skipped.push({ offer_id: p.offer_id, reason: `current min_price ${currentMin} уже >= ${target.toFixed(2)}` });
            continue;
        }
        if (target > price && price > 0) {
            // не поднимаем min_price выше текущей price — иначе Ozon отклонит
            skipped.push({ offer_id: p.offer_id, reason: `target ${target.toFixed(2)} выше текущей цены ${price}` });
            continue;
        }

        const newMin = Math.round(target);
        priceUpdates.push({
            offer_id: p.offer_id,
            price: String(price || target),
            old_price: String(p.old_price || '0'),
            min_price: String(newMin),
            currency_code: p.currency_code || 'RUB',
        });
    }

    if (priceUpdates.length === 0) {
        return res.json({ updated: 0, skipped: skipped.length, skipped_details: skipped });
    }

    // Snapshot
    const snapshotData = selected
        .filter(p => priceUpdates.some(u => u.offer_id === p.offer_id))
        .map(p => ({
            offer_id: p.offer_id,
            price: p.price || '0',
            old_price: p.old_price || '0',
            min_price: p.min_price || '0',
            currency_code: p.currency_code || 'RUB',
        }));
    await db.createSnapshot(
        storeId,
        'protect-min-price',
        snapshotData.length,
        JSON.stringify(snapshotData),
        'manual',
        `Защита min_price (+${margin}% к cost)`,
    );

    // Send to Ozon
    const result = await fetcher.updateProductPrices(store.client_id, store.api_key, priceUpdates, storeId, 'protect-min');

    // Pending records
    const verifyAfter = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    const productByOfferId = new Map(allProducts.map(p => [p.offer_id, p]));
    for (const update of priceUpdates) {
        const dbProd = productByOfferId.get(update.offer_id);
        if (!dbProd || !dbProd.id) continue; // нет валидного PK — пропускаем (иначе FK-нарушение)
        await db.createPendingUpdate({
            store_id: storeId,
            product_id: dbProd.id, // PK products.id (FK), не Ozon product_id
            offer_id: update.offer_id,
            sent_price: parseFloat(update.price) || 0,
            sent_min_price: parseFloat(update.min_price),
            sent_old_price: parseFloat(update.old_price) || null,
            verify_after: verifyAfter,
        });
    }

    res.json({
        updated: priceUpdates.length,
        skipped: skipped.length,
        skipped_details: skipped,
        ozon_errors: result?._itemErrors || null,
    });
}));

// POST /api/stores/:id/verify-prices
router.post('/:id/verify-prices', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;

    const store = await db.getStoreById(storeId);
    if (!store) {
        return res.status(404).json({ error: 'Store not found' });
    }

    // Get all PENDING updates for this store
    const pendingUpdates = await db.getPendingUpdates(storeId, 'PENDING');

    if (pendingUpdates.length === 0) {
        return res.json({ verified: 0, ok: 0, failed: 0, failures: [] });
    }

    // Fetch current prices from Ozon API
    const offerIds = pendingUpdates.map(u => u.offer_id).filter(Boolean);
    const client = createOzonClient(store.client_id, store.api_key, { source: 'verifier', storeId });

    let currentPriceMap = new Map();
    try {
        // Fetch prices via v5/product/info/prices using offer_id filter
        const response = await client.post('/v5/product/info/prices', {
            filter: { offer_id: offerIds, visibility: 'ALL' },
            limit: offerIds.length > 1000 ? 1000 : offerIds.length
        }, { metadata: { itemsCount: offerIds.length, summary: `manual verify ${offerIds.length} prices` } });
        const items = response.data.items || [];
        for (const item of items) {
            const price = item.price?.price;
            if (item.offer_id && price != null) {
                currentPriceMap.set(item.offer_id, parseFloat(price));
            }
        }
    } catch (fetchErr) {
        console.error('Error fetching prices for verification:', fetchErr.message);
    }

    let okCount = 0;
    let failedCount = 0;
    const failures = [];

    for (const pending of pendingUpdates) {
        const actualPrice = currentPriceMap.get(pending.offer_id);
        const sentPrice = parseFloat(pending.sent_price);

        let status, failReason;

        if (actualPrice == null) {
            // Could not fetch actual price — treat as failure
            status = 'VERIFIED_FAIL';
            failReason = 'Не удалось получить текущую цену';
            failedCount++;
            failures.push({
                offer_id: pending.offer_id,
                sent_price: sentPrice,
                actual_price: null,
                reason: failReason
            });
        } else if (Math.abs(actualPrice - sentPrice) < 0.01) {
            status = 'VERIFIED_OK';
            okCount++;
        } else {
            status = 'VERIFIED_FAIL';
            failReason = `Ожидалась ${sentPrice}, фактически ${actualPrice}`;
            failedCount++;
            failures.push({
                offer_id: pending.offer_id,
                sent_price: sentPrice,
                actual_price: actualPrice,
                reason: failReason
            });
        }

        await db.updatePendingStatus(pending.id, status, actualPrice, failReason);
    }

    res.json({
        verified: pendingUpdates.length,
        ok: okCount,
        failed: failedCount,
        failures
    });
}));

// POST /api/stores/:id/schedule-update
router.post('/:id/schedule-update', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const { scheduled_at, updates_json, source } = req.body;

    if (!scheduled_at) {
        return res.status(400).json({ error: 'scheduled_at is required' });
    }

    const store = await db.getStoreById(storeId);
    if (!store) {
        return res.status(404).json({ error: 'Store not found' });
    }

    const id = await db.createScheduledUpdate(
        storeId,
        scheduled_at,
        source || 'manual',
        typeof updates_json === 'string' ? updates_json : JSON.stringify(updates_json || [])
    );

    res.json({ id, scheduled_at });
}));

// GET /api/stores/:id/scheduled-updates
router.get('/:id/scheduled-updates', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;

    const store = await db.getStoreById(storeId);
    if (!store) {
        return res.status(404).json({ error: 'Store not found' });
    }

    const updates = await db.getStoreScheduledUpdates(storeId);
    res.json(updates);
}));

// DELETE /api/stores/:id/scheduled-updates/:updateId
router.delete('/:id/scheduled-updates/:updateId', validateId('id'), validateId('updateId'), wrap(async (req, res) => {
    const { updateId } = req.params;

    await db.deleteScheduledUpdate(updateId);
    res.json({ success: true });
}));

// GET /api/stores/:id/snapshots
router.get('/:id/snapshots', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;

    const store = await db.getStoreById(storeId);
    if (!store) {
        return res.status(404).json({ error: 'Store not found' });
    }

    const { category } = req.query;
    const snapshots = await db.getStoreSnapshots(storeId, category || null);
    res.json(snapshots);
}));

// GET /api/stores/:id/snapshots/:snapshotId
router.get('/:id/snapshots/:snapshotId', validateId('id'), validateId('snapshotId'), wrap(async (req, res) => {
    const snapshot = await db.getSnapshotById(req.params.snapshotId);
    if (!snapshot) return res.status(404).json({ error: 'Snapshot not found' });
    if (String(snapshot.store_id) !== String(req.params.id)) {
        return res.status(403).json({ error: 'Snapshot does not belong to this store' });
    }
    res.json(snapshot);
}));

// POST /api/stores/:id/snapshots/:snapshotId/rollback
router.post('/:id/snapshots/:snapshotId/rollback', validateId('id'), validateId('snapshotId'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const { snapshotId } = req.params;

    const store = await db.getStoreById(storeId);
    if (!store) {
        return res.status(404).json({ error: 'Store not found' });
    }

    const snapshot = await db.getSnapshotById(snapshotId);
    if (!snapshot) {
        return res.status(404).json({ error: 'Snapshot not found' });
    }

    if (String(snapshot.store_id) !== String(storeId)) {
        return res.status(403).json({ error: 'Snapshot does not belong to this store' });
    }

    let snapshotItems;
    try {
        snapshotItems = JSON.parse(snapshot.snapshot_json);
    } catch {
        return res.status(500).json({ error: 'Failed to parse snapshot data' });
    }

    if (!Array.isArray(snapshotItems) || snapshotItems.length === 0) {
        return res.status(400).json({ error: 'Snapshot is empty or invalid' });
    }

    // Create a new snapshot of current state before rollback
    const allProducts = await db.getStoreProducts(storeId);
    const rollbackOfferIds = snapshotItems.map(i => i.offer_id).filter(Boolean);
    const currentProducts = allProducts.filter(p => rollbackOfferIds.includes(p.offer_id));

    const currentSnapshot = currentProducts.map(p => ({
        offer_id: p.offer_id,
        price: p.price || '0',
        old_price: p.old_price || '0',
        min_price: p.min_price || '0',
        currency_code: p.currency_code || 'RUB'
    }));

    await db.createSnapshot(
        storeId,
        'pre-rollback',
        currentSnapshot.length,
        JSON.stringify(currentSnapshot),
        'manual',
        'Pre-rollback snapshot'
    );

    // Build price updates for rollback
    const priceUpdates = snapshotItems.map(item => ({
        offer_id: item.offer_id,
        price: String(item.price),
        old_price: String(item.old_price || item.price),
        min_price: String(item.min_price || '0'),
        currency_code: item.currency_code || 'RUB'
    }));

    // Send rollback prices to Ozon API
    await fetcher.updateProductPrices(store.client_id, store.api_key, priceUpdates, storeId, 'mass-update');

    res.json({
        success: true,
        rolled_back_count: priceUpdates.length
    });
}));

// GET /api/stores/:id/promos — список акций с кол-вом товаров и названиями.
// Для Ozon — ЖИВЫЕ данные (/v1/actions): участие, freeze-статус; локальная БД только дополняет цены.
router.get('/:id/promos', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const store = await db.getStoreById(storeId);
    if (!store) return res.status(404).json({ error: 'Store not found' });

    const products = await db.getPromoProducts(storeId);

    // Локальные данные: диапазоны промо-цен по акциям
    const byAction = new Map();
    for (const p of products) {
        const id = p.promo_action_id;
        if (!byAction.has(id)) {
            byAction.set(id, { action_id: id, count: 0, min_price: Infinity, max_price: -Infinity });
        }
        const g = byAction.get(id);
        g.count++;
        if (p.promo_price != null) {
            if (p.promo_price < g.min_price) g.min_price = p.promo_price;
            if (p.promo_price > g.max_price) g.max_price = p.promo_price;
        }
    }

    // Разрешённые акции (whitelist)
    let allowedSet = new Set();
    try { allowedSet = new Set(JSON.parse(store.promo_allowed_actions || '[]').map(Number)); } catch {}

    let groups = [];
    if (store.platform === 'ozon') {
        // Живой список с Ozon — участвующие И потенциальные (чтобы можно было разрешить заранее)
        try {
            const live = await fetcher.fetchSelectableActions(store.client_id, store.api_key, storeId, 'promo_list');
            groups = live.map(a => {
                const local = byAction.get(a.action_id) || {};
                return {
                    action_id: a.action_id,
                    title: a.title || `Акция #${a.action_id}`,
                    date_start: a.date_start || null,
                    date_end: a.date_end || null,
                    count: a.participating_count,
                    potential_count: a.potential_count,
                    action_type: a.action_type,
                    allowed: allowedSet.has(a.action_id),
                    frozen: a.frozen,
                    freeze_date: a.freeze_date,
                    min_price: local.min_price === Infinity || local.min_price == null ? null : local.min_price,
                    max_price: local.max_price === -Infinity || local.max_price == null ? null : local.max_price,
                };
            }).sort((a, b) => (b.count - a.count) || (b.potential_count - a.potential_count));
        } catch (liveErr) {
            console.error(`[promos] store=${storeId} live fetch failed, falling back to DB:`, liveErr.message);
        }
    }

    // Fallback (ЯМ или ошибка живого запроса): локальная БД
    if (groups.length === 0 && byAction.size > 0) {
        let promoNames = new Map();
        if (store.platform === 'ozon') {
            try {
                const promoList = await fetcher.fetchPromoList(store.client_id, store.api_key, storeId);
                for (const p of promoList) promoNames.set(p.action_id, p);
            } catch {}
        }
        groups = [...byAction.values()].map(g => {
            const meta = promoNames.get(g.action_id) || {};
            return {
                action_id: g.action_id,
                title: meta.title || `Акция #${g.action_id}`,
                date_start: meta.date_start || null,
                date_end: meta.date_end || null,
                count: g.count,
                potential_count: 0,
                action_type: meta.action_type || null,
                allowed: allowedSet.has(g.action_id),
                frozen: false,
                freeze_date: null,
                min_price: g.min_price === Infinity ? null : g.min_price,
                max_price: g.max_price === -Infinity ? null : g.max_price,
            };
        }).sort((a, b) => b.count - a.count);
    }

    const totalLive = groups.reduce((s, g) => s + g.count, 0);
    res.json({
        total_products: totalLive || products.length,
        groups,
        promo_exit_enabled: !!store.promo_exit_enabled,
        promo_max_discount_percent: store.promo_max_discount_percent != null ? Number(store.promo_max_discount_percent) : 5,
        last_promo_exit_run: store.last_promo_exit_run || null,
    });
}));

// PUT /api/stores/:id/allowed-promos — сохранить список разрешённых акций (whitelist).
// Body: { allowed: number[] } — action_id, из которых НЕ выводим (кроме товаров со скидкой > порога).
router.put('/:id/allowed-promos', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const store = await db.getStoreById(storeId);
    if (!store) return res.status(404).json({ error: 'Store not found' });

    const allowed = Array.isArray(req.body?.allowed) ? req.body.allowed : [];
    await db.updateStoreAllowedPromos(storeId, allowed);
    const saved = JSON.parse((await db.getStoreById(storeId)).promo_allowed_actions || '[]');
    console.log(`[allowed-promos] store=${storeId} saved ${saved.length} allowed action(s)`);
    res.json({ success: true, allowed: saved });
}));

// POST /api/stores/:id/promos/exit-all — ручной форс-вывод из всех акций.
// Работает по ЖИВЫМ данным Ozon (не по устаревшей БД), учитывает rejected[] и freeze.
router.post('/:id/promos/exit-all', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const store = await db.getStoreById(storeId);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    if (store.platform !== 'ozon') return res.status(400).json({ error: 'Only Ozon stores supported' });

    console.log(`[exit-all] store=${storeId} manual trigger`);
    const actions = await fetcher.fetchParticipatingActions(store.client_id, store.api_key, storeId, 'promo_exit_manual');
    const active = actions.filter(a => !a.frozen);
    const frozen = actions.filter(a => a.frozen);

    let totalRemoved = 0;
    let totalRejected = 0;
    const errors = [];

    for (const action of active) {
        try {
            const actionProducts = await fetcher.fetchActionProducts(store.client_id, store.api_key, storeId, action.action_id, 'promo_exit_manual');
            if (actionProducts.length === 0) continue;
            const result = await fetcher.deactivatePromoProducts(
                store.client_id, store.api_key, storeId, action.action_id,
                actionProducts.map(p => p.product_id), 'promo_exit_manual'
            );
            totalRemoved += result.removedIds.length;
            totalRejected += result.rejected.length;
            if (result.removedIds.length > 0) await db.clearPromoFlags(storeId, result.removedIds);
            if (!result.success) errors.push({ action_id: action.action_id, error: result.error });
        } catch (err) {
            errors.push({ action_id: action.action_id, error: err.message });
        }
    }

    console.log(`[exit-all] store=${storeId} removed=${totalRemoved} rejected=${totalRejected} frozen_actions=${frozen.length} errors=${errors.length}`);
    res.json({
        success: true,
        removed: totalRemoved,
        rejected: totalRejected,
        frozen_actions: frozen.map(a => ({ action_id: a.action_id, title: a.title, date_end: a.date_end })),
        errors
    });
}));

module.exports = router;
