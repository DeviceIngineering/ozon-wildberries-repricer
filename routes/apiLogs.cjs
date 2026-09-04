const express = require('express');
const router = express.Router();
const db = require('../db.cjs');
const { validateId } = require('../middleware/validate.cjs');
const wrap = require('../middleware/asyncHandler.cjs');

// GET /api/stores/:id/api-logs
router.get('/stores/:id/api-logs', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const { source, status, period, page } = req.query;
    const result = await db.getApiLogs(storeId, {
        source: source || null,
        status: status || null,
        period: period || null,
        page: parseInt(page) || 1,
    });
    res.json(result);
}));

module.exports = router;
