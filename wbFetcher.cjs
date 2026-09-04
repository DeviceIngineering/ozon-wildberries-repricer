/**
 * Wildberries fetcher — синхронизация товаров/цен/остатков и отправка цен.
 *
 * Ключевые особенности WB (см. project_wb_repricer):
 *  - Идентификаторы: nmID (числовой артикул WB) → products.ozon_id; vendorCode → products.offer_id.
 *  - Цена двухпараметрическая: пара {nmID, price, discount}. discountedPrice = price×(1−discount/100)
 *    это цена продавца (база выплаты) и то, что показываем как "price" в карточке/истории.
 *  - У каждой группы методов свой хост (см. WB_HOSTS).
 */
const { createWbClient, WB_HOSTS } = require('./lib/wbClient.cjs');
const Sentry = require('./sentry.server.cjs');
const db = require('./db.cjs');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Ограничение времени на некритичный шаг: если запрос виснет — не стопорим весь синк.
function withTimeout(promise, ms, label) {
    return Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms)),
    ]);
}

// Объём упаковки (л) из габаритов карточки (см): нужен для расчёта логистики короба.
function dimsToLiters(dimensions) {
    if (!dimensions) return null;
    const { length, width, height } = dimensions;
    if (!(length > 0 && width > 0 && height > 0)) return null;
    return (length * width * height) / 1000;
}

// Загрузка всех карточек товаров (content API, курсорная пагинация).
async function fetchCards(apiKey, storeId) {
    const client = createWbClient(apiKey, { source: 'sync', storeId });
    const url = `${WB_HOSTS.content}/content/v2/get/cards/list`;
    const LIMIT = 100;
    const cards = [];
    let cursor = { limit: LIMIT };

    while (true) {
        const resp = await client.post(url, {
            settings: { cursor, filter: { withPhoto: -1 } }
        }, { metadata: { itemsCount: LIMIT, summary: `cards cursor nm=${cursor.nmID || 'start'}` } });

        const batch = resp.data?.cards || [];
        for (const c of batch) {
            const photo = (c.photos && c.photos[0]) || null;
            cards.push({
                nmID: c.nmID,
                vendorCode: c.vendorCode,
                name: c.title || c.vendorCode || String(c.nmID),
                subjectId: c.subjectID,
                volumeLiters: dimsToLiters(c.dimensions),
                // Превью для списка товаров (CDN WB, публичные)
                image: photo ? (photo.c246x328 || photo.square || photo.tm || photo.big || null) : null,
            });
        }

        const respCursor = resp.data?.cursor || {};
        // Конец: пришло меньше лимита
        if (batch.length < LIMIT) break;
        cursor = { limit: LIMIT, updatedAt: respCursor.updatedAt, nmID: respCursor.nmID };
    }
    return cards;
}

// Текущие цены и скидки (prices API, пагинация по offset).
// Возвращает Map: nmID -> { priceBase, discount, discountedPrice, clubDiscount }
async function fetchPrices(apiKey, storeId) {
    const client = createWbClient(apiKey, { source: 'sync', storeId });
    const LIMIT = 1000;
    const map = new Map();
    let offset = 0;

    while (true) {
        const url = `${WB_HOSTS.prices}/api/v2/list/goods/filter?limit=${LIMIT}&offset=${offset}`;
        const resp = await client.get(url, { metadata: { summary: `prices offset=${offset}` } });
        const goods = resp.data?.data?.listGoods || [];
        for (const g of goods) {
            // Берём цену первого размера (репрайсинг на уровне nmID — см. Q7)
            const size = (g.sizes && g.sizes[0]) || {};
            map.set(g.nmID, {
                priceBase: size.price,
                discount: g.discount ?? 0,
                discountedPrice: size.discountedPrice ?? size.price,
                clubDiscount: g.clubDiscount ?? 0,
            });
        }
        if (goods.length < LIMIT) break;
        offset += LIMIT;
    }
    return map;
}

// Товары в ценовом карантине WB (цена снижена слишком сильно, новая не применена).
// Возвращает Set<nmID>.
async function fetchQuarantine(apiKey, storeId) {
    const client = createWbClient(apiKey, { source: 'monitor', storeId });
    const LIMIT = 1000;
    const set = new Set();
    let offset = 0;
    while (true) {
        const url = `${WB_HOSTS.prices}/api/v2/quarantine/goods?limit=${LIMIT}&offset=${offset}`;
        const resp = await client.get(url, { metadata: { summary: `quarantine offset=${offset}` } });
        const goods = resp.data?.data?.listGoods || [];
        for (const g of goods) if (g.nmID != null) set.add(g.nmID);
        if (goods.length < LIMIT) break;
        offset += LIMIT;
    }
    return set;
}

