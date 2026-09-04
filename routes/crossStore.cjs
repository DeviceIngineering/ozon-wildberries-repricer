const express = require('express');
const router = express.Router();
const db = require('../db.cjs');
const wrap = require('../middleware/asyncHandler.cjs');

// GET /api/products/:offerId/cross-store
router.get('/products/:offerId/cross-store', wrap(async (req, res) => {
    const { offerId } = req.params;
    if (!offerId) {
        return res.status(400).json({ error: 'offerId обязателен' });
    }

    const rows = await db.getCrossStoreProducts(offerId);

    const result = rows.map((r) => ({
        store_id: r.store_id,
        store_name: r.store_name,
        price: r.price,
        cost_price: r.cost_price,
        marketing_price: r.marketing_price,
    }));

    res.json(result);
}));

module.exports = router;
