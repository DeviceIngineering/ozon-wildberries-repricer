/**
 * Ozon Performance API (реклама): токен, список кампаний, деактивация, дневной бюджет.
 *
 * Ключи создаются в рекламном кабинете (Настройки → API-ключи) — это ОТДЕЛЬНЫЕ
 * credentials от Seller API. Храним в app_settings под ключом perf_api_<store_id>
 * значением JSON {"client_id":"...","client_secret":"..."}.
 *
 * Хост: api-performance.ozon.ru (performance.ozon.ru устарел).
 * Токен client_credentials живёт 30 мин — кэшируем с запасом.
 */
const axios = require('axios');
const { getAppSetting } = require('../db/strategies.cjs');

const HOST = 'https://api-performance.ozon.ru';
const tokenCache = new Map(); // client_id -> { token, expiresAt }

async function getCreds(storeId) {
    const row = getAppSetting(`perf_api_${storeId}`);
    if (!row) throw new Error(`Нет ключей Performance API для магазина ${storeId} (app_settings perf_api_${storeId})`);
    const creds = JSON.parse(row);
    if (!creds.client_id || !creds.client_secret) throw new Error('perf_api: нужны client_id и client_secret');
    return creds;
}

async function getToken(storeId) {
    const creds = await getCreds(storeId);
    const cached = tokenCache.get(creds.client_id);
    if (cached && cached.expiresAt > Date.now()) return cached.token;
    const r = await axios.post(`${HOST}/api/client/token`, {
        client_id: creds.client_id,
        client_secret: creds.client_secret,
        grant_type: 'client_credentials',
    }, { timeout: 30000 });
    const token = r.data.access_token;
    tokenCache.set(creds.client_id, { token, expiresAt: Date.now() + (r.data.expires_in - 60) * 1000 });
    return token;
}

async function api(storeId, method, path, data) {
    const token = await getToken(storeId);
    const r = await axios({
        method, url: `${HOST}${path}`, data,
        headers: { Authorization: `Bearer ${token}` }, timeout: 60000,
    });
    return r.data;
}

/** Список кампаний: [{id, title, state, advObjectType, dailyBudget, budget, ...}] */
async function listCampaigns(storeId) {
    const data = await api(storeId, 'get', '/api/client/campaign');
    return data.list || [];
}

async function deactivateCampaign(storeId, campaignId) {
    return api(storeId, 'post', `/api/client/campaign/${campaignId}/deactivate`, {});
}

async function activateCampaign(storeId, campaignId) {
    return api(storeId, 'post', `/api/client/campaign/${campaignId}/activate`, {});
}

/** dailyBudget в микрорублях? Нет: в копейках×10^4 (мкРуб). API принимает строку в мкРуб — передаём как есть из list. */
async function setDailyBudget(storeId, campaignId, dailyBudgetMicro) {
    return api(storeId, 'put', `/api/client/campaign/${campaignId}/daily_budget`, {
        dailyBudget: String(dailyBudgetMicro),
    });
}

/**
 * Срезать рекламные расходы (вариант Б, фаза 0):
 *  - кампании «оплата за заказ» (CPO/поиск: advObjectType SEARCH_PROMO_ORDERS и т.п.) → деактивировать
 *  - активные CPC-кампании (SKU/трафареты) → дневной бюджет × factor (по умолчанию 0.5)
 * dryRun=true — только план действий, без изменений.
 */
async function cutAds(storeId, { dryRun = true, budgetFactor = 0.5 } = {}) {
    const campaigns = await listCampaigns(storeId);
    const actions = [];
    for (const c of campaigns) {
        const running = String(c.state || '').includes('RUNNING');
        if (!running) { actions.push({ id: c.id, title: c.title, type: c.advObjectType, state: c.state, action: 'skip_not_running' }); continue; }
        const isCpo = /SEARCH_PROMO|ORDER/i.test(String(c.advObjectType || '')) || /за заказ/i.test(String(c.title || ''));
        if (isCpo) {
            actions.push({ id: c.id, title: c.title, type: c.advObjectType, action: 'deactivate' });
            if (!dryRun) await deactivateCampaign(storeId, c.id);
        } else {
            const cur = Number(c.dailyBudget || 0);
            if (cur > 0) {
                const next = Math.round(cur * budgetFactor);
                actions.push({ id: c.id, title: c.title, type: c.advObjectType, action: 'budget', from: cur, to: next });
                if (!dryRun) await setDailyBudget(storeId, c.id, next);
            } else {
                actions.push({ id: c.id, title: c.title, type: c.advObjectType, action: 'skip_no_daily_budget' });
            }
        }
    }
    return { dryRun, total: campaigns.length, actions };
}

/**
 * «Оплата за заказ» (продвижение в поиске) НЕ управляется /campaign/{id}/deactivate
 * (API отвечает «кампания не найдена» для ALL_SKU_PROMO/SEARCH_PROMO).
 * Управление — на уровне товаров: POST /api/client/search_promo/product/disable|enable
 * с телом {skus:[...]} (Ozon SKU, не product_id; собирать из /v3/product/info/list sources).
 */
async function searchPromoDisable(storeId, skus) {
    return api(storeId, 'post', '/api/client/search_promo/product/disable', { skus: skus.map(String) });
}
async function searchPromoEnable(storeId, skus) {
    return api(storeId, 'post', '/api/client/search_promo/product/enable', { skus: skus.map(String) });
}

module.exports = { listCampaigns, deactivateCampaign, activateCampaign, setDailyBudget, cutAds, searchPromoDisable, searchPromoEnable };