// Остатки FBW (склады WB). Возвращает Map: nmID -> qty. Best-effort.
// statistics-api /api/v1/supplier/stocks удалён WB (404 с 08.2026) — теперь
// асинхронный отчёт seller-analytics warehouse_remains: create → poll status → download.
async function fetchStocks(apiKey, storeId) {
    const client = createWbClient(apiKey, { source: 'sync', storeId });
    const base = `${WB_HOSTS.analytics}/api/v1/warehouse_remains`;

    const created = await client.get(`${base}?groupByNm=true`, { metadata: { summary: 'fbw stocks: create report' } });
    const taskId = created.data?.data?.taskId;
    if (!taskId) throw new Error('warehouse_remains: no taskId in response');

    // Отчёт готовится до ~1-2 мин; poll каждые 10с, максимум 150с.
    let ready = false;
    for (let i = 0; i < 15; i++) {
        await sleep(10000);
        const st = await client.get(`${base}/tasks/${taskId}/status`, { metadata: { summary: `fbw stocks: status ${i + 1}` } });
        const status = st.data?.data?.status;
        if (status === 'done') { ready = true; break; }
        if (status === 'error' || status === 'canceled') throw new Error(`warehouse_remains: status=${status}`);
    }
    if (!ready) throw new Error('warehouse_remains: report not ready in 150s');

    const dl = await client.get(`${base}/tasks/${taskId}/download`, { metadata: { summary: 'fbw stocks: download' } });
    const rows = Array.isArray(dl.data) ? dl.data : [];
    const map = new Map();
    for (const r of rows) {
        const nm = r.nmId;
        if (nm == null) continue;
        // groupByNm=true: одна строка на nmId, quantityWarehousesFull — суммарный остаток на складах WB
        const qty = Math.max(0, r.quantityWarehousesFull || 0);
        map.set(nm, (map.get(nm) || 0) + qty);
    }
    return map;
}

// Парсинг чисел WB (могут приходить строкой с запятой-разделителем: "0,5", "46")
function parseNum(v) {
    if (v == null) return 0;
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v).replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
}

// Комиссии по категориям: Map subjectID -> { fbo, fbs } (проценты КВВ).
async function fetchCommissions(apiKey, storeId) {
    const client = createWbClient(apiKey, { source: 'repricer', storeId });
    const url = `${WB_HOSTS.common}/api/v1/tariffs/commission?locale=ru`;
    const resp = await client.get(url, { metadata: { summary: 'commissions' } });
    const report = resp.data?.report || [];
    const map = new Map();
    for (const r of report) {
        if (r.subjectID != null) {
            map.set(r.subjectID, { fbo: parseNum(r.kgvpMarketplace), fbs: parseNum(r.kgvpSupplier) });
        }
    }
    return map;
}

// Тариф логистики короба: { base (за первый литр), liter (за доп. литр) }.
// Берём типовой склад (Коледино) либо медиану по складам — для оценки floor.
async function fetchBoxTariffs(apiKey, storeId, date) {
    const client = createWbClient(apiKey, { source: 'repricer', storeId });
    const d = date || new Date().toISOString().slice(0, 10);
    const url = `${WB_HOSTS.common}/api/v1/tariffs/box?date=${d}`;
    const resp = await client.get(url, { metadata: { summary: 'box tariffs' } });
    const list = resp.data?.response?.data?.warehouseList || [];
    const parsed = list
        .map(w => ({ name: w.warehouseName, base: parseNum(w.boxDeliveryBase), liter: parseNum(w.boxDeliveryLiter) }))
        .filter(w => w.base > 0);
    if (parsed.length === 0) return { base: 0, liter: 0 };
    const koledino = parsed.find(w => /коледино/i.test(w.name || ''));
    if (koledino) return { base: koledino.base, liter: koledino.liter };
    // медиана base/liter
    const med = (arr) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
    return { base: med(parsed.map(w => w.base)), liter: med(parsed.map(w => w.liter)) };
}

