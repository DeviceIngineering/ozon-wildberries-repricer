/**
 * Контроль функций репрайсера: соответствие используемых эндпоинтов Ozon API.
 *
 * Два механизма:
 *  1. Живые пробы — лёгкие запросы (limit=1) по read-эндпоинтам, от которых
 *     зависит репрайсер/фетчер/promoExiter. 404 = Ozon изменил API.
 *  2. Детектор деградаций — анализ api_logs: эндпоинт стабильно работал,
 *     а последние вызовы стабильно падают = сигнал изменения API или ключей.
 *
 * Список эндпоинтов сверен с актуальным Ozon API (ревизия 06.2026):
 * все используемые пути актуальны; v5 цен требует обязательный filter (есть).
 */
const { createOzonClient } = require('./ozonClient.cjs');
const { db: rawDb, dbAll, dbGet } = require('../db/connection.cjs');

// Функции репрайсера → эндпоинты Ozon, от которых они зависят.
// probe: null — write-эндпоинт, вживую не дёргаем (контроль только по api_logs).
const FUNCTIONS = [
    {
        key: 'prices_read',
        label: 'Чтение цен и комиссий (репрайсер, фетчер)',
        endpoint: '/v5/product/info/prices',
        probe: (c) => c.post('/v5/product/info/prices', { filter: { visibility: 'ALL' }, limit: 1, cursor: '' }),
    },
    {
        key: 'prices_write',
        label: 'Установка цен (репрайсер, массовое обновление)',
        endpoint: '/v1/product/import/prices',
        probe: null,
    },
    {
        key: 'product_list',
        label: 'Список товаров (фетчер)',
        endpoint: '/v3/product/list',
        probe: (c) => c.post('/v3/product/list', { filter: { visibility: 'ALL' }, limit: 1, last_id: '' }),
    },
    {
        key: 'product_info',
        label: 'Информация о товарах (фетчер)',
        endpoint: '/v3/product/info/list',
        // product_id берём из product_list внутри runProbes
        probe: 'needs_product',
    },
    {
        key: 'stocks',
        label: 'Остатки FBO/FBS (фетчер)',
        endpoint: '/v4/product/info/stocks',
        probe: (c) => c.post('/v4/product/info/stocks', { filter: { visibility: 'ALL' }, limit: 1, cursor: '' }),
    },
    {
        key: 'actions',
        label: 'Список акций (promoExiter, promoGuard)',
        endpoint: '/v1/actions',
        probe: (c) => c.get('/v1/actions'),
    },
    {
        key: 'actions_products',
        label: 'Товары в акции (promoExiter)',
        endpoint: '/v1/actions/products',
        // action_id берём из /v1/actions внутри runProbes
        probe: 'needs_action',
    },
    {
        key: 'actions_deactivate',
        label: 'Вывод товаров из акций (promoExiter)',
        endpoint: '/v1/actions/products/deactivate',
        probe: null,
    },
];

const HINTS = {
    401: 'Ключ Seller API не действует (истёк или отозван) — обновите в настройках магазина',
    403: 'Доступ запрещён — проверьте права ключа',
    404: 'Эндпоинт не найден — Ozon изменил API, репрайсеру нужно обновление!',
    429: 'Лимит запросов (не ошибка — API доступен)',
};

/**
 * Живые пробы read-эндпоинтов магазина. Последовательно (бережём rate limit).
 */
