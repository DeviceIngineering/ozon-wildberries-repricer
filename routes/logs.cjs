const express = require('express');
const router = express.Router();
const db = require('../db.cjs');
const { validateId } = require('../middleware/validate.cjs');
const wrap = require('../middleware/asyncHandler.cjs');

// Get log details
router.get('/:logId/details', validateId('logId'), wrap(async (req, res) => {
    const details = await db.getLogDetails(req.params.logId);
    res.json(details);
}));

module.exports = router;