// Список акций WB в окне дат. Возвращает [{ id, name, startDateTime, endDateTime }].
async function fetchPromotions(apiKey, storeId, startISO, endISO) {
    const client = createWbClient(apiKey, { source: 'promo_exit', storeId });
    const url = `${WB_HOSTS.calendar}/api/v1/calendar/promotions?startDateTime=${encodeURIComponent(startISO)}&endDateTime=${encodeURIComponent(endISO)}&allPromo=false`;
    const resp = await client.get(url, { metadata: { summary: 'promotions list' } });
    const promos = resp.data?.data?.promotions || [];
    return promos.map(p => ({ id: p.id, name: p.name, startDateTime: p.startDateTime, endDateTime: p.endDateTime }));
}

// Участвующие в акции номенклатуры. Возвращает [{ nmID, planPrice, planDiscount }].
async function fetchPromoNomenclatures(apiKey, storeId, promoId) {
    const client = createWbClient(apiKey, { source: 'promo_exit', storeId });
    const LIMIT = 1000;
    const out = [];
    let offset = 0;
    while (true) {
        const url = `${WB_HOSTS.calendar}/api/v1/calendar/promotions/nomenclatures`
            + `?promotionID=${promoId}&inAction=true&limitNomenclature=${LIMIT}&offsetNomenclature=${offset}`;
        const resp = await client.get(url, { metadata: { summary: `promo ${promoId} nomenclatures offset=${offset}` } });
        const noms = resp.data?.data?.nomenclatures || [];
        for (const n of noms) {
            out.push({ nmID: n.id ?? n.nmID, planPrice: n.planPrice ?? null, planDiscount: n.planDiscount ?? null });
        }
        if (noms.length < LIMIT) break;
        offset += LIMIT;
    }
    return out;
}

async function syncStore(storeId) {
    console.log(`[WB] Starting sync for Store ID: ${storeId}`);
    let logId;

    const log = async (level, stage, msg) => {
        if (logId) await db.addLogEntry(logId, level, stage, msg);
        console.log(`[WB][${stage}] ${msg}`);
        Sentry.addBreadcrumb({ category: 'sync', level: level === 'ERROR' ? 'error' : 'info', message: `${stage}: ${msg}`, data: { storeId, logId } });
    };

    try {
        logId = await db.createLog(storeId);
        await log('INFO', 'INIT', `WB sync started for Store ID ${storeId}`);

        const store = await db.getStoreById(storeId);
        if (!store) throw new Error('Store not found');
        const apiKey = store.wb_api_key;
        if (!apiKey) throw new Error('WB API key not set');

        // 1. Карточки
        await log('INFO', 'FETCH_CARDS', 'Fetching product cards...');
        const cards = await fetchCards(apiKey, storeId);
        await log('INFO', 'FETCH_CARDS', `Found ${cards.length} cards.`);

        // 2. Цены
        await log('INFO', 'FETCH_PRICES', 'Fetching prices...');
        let priceMap = new Map();
        try {
            priceMap = await fetchPrices(apiKey, storeId);
            await log('INFO', 'FETCH_PRICES', `Got prices for ${priceMap.size} items.`);
        } catch (e) {
            await log('ERROR', 'FETCH_PRICES', `Failed to fetch prices: ${e.message}`);
        }

        // 3. Сохранение товаров + истории цен — одной транзакцией (быстро, без гонки за WAL-локом)
        await log('INFO', 'SAVE_DB', `Saving ${cards.length} products...`);
        const items = cards.map(c => {
            const price = priceMap.get(c.nmID) || {};
            const discountedPrice = price.discountedPrice ?? null;
            const p = {
                product_id: c.nmID,           // → ozon_id
                offer_id: c.vendorCode,       // → offer_id (артикул продавца)
                name: c.name,
                primary_image: c.image,       // превью для UI
                price: discountedPrice,       // цена продавца (после своей скидки)
                marketing_price: discountedPrice,
                min_price: null,
                currency_code: 'RUB',
                wb_price_base: price.priceBase ?? null,
                wb_discount: price.discount ?? null,
                wb_subject_id: c.subjectId ?? null,
            };
            return {
                product_id: c.nmID, offer_id: c.vendorCode, name: c.name, dataJson: JSON.stringify(p),
                price: discountedPrice, marketing_price: discountedPrice, min_price: 0,
                wb_subject_id: c.subjectId ?? null, wb_volume_liters: c.volumeLiters ?? null,
                wb_price_base: price.priceBase ?? null, wb_discount: price.discount ?? null,
            };
        });
        const itemsChanged = db.saveWbProductsBatch(storeId, items);
        await log('INFO', 'SAVE_DB', `Saved. ${itemsChanged} price changes detected.`);

        // 3b. Карантин: помечаем товары, у которых WB не применил цену (резкое снижение)
        await log('INFO', 'FETCH_QUARANTINE', 'Checking price quarantine...');
        try {
            const qSet = await withTimeout(fetchQuarantine(apiKey, storeId), 45000, 'quarantine');
            const now_iso = new Date().toISOString();
            db.setWbQuarantineBatch(storeId, cards.map(c => c.nmID), qSet, now_iso);
            if (qSet.size > 0) {
                await log('WARNING', 'FETCH_QUARANTINE', `В карантине ${qSet.size} товаров — новая цена не применена (резкое снижение). Снижайте ступенчато / подтвердите в кабинете WB.`);
            } else {
                await log('INFO', 'FETCH_QUARANTINE', 'Карантин пуст.');
            }
        } catch (qErr) {
            await log('ERROR', 'FETCH_QUARANTINE', `Не удалось проверить карантин: ${qErr.message}`);
        }

        // 4. Остатки FBW (некритично)
        await log('INFO', 'FETCH_STOCKS', 'Fetching FBW stocks...');
        try {
            // warehouse_remains — асинхронный отчёт WB, готовится до ~2 мин
            const stockMap = await withTimeout(fetchStocks(apiKey, storeId), 200000, 'stocks');
            const updates = [];
            for (const c of cards) {
                updates.push({ ozon_id: c.nmID, stocks_fbo: stockMap.get(c.nmID) || 0, stocks_fbs: 0 });
            }
            if (updates.length > 0) await db.updateProductStocks(storeId, updates);
            const total = updates.reduce((a, u) => a + u.stocks_fbo, 0);
            await log('INFO', 'FETCH_STOCKS', `FBW остатки обновлены, суммарно=${total}`);
        } catch (stockErr) {
            await log('ERROR', 'FETCH_STOCKS', `Failed to fetch stocks: ${stockErr.message}`);
        }

        await db.updateStoreTimestamp(storeId);
        await db.updateLog(logId, { status: 'SUCCESS', items_processed: cards.length, items_changed: itemsChanged, completed: true, log_text: 'WB sync completed' });
        await log('INFO', 'FINISH', 'WB sync completed successfully.');
        return { success: true, count: cards.length };
    } catch (error) {
        console.error(`[WB] Sync failed for Store ${storeId}:`, error.message);
        Sentry.withScope(scope => {
            scope.setTag('operation', 'syncStore');
            scope.setTag('store_id', storeId);
            scope.setTag('platform', 'wildberries');
            Sentry.captureException(error);
        });
        if (logId) {
            await log('ERROR', 'Run', `Failed: ${error.message}`);
            await db.updateLog(logId, { status: 'ERROR', log_text: error.message, completed: true });
        }
        return { success: false, error: error.message };
    }
}

