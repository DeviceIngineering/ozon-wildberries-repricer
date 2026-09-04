const express = require('express');
const router = express.Router();
const db = require('../db.cjs');
const { validateId } = require('../middleware/validate.cjs');
const { checkStore } = require('../repricer.cjs');
const { runMonitorForStore } = require('../scheduler.cjs');
const wrap = require('../middleware/asyncHandler.cjs');

// POST /api/stores/:id/repricer/run — manual trigger
router.post('/stores/:id/repricer/run', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const store = await db.getStoreById(storeId);
    if (!store) return res.status(404).json({ error: 'Магазин не найден' });
    if (!store.repricer_enabled) return res.status(400).json({ error: 'Репрайсер отключён для этого магазина' });
    await checkStore(storeId);
    res.json({ success: true });
}));

// POST /api/stores/:id/monitor/run — manual trigger for status sync
router.post('/stores/:id/monitor/run', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const store = await db.getStoreById(storeId);
    if (!store) return res.status(404).json({ error: 'Магазин не найден' });
    if (store.platform === 'yandex') {
        const { syncStore } = require('../yandexFetcher.cjs');
        await syncStore(storeId);
    } else {
        await runMonitorForStore(store);
    }
    res.json({ success: true });
}));

// GET /api/stores/:id/repricer-logs
router.get('/stores/:id/repricer-logs', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const { action, period, page, search, sort, order, limit } = req.query;
    const result = await db.getRepricerLogs(storeId, {
        action: action || null,
        period: period || null,
        page: parseInt(page) || 1,
        limit: Math.min(parseInt(limit) || 100, 500),
        search: search || null,
        sort: sort || null,
        order: order || null,
    });
    res.json(result);
}));

module.exports = router;
