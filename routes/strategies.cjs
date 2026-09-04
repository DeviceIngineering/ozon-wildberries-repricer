const express = require('express');
const router = express.Router();
const db = require('../db.cjs');
const { validateId } = require('../middleware/validate.cjs');
const wrap = require('../middleware/asyncHandler.cjs');

// Сводка стратегий магазина (товары в эксперименте + состояние + последнее предложение)
router.get('/stores/:id/strategy/overview', validateId('id'), wrap(async (req, res) => {
    res.json(db.getStrategyOverview(req.params.id));
}));

// Лог решений стратегий (предложения dry-run + применённые)
router.get('/stores/:id/strategy/log', validateId('id'), wrap(async (req, res) => {
    res.json(db.getStrategyLog(req.params.id, parseInt(req.query.limit) || 200));
}));

// Назначить стратегию товарам. body: { offerIds:[], strategy_type, price_min, price_max,
//                                        target_margin, window_days, liquidation_max_loss_pct }
router.post('/stores/:id/strategy/assign', validateId('id'), wrap(async (req, res) => {
    const { offerIds, ...config } = req.body;
    if (!Array.isArray(offerIds) || offerIds.length === 0) {
        return res.status(400).json({ error: 'offerIds обязателен' });
    }
    if (config.strategy_type === 'liquidation' && config.liquidation_max_loss_pct == null) {
        return res.status(400).json({ error: 'liquidation_max_loss_pct обязателен для стратегии «слив»' });
    }
    const n = db.assignStrategy(req.params.id, offerIds.map(String), config);
    res.json({ success: true, assigned: n });
}));

// Авто-выбор пилота: топ-N товаров по объёму продаж за окно → назначить стратегию.
// body: { strategy_type, limit=20, window_days=30, ...config }
router.post('/stores/:id/strategy/pilot-auto', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const limit = parseInt(req.body.limit) || 20;
    const win = parseInt(req.body.window_days) || 30;
    const top = db.getTopSellingOffers(storeId, win, limit);
    if (top.length === 0) {
        return res.status(400).json({ error: 'Нет продаж за окно — пилот не выбран (нужна история продаж)' });
    }
    const offerIds = top.map(t => t.offer_id);
    const n = db.assignStrategy(storeId, offerIds, req.body);
    res.json({ success: true, assigned: n, offers: top.map(t => ({ offer_id: t.offer_id, units: t.total_units })) });
}));

// Включить/выключить авто-применение (gate) на эксперименте товара.
router.post('/stores/:id/strategy/experiment/:offerId/auto', validateId('id'), wrap(async (req, res) => {
    db.setExperimentAutoApply(req.params.id, req.params.offerId, !!req.body.on);
    res.json({ success: true });
}));

// Kill-switch магазина (остановить эксперименты магазина).
router.post('/stores/:id/strategy/kill-switch', validateId('id'), wrap(async (req, res) => {
    db.setStoreKillSwitch(req.params.id, !!req.body.on);
    res.json({ success: true });
}));

// Глобальный kill-switch стратегий.
router.post('/strategy/kill-switch', wrap(async (req, res) => {
    db.setAppSetting('strategy_kill_switch', req.body.on ? '1' : '0');
    res.json({ success: true, global_kill_switch: !!req.body.on });
}));

// Ручной прогон стратегий магазина (для проверки; применение только при auto_apply=1).
router.post('/stores/:id/strategy/run', validateId('id'), wrap(async (req, res) => {
    const strategyRunner = require('../strategyRunner.cjs');
    const result = await strategyRunner.runStore(req.params.id);
    res.json({ success: true, result });
}));

module.exports = router;
