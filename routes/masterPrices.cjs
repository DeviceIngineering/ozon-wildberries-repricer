const express = require('express');
const router = express.Router();
const db = require('../db.cjs');
const ozonFetcher = require('../ozonFetcher.cjs');
const yandexFetcher = require('../yandexFetcher.cjs');
const wbFetcher = require('../wbFetcher.cjs');
const { deriveStorePrice } = require('../lib/masterPricing.cjs');
const wrap = require('../middleware/asyncHandler.cjs');

function getFetcher(platform) {
    if (platform === 'yandex') return yandexFetcher;
    if (platform === 'wildberries') return wbFetcher;
    return ozonFetcher;
}

// GET /api/master-prices — список изделий (группировка по offer_id) с ценами по магазинам
router.get('/master-prices', wrap(async (req, res) => {
    const { page, pageSize, search } = req.query;
    const result = await db.getMasterPriceGroups({ page, pageSize, search });
    res.json(result);
}));

// PUT /api/master-prices/:offerId — сохранить мастер-цену (эталон) во все магазины группы
router.put('/master-prices/:offerId', wrap(async (req, res) => {
    const { offerId } = req.params;
    const masterPrice = Number(req.body.master_price);
    if (!offerId) return res.status(400).json({ error: 'offerId обязателен' });
    if (!(masterPrice > 0)) return res.status(400).json({ error: 'master_price должна быть > 0' });

    const changed = await db.setMasterPrice(offerId, masterPrice);
    if (changed === 0) return res.status(404).json({ error: 'Изделие не найдено' });
    res.json({ success: true, offer_id: offerId, master_price: masterPrice, stores_updated: changed });
}));

/**
 * POST /api/master-prices/apply — вычислить производные цены и (при dry_run=false) отправить их.
 * body: { items: [{ offer_id, master_price? }], dry_run?: boolean, allow_below_cost?: boolean }
 * master_price опционально — если не задана, берётся текущий ref_price товара.
 */
router.post('/master-prices/apply', wrap(async (req, res) => {
    const { items, dry_run = true, allow_below_cost = false } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'items array is required' });
    }

    const results = [];
    // Ведро на магазин — чтобы отправить одним вызовом на площадку (минимум запросов, важно для WB).
    const stores = new Map(); // store_id -> { info, updates[], pendings[], snapshotItems[], offerIds:Set }

    for (const item of items) {
        const offerId = item.offer_id;
        if (!offerId) continue;
        const rows = await db.getGroupProducts(offerId);
        const master = Number(item.master_price) > 0
            ? Number(item.master_price)
            : (rows.find((r) => Number(r.ref_price) > 0)?.ref_price || 0);

        const groupResult = { offer_id: offerId, master_price: master, stores: [] };

        for (const r of rows) {
            const store = { platform: r.platform };
            const d = deriveStorePrice(master, store, r);
            const entry = {
                store_id: r.store_id,
                store_name: r.store_name,
                platform: r.platform,
                ok: d.ok,
                belowCost: !!d.belowCost,
                before: { price: r.price != null ? Number(r.price) : null },
                after: d.ok ? {
                    buyerPrice: d.buyerPrice,
                    priceNoDiscount: d.priceNoDiscount,
                    discountPercent: d.discountPercent,
                } : null,
                sent: false,
            };

            if (!d.ok) { entry.reason = d.reason || 'derive_failed'; groupResult.stores.push(entry); continue; }
            if (d.belowCost && !allow_below_cost) { entry.reason = 'below_cost'; groupResult.stores.push(entry); continue; }
            if (r.is_archived) { entry.reason = 'archived'; groupResult.stores.push(entry); continue; }

            if (!dry_run) {
                if (!stores.has(r.store_id)) {
                    stores.set(r.store_id, {
                        info: { store_id: r.store_id, platform: r.platform, client_id: r.client_id, api_key: r.api_key, wb_api_key: r.wb_api_key },
                        updates: [], pendings: [], snapshotItems: [], offerIds: new Set(),
                    });
                }
                const bucket = stores.get(r.store_id);
                bucket.updates.push(d.update);
                bucket.offerIds.add(offerId);
                bucket.snapshotItems.push({ offer_id: offerId, price: r.price || '0', old_price: r.old_price || '0' });
                if (r.id) {
                    bucket.pendings.push({
                        store_id: r.store_id,
                        product_id: r.id,
                        offer_id: offerId,
                        sent_price: Number(d.update.price) || 0,
                        sent_min_price: d.update.min_price != null ? Number(d.update.min_price) : null,
                        sent_old_price: d.update.old_price != null ? Number(d.update.old_price) : null,
                    });
                }
                entry._queuedStore = r.store_id;
            }
            groupResult.stores.push(entry);
        }
        results.push(groupResult);
    }

    let summary;
    if (dry_run) {
        summary = { dry_run: true, groups: results.length };
    } else {
        // Отправка последовательно по магазинам (WB per-seller rate limiter).
        const verifyAfter = new Date(Date.now() + 3 * 60 * 1000).toISOString();
        const storeStatus = {};
        for (const [storeId, bucket] of stores) {
            let ok = false, error = null;
            try {
                // Снапшот текущих цен до отправки (для отката).
                await db.createSnapshot(storeId, 'master-price', bucket.snapshotItems.length,
                    JSON.stringify(bucket.snapshotItems), 'manual', 'Управление ценами (мастер-цена)');

                const { platform, client_id, api_key, wb_api_key } = bucket.info;
                const fetcher = getFetcher(platform);
                if (platform === 'wildberries') {
                    await fetcher.updateProductPrices(wb_api_key, bucket.updates, storeId, 'master-price');
                } else {
                    await fetcher.updateProductPrices(client_id, api_key, bucket.updates, storeId, 'master-price');
                }

                for (const pend of bucket.pendings) {
                    await db.createPendingUpdate({ ...pend, verify_after: verifyAfter });
                }
                ok = true;
            } catch (e) {
                error = e.message || String(e);
            }
            storeStatus[storeId] = { ok, error, items: bucket.updates.length };
        }

        // Записать мастер-цену (эталон) во все магазины группы — для успешно обработанных изделий.
        for (const g of results) {
            if (g.master_price > 0) await db.setMasterPrice(g.offer_id, g.master_price);
        }

        // Проставить фактический статус отправки в ответ.
        for (const g of results) {
            for (const s of g.stores) {
                if (s._queuedStore && storeStatus[s._queuedStore]) {
                    s.sent = storeStatus[s._queuedStore].ok;
                    if (!storeStatus[s._queuedStore].ok) s.reason = 'send_failed';
                }
                delete s._queuedStore;
            }
        }
        const sent = Object.values(storeStatus).filter((x) => x.ok).length;
        const failed = Object.values(storeStatus).filter((x) => !x.ok).length;
        summary = { dry_run: false, groups: results.length, stores_sent: sent, stores_failed: failed };
    }

    res.json({ summary, results });
}));

module.exports = router;
