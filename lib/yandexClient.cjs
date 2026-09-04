/**
 * Фабричный метод для создания axios-клиента к Yandex Market Partner API
 * с автоматическим логированием всех API-вызовов.
 */
const axios = require('axios');
const https = require('https');
const dns = require('dns');
const db = require('../db.cjs');

const YM_API_URL = 'https://api.partner.market.yandex.ru';

// dns.lookup returns IPv6-only on this server; use dns.resolve4 with retries to force IPv4.
// ENODATA is transient (Yandex DNS inconsistency), so retry up to 5 times before failing.
function ipv4Lookup(hostname, opts, cb) {
    let attempts = 0;
    const MAX = 5;
    const tryOnce = () => {
        dns.resolve4(hostname, (err, addrs) => {
            if (!err && addrs && addrs.length > 0) {
                return opts && opts.all
                    ? cb(null, addrs.map(a => ({ address: a, family: 4 })))
                    : cb(null, addrs[0], 4);
            }
            if (++attempts < MAX) return setTimeout(tryOnce, 200);
            cb(err || new Error('No IPv4 for ' + hostname));
        });
    };
    tryOnce();
}

const ipv4Agent = new https.Agent({ lookup: ipv4Lookup });

function createYandexClient(apiKey, context = {}) {
    const { source = 'unknown', storeId = null } = context;

    const client = axios.create({
        baseURL: YM_API_URL,
        httpsAgent: ipv4Agent,
        headers: {
            'Api-Key': apiKey,
            'Content-Type': 'application/json'
        }
    });

    // Request interceptor: mark start time
    client.interceptors.request.use((config) => {
        config._startTime = Date.now();
        return config;
    });

    // Response interceptor: log success
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
                } catch (e) { /* logging should never break main flow */ }
            }
            return response;
        },
        (error) => {
            if (storeId) {
                const config = error.config || {};
                const meta = config.metadata || {};
                try {
                    // Тело ответа и код сетевой ошибки — основа диагностики (см. инцидент с enum 400)
                    const body = error.response?.data ? ` | body: ${JSON.stringify(error.response.data).slice(0, 400)}` : '';
                    const netCode = !error.response && error.code ? ` [${error.code}]` : '';
                    db.insertApiLog(storeId, {
                        endpoint: config.url,
                        method: (config.method || 'post').toUpperCase(),
                        statusCode: error.response?.status || null,
                        durationMs: Date.now() - (config._startTime || Date.now()),
                        itemsCount: meta.itemsCount || null,
                        requestSummary: meta.summary || null,
                        responseSummary: null,
                        errorMessage: `${error.message}${netCode}${body}`,
                        source,
                        retryAttempt: meta.retryAttempt || 0,
                    });
                } catch (e) { /* logging should never break main flow */ }
            }
            return Promise.reject(error);
        }
    );

    return client;
}

module.exports = { createYandexClient, YM_API_URL };
