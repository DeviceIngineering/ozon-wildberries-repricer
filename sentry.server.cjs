// Sentry init for backend. Must be required BEFORE any other instrumented modules.
// No-op if SENTRY_DSN_BACKEND is empty — safe for local dev without DSN.
const Sentry = require('@sentry/node');

const DSN = process.env.SENTRY_DSN_BACKEND || '';
const ENVIRONMENT = process.env.SENTRY_ENVIRONMENT || 'development';
const RELEASE = process.env.SENTRY_RELEASE || 'dev';

const SENSITIVE_KEYS = ['api_key', 'apiKey', 'Api-Key', 'client_id', 'clientId', 'Client-Id',
    'ym_api_key', 'token', 'password', 'authorization', 'cookie'];

function scrub(obj) {
    if (!obj || typeof obj !== 'object') return obj;
    for (const k of Object.keys(obj)) {
        if (SENSITIVE_KEYS.some(s => k.toLowerCase() === s.toLowerCase())) {
            obj[k] = '[REDACTED]';
        } else if (typeof obj[k] === 'object') {
            scrub(obj[k]);
        }
    }
    return obj;
}

if (DSN) {
    try {
        Sentry.init({
            dsn: DSN,
            environment: ENVIRONMENT,
            release: RELEASE,
            tracesSampleRate: 0,
            initialScope: {
                tags: { service: 'backend', node: process.version },
            },
            beforeBreadcrumb(breadcrumb) {
                // Не логируем http-запросы к Ozon API в breadcrumbs (там api_key в headers)
                if (breadcrumb.category === 'http' && breadcrumb.data?.url?.includes('api-seller.ozon.ru')) {
                    return null;
                }
                return breadcrumb;
            },
            beforeSend(event, hint) {
                // Отфильтровать шум: 401/403/404 + отменённые запросы
                const status = hint?.originalException?.status || hint?.originalException?.statusCode;
                if (status === 401 || status === 403 || status === 404) return null;
                if (hint?.originalException?.code === 'ECONNABORTED') return null;

                // SQLite: группируем отдельно по коду
                const sqliteCode = hint?.originalException?.code;
                if (typeof sqliteCode === 'string' && sqliteCode.startsWith('SQLITE_')) {
                    event.fingerprint = ['sqlite', sqliteCode];
                    event.tags = { ...event.tags, category: 'db-error', sqlite_code: sqliteCode };
                }

                // PII scrubbing
                if (event.request) {
                    if (event.request.headers) scrub(event.request.headers);
                    if (event.request.data) scrub(event.request.data);
                    if (event.request.query_string && typeof event.request.query_string === 'string') {
                        event.request.query_string = event.request.query_string.replace(
                            /(api_key|client_id|token)=[^&]+/gi,
                            '$1=[REDACTED]'
                        );
                    }
                }
                return event;
            },
        });

        process.on('unhandledRejection', (err) => {
            console.error('[unhandledRejection]', err);
            Sentry.captureException(err);
        });

        process.on('uncaughtException', (err) => {
            console.error('[uncaughtException]', err);
            Sentry.captureException(err);
            Sentry.close(2000).then(() => process.exit(1));
        });

        console.log(`[Sentry] Backend initialized (env=${ENVIRONMENT}, release=${RELEASE})`);
    } catch (e) {
        console.error('[Sentry] Init failed:', e.message);
    }
} else {
    console.log('[Sentry] Backend DSN not set — running without error reporting');
}

module.exports = Sentry;
