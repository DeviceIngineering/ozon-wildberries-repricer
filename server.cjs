// Opt-in DNS override for hosts whose resolver cannot reach marketplace APIs
// (notably Docker's internal DNS proxy at 127.0.0.11, which resolves some
// Ozon/Yandex domains inconsistently). Off by default: this reroutes every
// lookup the process makes to public resolvers, which is the user's call.
if (process.env.FORCE_PUBLIC_DNS === '1') {
    const dns = require('dns');
    dns.setServers(['8.8.8.8', '1.1.1.1']);
    const _originalLookup = dns.lookup.bind(dns);
    dns.lookup = function patchedLookup(hostname, options, callback) {
        if (typeof options === 'function') { callback = options; options = {}; }
        const all = typeof options === 'object' && options.all;
        dns.resolve4(hostname, (err, addresses) => {
            if (err) return _originalLookup(hostname, options, callback);
            if (all) return callback(null, addresses.map(a => ({ address: a, family: 4 })));
            callback(null, addresses[0], 4);
        });
    };
    console.log('DNS: forced to 8.8.8.8 / 1.1.1.1');
}

// Sentry init — must come before express/scheduler so http/unhandled hooks are patched
const Sentry = require('./sentry.server.cjs');

const express = require('express');
const cors = require('cors');
const path = require('path');
const scheduler = require('./scheduler.cjs');

const app = express();
const PORT = process.env.PORT || 3001;

// Sentry request tracing must be first (after Sentry.init, before other middleware)
Sentry.setupExpressErrorHandler && null; // noop placeholder, real setup below after routes

// Reflecting any Origin together with credentials would let any website ride
// along with the user's session cookie. Restrict to configured origins.
const ALLOWED_ORIGINS = (process.env.TRUSTED_ORIGINS
    || process.env.BETTER_AUTH_URL
    || `http://localhost:${PORT}`)
    .split(',').map(o => o.trim()).filter(Boolean);

app.use(cors({
    origin(origin, cb) {
        // Same-origin and non-browser clients (curl, agents) send no Origin.
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        cb(new Error(`Origin not allowed: ${origin}`));
    },
    credentials: true,
}));