async function syncProduct(storeId, nmID) {
    try {
        const store = await db.getStoreById(storeId);
        if (!store) throw new Error('Store not found');
        const apiKey = store.wb_api_key;

        const priceMap = await fetchPrices(apiKey, storeId);
        const price = priceMap.get(Number(nmID)) || {};
        // Имя/субъект из БД (карточку точечно не перезапрашиваем)
        const p = {
            product_id: Number(nmID),
            offer_id: undefined,
            name: undefined,
            price: price.discountedPrice ?? null,
            marketing_price: price.discountedPrice ?? null,
            currency_code: 'RUB',
        };
        const dbProductId = await db.saveProduct(storeId, p);
        await db.savePrice(dbProductId, p);
        await db.saveWbProductMeta(storeId, Number(nmID), { priceBase: price.priceBase ?? null, discount: price.discount ?? null });
        return { success: true, product: p };
    } catch (error) {
        console.error(`[WB] Single sync failed for Store ${storeId}, nm ${nmID}:`, error.message);
        return { success: false, error: error.message };
    }
}

/**
 * Отправка цен WB. Принимает массив пар { nmID, price, discount } (price — базовая, discount — % продавца).
 * Применение асинхронное: WB возвращает taskId, фактический статус — через verifyPriceTasks / quarantine.
 * Для совместимости с роутом manual: если item.nmID отсутствует, берём numeric offer_id; discount обязателен.
 */
