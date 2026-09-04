const crypto = require('crypto');
const db = require('../db.cjs');

// ── Конфигурация из окружения ──────────────────────────────────────────────
// EXTERNAL_API_KEY   — мастер-ключ (Bearer). Не задан → внешний API отключён (503).
// EXTERNAL_API_ALLOWED_IPS — опц. CSV разрешённых IP (при пробросе порта в интернет).
// EXTERNAL_API_RATE_PER_MIN — опц. лимит запросов/мин (по умолчанию 120).

function getConfiguredKey() {
    return process.env.EXTERNAL_API_KEY || '';
}

function getAllowedIps() {
    return (process.env.EXTERNAL_API_ALLOWED_IPS || '')
        .split(',').map((s) => s.trim()).filter(Boolean);
}

// Сравнение в постоянном времени (защита от timing-атак). Разные длины → false без throw.
function safeEqual(a, b) {
    const ba = Buffer.from(String(a));
    const bb = Buffer.from(String(b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
}

function extractKey(req) {
    const auth = req.headers['authorization'] || '';
    if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
    const x = req.headers['x-api-key'];
    return typeof x === 'string' ? x.trim() : '';
}

// ── Простой in-memory rate limiter (скользящее окно 1 мин на IP) ────────────
const RATE_PER_MIN = parseInt(process.env.EXTERNAL_API_RATE_PER_MIN, 10) || 120;
const hits = new Map(); // ip -> number[] (таймстемпы мс)

function rateLimit(req, res, next) {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const windowStart = now - 60_000;
    const arr = (hits.get(ip) || []).filter((t) => t > windowStart);
    if (arr.length >= RATE_PER_MIN) {
        res.set('Retry-After', '60');
        return res.status(429).json({ error: 'Rate limit exceeded', code: 'rate_limited' });
    }
    arr.push(now);
    hits.set(ip, arr);
    // Периодическая чистка карты, чтобы не росла бесконечно.
    if (hits.size > 5000) {
        for (const [k, v] of hits) {
            if (!v.some((t) => t > windowStart)) hits.delete(k);
        }
    }
    next();
}

// ── Аутентификация мастер-ключом ───────────────────────────────────────────
function requireApiKey(req, res, next) {
    const configured = getConfiguredKey();
    // Ключ не настроен — внешний API выключен целиком (не открыть случайно).
    if (!configured) {
        return res.status(503).json({ error: 'External API not configured', code: 'not_configured' });
    }
    // Рантайм-выключатель из UI/БД (kill-switch внешнего API).
    if (!db.isExternalApiEnabled()) {
        return res.status(503).json({ error: 'External API disabled', code: 'disabled' });
    }
    // Опциональный IP-allowlist.
    const allowed = getAllowedIps();
    if (allowed.length > 0) {
        const ip = req.ip || '';
        // req.ip может быть в форме ::ffff:1.2.3.4 — сверяем и по «хвосту».
        const ok = allowed.some((a) => ip === a || ip.endsWith(':' + a) || ip.endsWith(a));
        if (!ok) return res.status(403).json({ error: 'IP not allowed', code: 'ip_forbidden' });
    }
    const provided = extractKey(req);
    if (!provided || !safeEqual(provided, configured)) {
        return res.status(401).json({ error: 'Invalid API key', code: 'unauthorized' });
    }
    req.isExternalApi = true;
    next();
}

module.exports = { requireApiKey, rateLimit, safeEqual, extractKey };
