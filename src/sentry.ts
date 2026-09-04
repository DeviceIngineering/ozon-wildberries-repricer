import * as Sentry from '@sentry/react';

const DSN = import.meta.env.VITE_SENTRY_DSN || '';
const ENVIRONMENT = import.meta.env.VITE_SENTRY_ENVIRONMENT || import.meta.env.MODE;
const RELEASE = import.meta.env.VITE_SENTRY_RELEASE || 'dev';

const IGNORE_PATTERNS = [
    /ResizeObserver loop/,
    /Non-Error promise rejection captured/,
    /AbortError/,
    /Failed to fetch/,
    /Load failed/,
    /NetworkError/,
];

if (DSN) {
    try {
        Sentry.init({
            dsn: DSN,
            environment: ENVIRONMENT,
            release: RELEASE,
            tracesSampleRate: 0,
            replaysOnErrorSampleRate: 0,
            replaysSessionSampleRate: 0,
            integrations: [Sentry.browserTracingIntegration()],
            initialScope: { tags: { service: 'frontend' } },
            beforeSend(event, hint) {
                const status = (hint?.originalException as { status?: number } | undefined)?.status;
                if (status === 401 || status === 403 || status === 404) return null;

                const msg = (hint?.originalException as Error | undefined)?.message
                    || event.message
                    || '';
                if (IGNORE_PATTERNS.some((re) => re.test(msg))) return null;

                return event;
            },
        });
        console.log(`[Sentry] Frontend initialized (env=${ENVIRONMENT}, release=${RELEASE})`);
    } catch (e) {
        console.error('[Sentry] Init failed:', e);
    }
} else {
    console.log('[Sentry] Frontend DSN not set — running without error reporting');
}

export { Sentry };
