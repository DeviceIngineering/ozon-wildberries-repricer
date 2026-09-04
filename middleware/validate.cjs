/**
 * Middleware для валидации входных параметров Express-роутов.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Проверяет, что :paramName — непустая строка (UUID для store id, целое число для остальных).
 */
function validateId(paramName = 'id') {
    return (req, res, next) => {
        const raw = req.params[paramName];
        if (!raw) {
            return res.status(400).json({ error: `Missing ${paramName}` });
        }

        // Store ID — UUID string
        if (paramName === 'id') {
            // Accept both UUID and legacy integer (for backward compat during migration)
            if (UUID_RE.test(raw) || /^\d+$/.test(raw)) {
                return next();
            }
            return res.status(400).json({ error: `Invalid ${paramName}: must be a valid UUID` });
        }

        // Other IDs (productId, logId, etc.) — integer
        const value = parseInt(raw, 10);
        if (isNaN(value) || value <= 0) {
            return res.status(400).json({ error: `Invalid ${paramName}: must be a positive integer` });
        }
        req.params[paramName] = String(value);
        next();
    };
}

/**
 * Проверяет обязательные поля в req.body.
 * @param {string[]} fields - список обязательных полей
 */
function requireFields(fields) {
    return (req, res, next) => {
        const missing = fields.filter(f => req.body[f] === undefined || req.body[f] === '');
        if (missing.length > 0) {
            return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
        }
        next();
    };
}

module.exports = { validateId, requireFields };
