const express = require('express');
const router = express.Router();
const db = require('../db.cjs');
const wrap = require('../middleware/asyncHandler.cjs');

router.get('/summary', wrap(async (req, res) => {
    const summary = await db.getDashboardSummary();
    res.json(summary);
}));

// Кокпит решений: задачи для человека, слой автоматики, аналитика
router.get('/cockpit', wrap(async (req, res) => {
    const period = ['24h', '7d', '30d'].includes(req.query.period) ? req.query.period : '7d';
    const data = await db.getDecisionCockpit(period);
    res.json(data);
}));

module.exports = router;
