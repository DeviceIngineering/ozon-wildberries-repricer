/**
 * Диагностика функций репрайсера: живые пробы Ozon API + деградации по api_logs.
 */
const express = require('express');
const router = express.Router();
const db = require('../db.cjs');
const { validateId } = require('../middleware/validate.cjs');
const wrap = require('../middleware/asyncHandler.cjs');
const { runProbes, getDegradations } = require('../lib/apiDiagnostics.cjs');

// Полная диагностика магазина: пробы + деградации
router.post('/:id/diagnostics', validateId('id'), wrap(async (req, res) => {
    const store = await db.getStoreById(req.params.id);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    if (store.platform === 'yandex') {
        return res.status(400).json({ error: 'Диагностика доступна только для магазинов Ozon' });
    }
    const [probes, degradations] = await Promise.all([
        runProbes(store),
        getDegradations(store.id),
    ]);
    const failed = probes.filter(p => p.ok === false);
    res.json({
        storeId: store.id,
        storeName: store.name,
        checkedAt: new Date().toISOString(),
        healthy: failed.length === 0 && degradations.length === 0,
        probes,
        degradations,
    });
}));

// Только деградации (быстро, без запросов к Ozon) — для бейджа/мониторинга
router.get('/:id/diagnostics/degradations', validateId('id'), wrap(async (req, res) => {
    const store = await db.getStoreById(req.params.id);
    if (!store) return res.status(404).json({ error: 'Store not found' });
    const degradations = await getDegradations(store.id);
    res.json({ storeId: store.id, degradations });
}));

module.exports = router;
