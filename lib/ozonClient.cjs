/**
 * Фабричный метод для создания axios-клиента к Ozon Seller API
 * с автоматическим логированием всех API-вызовов.
 */
const axios = require('axios');
const db = require('../db.cjs');

const OZON_API_URL = 'https://api-seller.ozon.ru';

function createOzonClient(clientId, apiKey, context = {}) {
    const { source = 'unknown', storeId = null } = context;

    const client = axios.create({
        baseURL: OZON_API_URL,
        headers: {
            'Client-Id': clientId,
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
                    // Тело ответа Ozon — главный источник диагностики 400-х, не теряем его
                    const body = error.response?.data ? ` | body: ${JSON.stringify(error.response.data).slice(0, 400)}` : '';
                    // Классификация сетевых ошибок (status null): таймаут/DNS/refused различимы по error.code
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

module.exports = { createOzonClient, OZON_API_URL };
