const express = require('express');
const router = express.Router();
const db = require('../db.cjs');
const ozonFetcher = require('../ozonFetcher.cjs');
const yandexFetcher = require('../yandexFetcher.cjs');
const wbFetcher = require('../wbFetcher.cjs');
const { validateId, requireFields } = require('../middleware/validate.cjs');
const { computeOldPrice } = require('../lib/priceHelpers.cjs');
const wrap = require('../middleware/asyncHandler.cjs');

function getFetcher(platform) {
    if (platform === 'yandex') return yandexFetcher;
    if (platform === 'wildberries') return wbFetcher;
    return ozonFetcher;
}

// Get All Stores
router.get('/', wrap(async (req, res) => {
    const stores = await db.getAllStores();
    res.json(stores);
}));

// Add Store
router.post('/', (req, res, next) => {
    const platform = req.body.platform || 'ozon';
    const missing = ['name'];
    if (platform === 'yandex') {
        if (!req.body.ym_business_id) missing.push('ym_business_id');
        if (!req.body.ym_campaign_id) missing.push('ym_campaign_id');
        if (!req.body.ym_api_key) missing.push('ym_api_key');
    } else if (platform === 'wildberries') {
        if (!req.body.wb_api_key) missing.push('wb_api_key');
    } else {
        if (!req.body.client_id) missing.push('client_id');
        if (!req.body.api_key) missing.push('api_key');
    }
    const actual = missing.filter(f => !req.body[f] || req.body[f] === '');
    if (actual.length > 0) {
        return res.status(400).json({ error: `Не заполнены обязательные поля: ${actual.join(', ')}` });
    }
    next();
}, wrap(async (req, res) => {
    const newStore = await db.createStore(req.body);
    res.json(newStore);
}));

// Delete Store
router.delete('/:id', validateId('id'), wrap(async (req, res) => {
    await db.deleteStore(req.params.id);
    res.json({ success: true });
}));

// Update Store
router.put('/:id', validateId('id'), wrap(async (req, res) => {
    const updated = await db.updateStore(req.params.id, req.body);
    res.json(updated);
}));

// Manual Sync
router.post('/:id/sync', validateId('id'), wrap(async (req, res) => {
    const store = await db.getStoreById(req.params.id);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const fetcher = getFetcher(store.platform);
    const result = await fetcher.syncStore(req.params.id);
    if (result.success) {
        res.json(result);
    } else {
        res.status(500).json(result);
    }
}));

// Single Product Sync
router.post('/:id/products/:productId/sync', validateId('id'), validateId('productId'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const productId = parseInt(req.params.productId, 10);

    const store = await db.getStoreById(storeId);
    const storeFetcher = getFetcher(store?.platform);
    const result = await storeFetcher.syncProduct(storeId, productId);
    if (result.success) {
        res.json(result);
    } else {
        res.status(500).json(result);
    }
}));

// Get Store Logs
router.get('/:id/logs', validateId('id'), wrap(async (req, res) => {
    const logs = await db.getStoreLogs(req.params.id);
    res.json(logs);
}));

// Числовые range-фильтры "от/до" для таблицы товаров — плоские query-параметры, не JSON
const NUMERIC_FILTER_KEYS = [
    'sales_30d_min', 'sales_30d_max',
    'stocks_fbo_min', 'stocks_fbo_max',
    'stocks_fbs_min', 'stocks_fbs_max',
    'cost_price_min', 'cost_price_max',
    'price_min', 'price_max',
];

function parseNumericFilters(query) {
    const numericFilters = {};
    for (const key of NUMERIC_FILTER_KEYS) {
        const n = Number(query[key]);
        if (query[key] !== undefined && query[key] !== '' && !Number.isNaN(n)) numericFilters[key] = n;
    }
    return numericFilters;
}

// Get Store Products (with optional pagination)
router.get('/:id/products', validateId('id'), wrap(async (req, res) => {
    const { page, pageSize, sort, search, filter } = req.query;
    const numericFilters = parseNumericFilters(req.query);
    if (page || pageSize || sort || search || filter || Object.keys(numericFilters).length > 0) {
        const result = await db.getStoreProductsPaginated(req.params.id, {
            page: parseInt(page) || 1,
            pageSize: parseInt(pageSize) || 20,
            sort, search, filter, numericFilters
        });
        res.json(result);
    } else {
        // Backward compatible — return all
        const products = await db.getStoreProducts(req.params.id);
        res.json(products);
    }
}));

// Update Product Prices
router.post('/:id/update-prices', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const { priceUpdates } = req.body;

    if (!priceUpdates || !Array.isArray(priceUpdates)) {
        return res.status(400).json({ error: 'priceUpdates array is required' });
    }

    const store = await db.getStoreById(storeId);
    if (!store) {
        return res.status(404).json({ error: 'Store not found' });
    }

    // Нормализовать old_price перед отправкой
    const normalizedUpdates = priceUpdates.map(u => {
        const price = parseFloat(u.price) || 0;
        const minPrice = parseFloat(u.min_price) || price;
        const oldPrice = parseFloat(u.old_price);
        return {
            ...u,
            old_price: (oldPrice > 0) ? u.old_price : String(computeOldPrice(price, minPrice)),
        };
    });

    const fetcher = getFetcher(store.platform);
    let result;
    if (store.platform === 'wildberries') {
        // WB: единый токен, пара {nmID, price, discount} формируется внутри fetcher из normalizedUpdates
        result = await fetcher.updateProductPrices(store.wb_api_key, normalizedUpdates, storeId, 'manual');
    } else {
        result = await fetcher.updateProductPrices(
            store.client_id,
            store.api_key,
            normalizedUpdates,
            storeId,
            'manual'
        );
    }

    for (const update of priceUpdates) {
        if (update.offer_id) {
            await db.updateProductRefPrice(
                storeId,
                update.offer_id,
                update.price,
                update.min_price || '0'
            );
        }
    }

    res.json({ success: true, result, item_errors: result?._itemErrors || [] });
}));

// Snapshots & scheduled-updates routes are in massUpdate.cjs

module.exports = router;