async function updateProductPrices(apiKey, updates, storeId, source = 'sync') {
    const client = createWbClient(apiKey, { source, storeId });
    const url = `${WB_HOSTS.prices}/api/v2/upload/task`;
    const BATCH = 1000;

    // Нормализация входа в WB-формат
    const data = [];
    for (const u of updates) {
        const nmID = Number(u.nmID ?? u.ozon_id ?? u.offer_id);
        const price = Math.round(Number(u.price));
        const discount = u.discount != null ? Math.round(Number(u.discount)) : null;
        if (!Number.isFinite(nmID) || !Number.isFinite(price) || discount == null) {
            console.warn(`[WB] skip invalid price update:`, JSON.stringify(u));
            continue;
        }
        data.push({ nmID, price, discount });
    }
    if (data.length === 0) return { success: false, error: 'no valid updates', _itemErrors: [] };

    const taskIds = [];
    const itemErrors = [];
    for (let i = 0; i < data.length; i += BATCH) {
        const batch = data.slice(i, i + BATCH);
        try {
            const resp = await client.post(url, { data: batch }, {
                metadata: { itemsCount: batch.length, summary: `upload ${batch.length} prices (${source})` }
            });
            if (resp.data?.error) {
                itemErrors.push({ batch: i / BATCH, error: resp.data.errorText || 'unknown' });
                console.warn(`[WB] price upload batch error: ${resp.data.errorText}`);
            } else {
                const taskId = resp.data?.data?.id;
                if (taskId) taskIds.push(taskId);
            }
        } catch (error) {
            const body = error.response?.data ? JSON.stringify(error.response.data).slice(0, 400) : error.message;
            itemErrors.push({ batch: i / BATCH, error: body });
            console.error(`[WB] price upload failed:`, body);
        }
        if (i + BATCH < data.length) await sleep(700);
    }

    return { success: itemErrors.length === 0, taskIds, _itemErrors: itemErrors };
}

/**
 * Продажи по SKU/день для стратегий (РФ2). Источник — statistics /api/v1/supplier/sales:
 * по записи на каждую реализацию (выкуп). supplierArticle = vendorCode = offer_id.
 * priceWithDisc = наша discountedPrice (цена продавца, которую оптимизируем),
 * finishedPrice = цена покупателя (с СПП), spp = размер СПП.
 * Возвраты (saleID начинается с 'R') не считаем как продажу.
 * Возвращает [{ offer_id, date, units, revenue, price_seller, price_buyer_est, spp_pct }].
 */
async function fetchSales(store, fromDate, toDate) {
    const apiKey = store.wb_api_key;
    const client = createWbClient(apiKey, { source: 'sales', storeId: store.id });
    const url = `${WB_HOSTS.statistics}/api/v1/supplier/sales?dateFrom=${fromDate}&flag=0`;
    const resp = await client.get(url, { metadata: { summary: `sales from ${fromDate}` } });
    const rows = resp.data || [];

    // Агрегируем по (offer_id, date)
    const agg = new Map(); // key = offer_id|date
    const toEnd = toDate; // YYYY-MM-DD; включаем по конец окна
    for (const r of rows) {
        if (!r.supplierArticle || !r.date) continue;
        const date = String(r.date).slice(0, 10);
        if (date > toEnd) continue;
        const isReturn = String(r.saleID || '').startsWith('R');
        const sign = isReturn ? -1 : 1;
        const key = `${r.supplierArticle}|${date}`;
        let a = agg.get(key);
        if (!a) { a = { offer_id: r.supplierArticle, date, units: 0, revenue: 0, _sumSeller: 0, _sumBuyer: 0, _sumSpp: 0, _n: 0 }; agg.set(key, a); }
        a.units += sign;
        a.revenue += sign * (r.priceWithDisc || 0);
        if (!isReturn) {
            a._sumSeller += (r.priceWithDisc || 0);
            a._sumBuyer += (r.finishedPrice != null ? r.finishedPrice : (r.priceWithDisc || 0));
            a._sumSpp += (r.spp || 0);
            a._n += 1;
        }
    }
    const out = [];
    for (const a of agg.values()) {
        out.push({
            offer_id: a.offer_id, date: a.date, units: a.units, revenue: Math.round(a.revenue),
            price_seller: a._n ? Math.round(a._sumSeller / a._n) : null,
            price_buyer_est: a._n ? Math.round(a._sumBuyer / a._n) : null,
            spp_pct: a._n ? Math.round(a._sumSpp / a._n) : null,
        });
    }
    return out;
}

module.exports = {
    syncStore, syncProduct, updateProductPrices,
    fetchCards, fetchPrices, fetchStocks,
    fetchCommissions, fetchBoxTariffs,
    fetchPromotions, fetchPromoNomenclatures,
    fetchQuarantine, fetchSales,
};