// --- Auth (better-auth, ESM module) ---
async function startServer() {
    const { auth } = await import('./auth.mjs');
    const { toNodeHandler, fromNodeHeaders } = await import('better-auth/node');

    // better-auth handler BEFORE express.json() (required by docs)
    app.all('/api/auth/{*path}', toNodeHandler(auth));

    // limit 10mb — массовые операции (импорт цен 1000+ позиций) превышают дефолтные 100kb
    app.use(express.json({ limit: '10mb' }));

    // ── Request logger: logs slow requests (>1s) and all 4xx/5xx ──────────────
    app.use((req, res, next) => {
        const start = Date.now();
        res.on('finish', () => {
            const ms = Date.now() - start;
            const status = res.statusCode;
            if (status >= 400 || ms > 1000) {
                const qs = Object.keys(req.query).length ? ' ?' + new URLSearchParams(req.query).toString() : '';
                console.error(`[HTTP] ${req.method} ${req.path}${qs} → ${status} (${ms}ms) user=${req.user?.email ?? 'anon'}`);
            }
        });
        next();
    });

    // Auth middleware: protect all /api/* routes (except /api/auth/*)
    const requireAuth = async (req, res, next) => {
        try {
            const session = await auth.api.getSession({
                headers: fromNodeHeaders(req.headers),
            });
            if (!session) {
                return res.status(401).json({ error: 'Unauthorized' });
            }
            req.user = session.user;
            req.session = session.session;
            if (session.user) {
                Sentry.setUser({ id: session.user.id, email: session.user.email });
            }
            next();
        } catch (err) {
            Sentry.captureException(err, { tags: { source: 'better-auth' } });
            return res.status(401).json({ error: 'Unauthorized' });
        }
    };

    // Permission check middleware
    const requirePermission = (...permissions) => (req, res, next) => {
        const role = req.user?.role || '';
        if (role === 'admin') return next();
        const userPerms = role.split(',').map(p => p.trim());
        const hasAccess = permissions.some(p => userPerms.includes(p));
        if (!hasAccess) {
            return res.status(403).json({ error: 'Forbidden: insufficient permissions' });
        }
        next();
    };

    // ── Внешний API для LLM-агента ценообразования (M2M, мастер-ключ) ──────────
    // Отдельный namespace /api/ext/v1 — НЕ cookie-сессии, а Bearer-ключ (EXTERNAL_API_KEY).
    // ВАЖНО: монтируется ДО cookie-защищённых `app.use('/api', requireAuth, ...)`,
    // иначе requireAuth на префиксе `/api` перехватит /api/ext/* и вернёт 401.
    // Порядок: rate-limit → аутентификация ключом → аудит мутаций → роуты.
    {
        const { requireApiKey, rateLimit } = require('./middleware/apiKeyAuth.cjs');
        const externalDb = require('./db.cjs');
        // Аудит: пишем строку по завершении запроса для мутаций (не-GET).
        const auditMiddleware = (req, res, next) => {
            res.on('finish', () => {
                if (req.method === 'GET') return;
                const a = req._audit || {};
                externalDb.logExternalCall({
                    ip: req.ip, method: req.method, path: req.originalUrl.split('?')[0],
                    status_code: res.statusCode,
                    store_id: a.store_id || null, action: a.action || null,
                    summary: a.summary || null, affected_count: a.affected_count || 0,
                });
            });
            next();
        };
        app.use('/api/ext/v1', rateLimit, requireApiKey, auditMiddleware, require('./routes/external.cjs'));
    }

    // Repricer routes (require 'repricer' permission)
    app.use('/api/stores', requireAuth, requirePermission('repricer'), require('./routes/stores.cjs'));
    app.use('/api/stores', requireAuth, requirePermission('repricer'), require('./routes/massUpdate.cjs'));
    app.use('/api/stores', requireAuth, requirePermission('repricer'), require('./routes/diagnostics.cjs'));
    app.use('/api', requireAuth, requirePermission('repricer'), require('./routes/prices.cjs'));
    app.use('/api/logs', requireAuth, requirePermission('repricer'), require('./routes/logs.cjs'));
    app.use('/api/dashboard', requireAuth, requirePermission('repricer'), require('./routes/dashboard.cjs'));
    app.use('/api', requireAuth, requirePermission('repricer'), require('./routes/crossStore.cjs'));
    app.use('/api', requireAuth, requirePermission('repricer'), require('./routes/apiLogs.cjs'));
    app.use('/api', requireAuth, requirePermission('repricer'), require('./routes/repricerLogs.cjs'));
    app.use('/api', requireAuth, requirePermission('repricer'), require('./routes/strategies.cjs'));
    app.use('/api', requireAuth, requirePermission('repricer'), require('./routes/masterPrices.cjs'));

    // Docs endpoint (no special permissions — any authenticated user)
    app.get('/api/docs', requireAuth, (req, res) => {
        const fs = require('fs');
        // The UI is Russian, so this serves the Russian guide.
        const docsPath = path.join(__dirname, 'docs', 'ru', 'user-guide.md');
        if (fs.existsSync(docsPath)) {
            res.type('text/plain').send(fs.readFileSync(docsPath, 'utf-8'));
        } else {
            res.status(404).send('Документация не найдена');
        }
    });

    // Sentry error handler must come BEFORE the final express error handler.
    // Captures all 4xx/5xx from asyncHandler-wrapped routes.
    if (Sentry.setupExpressErrorHandler) {
        Sentry.setupExpressErrorHandler(app);
    }

    // ── Global error handler ──────────────────────────────────────────────────
    app.use((err, req, res, next) => {
        const qs = Object.keys(req.query).length ? ' ?' + new URLSearchParams(req.query).toString() : '';
        console.error(`[ERROR] ${req.method} ${req.path}${qs} user=${req.user?.email ?? 'anon'}\n  ${err.stack || err.message}`);
        if (res.headersSent) return next(err);
        res.status(500).json({ error: err.message });
    });

    // Static files (frontend)
    app.use(express.static(path.join(__dirname, 'dist')));

    // SPA catch-all
    app.get('/{*path}', (req, res) => {
        res.sendFile(path.join(__dirname, 'dist', 'index.html'));
    });

    const httpServer = app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);
        scheduler.startScheduler();
    });

    const { db } = require('./db/connection.cjs');

    function gracefulShutdown(signal) {
        console.log(`[${signal}] Graceful shutdown...`);
        scheduler.stopScheduler();
        httpServer.close(() => {
            try { db.close(); } catch {}
            console.log('[Shutdown] Database closed. Exiting.');
            process.exit(0);
        });
        // Force exit if graceful shutdown hangs beyond stop_grace_period
        setTimeout(() => {
            console.error('[Shutdown] Forced exit after timeout');
            process.exit(1);
        }, 25000).unref();
    }

    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('SIGINT', () => gracefulShutdown('SIGINT'));
}

startServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
