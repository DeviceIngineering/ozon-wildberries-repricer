/**
 * Фабричный метод для создания axios-клиента к Wildberries Seller API
 * с логированием вызовов, троттлингом (лимит WB ~10 req/6s на категорию)
 * и ретраями на 429/сетевые ошибки.
 *
 * Особенность WB: единого baseURL нет — у каждой группы методов свой хост.
 * Поэтому клиент создаётся без baseURL, а fetcher собирает полный URL из WB_HOSTS.
 */
const axios = require('axios');
const db = require('../db.cjs');

// Примечание: хосты WB не отдают AAAA (IPv6), default-DNS резолвит IPv4 сам и быстро.
// Кастомный ipv4-агент с keepAlive здесь приводил к зависанию сокета на discounts-prices-api —
// поэтому используем агент axios по умолчанию.

// Хосты сервисов WB (актуальны на 2025–2026)
const WB_HOSTS = {
    content: 'https://content-api.wildberries.ru',        // карточки товаров
    prices: 'https://discounts-prices-api.wildberries.ru', // цены и скидки
    calendar: 'https://dp-calendar-api.wildberries.ru',    // акции (Календарь)
    common: 'https://common-api.wildberries.ru',           // тарифы (комиссия/короб/возврат)
    analytics: 'https://seller-analytics-api.wildberries.ru', // платное хранение, отчёты
    statistics: 'https://statistics-api.wildberries.ru',   // продажи/выкуп
};

// Минимальный интервал между запросами. WB применяет строгий per-seller global limiter,
// поэтому держим консервативно ~5 req/6s (с запасом), чтобы не ловить 429.
const MIN_REQUEST_INTERVAL_MS = 1200;
const MAX_RETRIES = 3;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ГЛОБАЛЬНЫЙ троттлинг на процесс: общая очередь для ВСЕХ WB-клиентов.
// Иначе параллельные синк/репрайсер/promoExit создают свои клиенты и бёрстят запросы → 429.
let globalChain = Promise.resolve();
let globalLastAt = 0;
function throttle() {
    globalChain = globalChain.then(async () => {
        const wait = MIN_REQUEST_INTERVAL_MS - (Date.now() - globalLastAt);
        if (wait > 0) await sleep(wait);
        globalLastAt = Date.now();
    });
    return globalChain;
}

function createWbClient(apiKey, context = {}) {
    const { source = 'unknown', storeId = null } = context;

    const client = axios.create({
        headers: {
            // WB принимает токен как в формате "<token>", так и "Bearer <token>"
            'Authorization': apiKey,
            'Content-Type': 'application/json',
        },
        timeout: 60000,
    });

    // Глобальный троттлинг (общая очередь на процесс) — защита от 429 при параллельных операциях
    client.interceptors.request.use(async (config) => {
        await throttle();
        config._startTime = Date.now();
        return config;
    });

    client.interceptors.response.use(
        (response) => {
            if (storeId) {
                const meta = response.config.metadata || {};
                try {
                    db.insertApiLog(storeId, {
                        endpoint: response.config.url,
                        method: (response.config.method || 'post').toUpperCase(),
                        statusCode: response.status,
                        durationMs: Date.now() - (response.config._startTime || Date.now()),
                        itemsCount: meta.itemsCount || null,
                        requestSummary: meta.summary || null,
                        responseSummary: null,
                        errorMessage: null,
                        source,
                        retryAttempt: meta.retryAttempt || 0,
                    });
                } catch (e) { /* логирование не должно ломать основной поток */ }
            }
            return response;
        },
        async (error) => {
            const config = error.config || {};
            const status = error.response?.status;

            // Ретрай на 429 (превышен лимит) и транзиентных сетевых ошибках
            const retriable = status === 429 || (!error.response && error.code);
            config._retryCount = config._retryCount || 0;
            if (retriable && config._retryCount < MAX_RETRIES) {
                config._retryCount += 1;
                // WB на 429 может прислать X-Ratelimit-Retry; иначе экспоненциальный бэкофф
                const retryAfter = Number(error.response?.headers?.['x-ratelimit-retry']) || 0;
                const backoff = retryAfter > 0 ? retryAfter * 1000 : 1000 * Math.pow(2, config._retryCount);
                await sleep(backoff);
                config.metadata = { ...(config.metadata || {}), retryAttempt: config._retryCount };
                return client(config);
            }

            if (storeId) {
                const meta = config.metadata || {};
                try {
                    const body = error.response?.data ? ` | body: ${JSON.stringify(error.response.data).slice(0, 400)}` : '';
                    const netCode = !error.response && error.code ? ` [${error.code}]` : '';
                    db.insertApiLog(storeId, {
                        endpoint: config.url,
                        method: (config.method || 'post').toUpperCase(),
                        statusCode: status || null,
                        durationMs: Date.now() - (config._startTime || Date.now()),
                        itemsCount: meta.itemsCount || null,
                        requestSummary: meta.summary || null,
                        responseSummary: null,
                        errorMessage: `${error.message}${netCode}${body}`,
                        source,
                        retryAttempt: config._retryCount || 0,
                    });
                } catch (e) { /* логирование не должно ломать основной поток */ }
            }
            return Promise.reject(error);
        }
    );

    return client;
}

module.exports = { createWbClient, WB_HOSTS };