async function runProbes(store) {
    const client = createOzonClient(store.client_id, store.api_key, {
        source: 'diagnostics', storeId: store.id,
    });
    const results = [];
    let sampleProductId = null;
    let sampleActionId = null;

    for (const fn of FUNCTIONS) {
        if (fn.probe === null) {
            results.push({ ...pick(fn), ok: null, note: 'write-эндпоинт: контролируется по логам вызовов' });
            continue;
        }
        const started = Date.now();
        try {
            let res;
            if (fn.probe === 'needs_product') {
                if (!sampleProductId) throw skipError('нет товара для пробы (product_list не вернул items)');
                res = await client.post('/v3/product/info/list', { product_id: [sampleProductId] });
            } else if (fn.probe === 'needs_action') {
                if (!sampleActionId) {
                    results.push({ ...pick(fn), ok: null, note: 'нет активных акций — проба пропущена' });
                    continue;
                }
                res = await client.post('/v1/actions/products', { action_id: sampleActionId, limit: 1 });
            } else {
                res = await fn.probe(client);
            }

            // Запоминаем образцы для зависимых проб
            if (fn.key === 'product_list') {
                sampleProductId = res.data?.result?.items?.[0]?.product_id || null;
            }
            if (fn.key === 'actions') {
                sampleActionId = res.data?.result?.[0]?.id || null;
            }

            results.push({ ...pick(fn), ok: true, latencyMs: Date.now() - started });
        } catch (e) {
            if (e._skip) {
                results.push({ ...pick(fn), ok: null, note: e.message });
                continue;
            }
            const status = e.response?.status || null;
            if (status === 429) {
                results.push({ ...pick(fn), ok: true, latencyMs: Date.now() - started, note: HINTS[429] });
                continue;
            }
            results.push({
                ...pick(fn), ok: false,
                latencyMs: Date.now() - started,
                statusCode: status,
                hint: HINTS[status] || '',
                error: (e.response?.data ? JSON.stringify(e.response.data) : e.message).slice(0, 300),
            });
        }
        // Пауза между пробами — у Ozon посекундные лимиты
        await sleep(1200);
    }
    return results;
}

/**
 * Деградации по api_logs: последние calls подряд — ошибки, при этом ранее
 * эндпоинт успешно работал. Срабатывает на реальном трафике репрайсера —
 * автоматический контроль без дополнительных запросов к Ozon.
 */
async function getDegradations(storeId, minConsecutive = 3) {
    const rows = await dbAll(rawDb,
        `SELECT DISTINCT endpoint FROM api_logs WHERE store_id = ? AND timestamp >= datetime('now', '-30 days')`,
        [storeId]
    );
    const degraded = [];
    for (const { endpoint } of rows) {
        try {
            const recent = await dbAll(rawDb,
                `SELECT status_code, error_message, timestamp FROM api_logs
                 WHERE store_id = ? AND endpoint = ? ORDER BY id DESC LIMIT ?`,
                [storeId, endpoint, minConsecutive]
            );
            if (recent.length < minConsecutive) continue;
            const allFailed = recent.every(r => !r.status_code || r.status_code >= 400);
            if (!allFailed) continue;
            // 429 — лимиты, не деградация
            if (recent.every(r => r.status_code === 429)) continue;
            const lastOk = await dbGet(rawDb,
                `SELECT timestamp FROM api_logs
                 WHERE store_id = ? AND endpoint = ? AND status_code >= 200 AND status_code < 300
                 ORDER BY id DESC LIMIT 1`,
                [storeId, endpoint]
            );
            if (!lastOk) continue; // никогда не работал — не деградация
            degraded.push({
                endpoint,
                lastSuccess: lastOk.timestamp,
                consecutiveErrors: recent.length,
                lastError: `${recent[0].status_code || 'network'}: ${(recent[0].error_message || '').slice(0, 200)}`,
                firstErrorAt: recent[recent.length - 1].timestamp,
                affectedFunction: FUNCTIONS.find(f => f.endpoint === endpoint)?.label || null,
            });
        } catch (e) { /* пропускаем эндпоинт при ошибке анализа */ }
    }
    return degraded;
}
function pick(fn) {
    return { key: fn.key, label: fn.label, endpoint: fn.endpoint };
}
function skipError(msg) {
    const e = new Error(msg);
    e._skip = true;
    return e;
}
function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

module.exports = { FUNCTIONS, runProbes, getDegradations };
