const { db, dbGet, dbAll } = require('./connection.cjs');

// Поддерживаемые периоды агрегации
const PERIODS = { '24h': '-24 hours', '7d': '-7 days', '30d': '-30 days' };
function periodClause(p) { return PERIODS[p] || PERIODS['7d']; }

// Стадии sync_log_entries, считающиеся опасностью (лента «Опасность»)
const DANGER_STAGES = [
    'WB_BAD_REF', 'OZON_PROMO_BELOW_FLOOR', 'YM_SOLD_BELOW_FLOOR', 'YM_FLOOR_BREACH',
    'YM_BOOST_HEAVY', 'YM_FLOOR_ANOMALY', 'CRITICAL_DROP', 'REPRICER_CRASH',
    'FLOOR_SEND_FAIL', 'YM_FLOOR_SEND_FAIL', 'WB_REPRICE_ERRORS', 'PROMO_BLOCK',
    'REPRICER_SEND_FAIL', 'YM_BESTSELLER_FAIL', 'YM_ORDERS_CHECK_FAIL',
];

// Стадии сводок выхода из акций по площадкам
const PROMO_SUMMARY_STAGES = "('PROMO_EXIT_SUMMARY', 'WB_PROMO_EXIT_SUMMARY')";

function safeParse(json) {
    try { return JSON.parse(json); } catch { return null; }
}

// Унификация сводки выхода из акций (Ozon и WB пишут разные поля)
function normalizePromoSummary(obj, platform) {
    if (!obj) return null;
    if (platform === 'wildberries') {
        return {
            active: Number(obj.promos) || 0,
            participating: Number(obj.participating) || 0,
            exited: Number(obj.restored) || 0,           // восстановлено к РРЦ = вывод
            failed: (Number(obj.errors) || 0) + (Number(obj.no_ref) || 0),
            errors: Number(obj.errors) || 0,
        };
    }
    // ozon / yandex (PROMO_EXIT_SUMMARY)
    return {
        active: Number(obj.actions) || 0,
        frozen: Number(obj.frozen) || 0,
        participating: undefined,
        exited: (Number(obj.removed) || 0),
        failed: (Number(obj.rejected) || 0) + (Number(obj.errors) || 0),
        rejected: Number(obj.rejected) || 0,
        errors: Number(obj.errors) || 0,
    };
}

// Последняя сводка указанной стадии для магазина
async function latestStageSummary(storeId, stages) {
    const placeholders = stages.map(() => '?').join(',');
    const row = await dbGet(db, `
        SELECT e.message, e.timestamp, e.stage
        FROM sync_log_entries e
        JOIN sync_logs l ON e.log_id = l.id
        WHERE l.store_id = ? AND e.stage IN (${placeholders})
        ORDER BY e.timestamp DESC LIMIT 1
    `, [storeId, ...stages]);
    if (!row) return null;
    return { ...row, data: safeParse(row.message) };
}

// Счётчики по товарам (с учётом площадки)
async function productCounts(storeId) {
    return dbGet(db, `
        SELECT
            COUNT(*) as product_count,
            SUM(CASE WHEN is_quarantine = 1 THEN 1 ELSE 0 END) as quarantine_count,
            SUM(CASE WHEN is_archived = 1 THEN 1 ELSE 0 END) as archived_count,
            SUM(CASE WHEN price_apply_status = 'REJECTED' THEN 1 ELSE 0 END) as price_rejected_count,
            SUM(CASE WHEN in_promo = 1 AND promo_price IS NOT NULL AND cost_price IS NOT NULL AND promo_price < cost_price THEN 1 ELSE 0 END) as promo_below_cost_count,
            SUM(CASE WHEN visibility != 'VISIBLE' AND is_quarantine = 0 AND is_archived = 0 THEN 1 ELSE 0 END) as invisible_count,
            SUM(CASE WHEN ref_price IS NOT NULL AND ref_price > 0 THEN 1 ELSE 0 END) as ref_price_count,
            SUM(CASE WHEN in_promo = 1 THEN 1 ELSE 0 END) as promo_count,
            SUM(CASE WHEN cost_price IS NOT NULL AND cost_price > 0 THEN 1 ELSE 0 END) as cost_price_count,
            SUM(CASE WHEN ref_price > 0 AND in_promo = 1
                AND CAST(json_extract(data_json, '$.price') AS REAL) < ref_price
                THEN 1 ELSE 0 END) as below_ref_promo_count,
            SUM(CASE WHEN ref_price > 0 AND (in_promo = 0 OR in_promo IS NULL)
                AND CAST(json_extract(data_json, '$.price') AS REAL) < ref_price
                THEN 1 ELSE 0 END) as below_ref_other_count,
            SUM(CASE WHEN floor_min_price IS NOT NULL AND floor_min_price > 0
                AND CAST(json_extract(data_json, '$.min_price') AS REAL) < floor_min_price
                THEN 1 ELSE 0 END) as below_floor_count
        FROM products WHERE store_id = ?
    `, [storeId]);
}

// Счётчики действий репрайсера за период
async function repricerActions(storeId, since) {
    const rows = await dbAll(db, `
        SELECT action, COUNT(*) as cnt
        FROM repricer_log
        WHERE store_id = ? AND timestamp > datetime('now', ?)
        GROUP BY action
    `, [storeId, since]);
    const out = { corrected: 0, ok: 0, promo_removed: 0, promo_exit_rejected: 0, skipped: 0, total: 0 };
    for (const r of rows) {
        out.total += r.cnt;
        if (r.action === 'corrected') out.corrected += r.cnt;
        else if (r.action === 'ok') out.ok += r.cnt;
        else if (r.action === 'promo_removed') out.promo_removed += r.cnt;
        else if (r.action === 'promo_exit_rejected') out.promo_exit_rejected += r.cnt;
        else if (r.action && r.action.startsWith('skipped')) out.skipped += r.cnt;
    }
    return out;
}

// Агрегация выхода из акций за период (суммируем все прогоны)
async function promoAggregate(storeId, since, platform) {
    const rows = await dbAll(db, `
        SELECT e.message, e.stage
        FROM sync_log_entries e
        JOIN sync_logs l ON e.log_id = l.id
        WHERE l.store_id = ? AND e.stage IN ${PROMO_SUMMARY_STAGES}
          AND e.timestamp > datetime('now', ?)
    `, [storeId, since]);
    const agg = { runs: 0, exited: 0, failed: 0, errors: 0 };
    for (const r of rows) {
        const norm = normalizePromoSummary(safeParse(r.message), platform);
        if (!norm) continue;
        agg.runs++;
        agg.exited += norm.exited || 0;
        agg.failed += norm.failed || 0;
        agg.errors += norm.errors || 0;
    }
    return agg;
}

// Сводные стадии — не опасности, исключаем из ленты (чтобы не показывать сырой JSON)
const SUMMARY_STAGES = ['PROMO_EXIT_SUMMARY', 'WB_PROMO_EXIT_SUMMARY', 'REPRICER_SUMMARY', 'WB_REPRICE_SUMMARY', 'YM_FLOOR_SUMMARY'];

// Лента опасностей: свежие WARNING/ERROR события по площадкам
async function dangerFeed(since, limit = 60) {
    return dbAll(db, `
        SELECT e.timestamp, e.level, e.stage, e.message,
               l.store_id, s.name as store_name, s.platform
        FROM sync_log_entries e
        JOIN sync_logs l ON e.log_id = l.id
        JOIN stores s ON l.store_id = s.id
        WHERE e.timestamp > datetime('now', ?)
          AND e.stage NOT IN (${SUMMARY_STAGES.map(() => '?').join(',')})
          AND (e.level IN ('WARNING', 'ERROR') OR e.stage IN (${DANGER_STAGES.map(() => '?').join(',')}))
        ORDER BY e.timestamp DESC
        LIMIT ?
    `, [since, ...SUMMARY_STAGES, ...DANGER_STAGES, limit]);
}

// Тренд действий репрайсера по дням
async function repricerTrend(since) {
    const rows = await dbAll(db, `
        SELECT date(timestamp) as day, action, COUNT(*) as cnt
        FROM repricer_log
        WHERE timestamp > datetime('now', ?)
        GROUP BY day, action
        ORDER BY day ASC
    `, [since]);
    const byDay = new Map();
    for (const r of rows) {
        if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day, corrected: 0, skipped: 0, promo_removed: 0, ok: 0 });
        const d = byDay.get(r.day);
        if (r.action === 'corrected') d.corrected += r.cnt;
        else if (r.action === 'ok') d.ok += r.cnt;
        else if (r.action === 'promo_removed') d.promo_removed += r.cnt;
        else if (r.action && r.action.startsWith('skipped')) d.skipped += r.cnt;
    }
    return Array.from(byDay.values());
}

// Тренд выхода из акций по дням (успешно/неудачно)
async function promoTrend(since) {
    const rows = await dbAll(db, `
        SELECT date(e.timestamp) as day, e.message, e.stage, s.platform
        FROM sync_log_entries e
        JOIN sync_logs l ON e.log_id = l.id
        JOIN stores s ON l.store_id = s.id
        WHERE e.stage IN ${PROMO_SUMMARY_STAGES} AND e.timestamp > datetime('now', ?)
        ORDER BY day ASC
    `, [since]);
    const byDay = new Map();
    for (const r of rows) {
        const norm = normalizePromoSummary(safeParse(r.message), r.platform);
        if (!norm) continue;
        if (!byDay.has(r.day)) byDay.set(r.day, { day: r.day, exited: 0, failed: 0 });
        const d = byDay.get(r.day);
        d.exited += norm.exited || 0;
        d.failed += norm.failed || 0;
    }
    return Array.from(byDay.values());
}

// ============================================================================
// КОКПИТ РЕШЕНИЙ — задачи, требующие вмешательства человека
// ============================================================================

const PLATFORM_LABEL = { ozon: 'Ozon', yandex: 'Яндекс.Маркет', wildberries: 'Wildberries' };

// Текущая цена товара из data_json
const CUR_PRICE = `CAST(json_extract(data_json, '$.price') AS REAL)`;

// Собираем по всем магазинам строки задач одного типа с разбивкой по магазину
async function collectTask(stores, perStoreFn) {
    const byStore = [];
    let count = 0, risk = 0, example = null;
    for (const store of stores) {
        const r = await perStoreFn(store);
        if (!r || !r.count) continue;
        count += r.count;
        risk += r.risk || 0;
        byStore.push({ store_id: store.id, store_name: store.name, platform: store.platform || 'ozon', count: r.count, risk: r.risk || 0 });
        if (!example && r.example) example = r.example;
    }
    return { count, risk, byStore, example };
}

// Текущая цена с алиасом продукта (для запросов с JOIN на sales_daily, где есть одноимённые колонки)
const CUR_PRICE_P = `CAST(json_extract(p.data_json, '$.price') AS REAL)`;

async function getDecisionCockpit(period = '7d') {
    const since = periodClause(period);
    const stores = await dbAll(db, 'SELECT * FROM stores');
    const tasks = [];

    // Фаза 2: если есть данные о продажах (таблица sales_daily; ингест — зона движка стратегий),
    // money-at-risk = ₽/день (разрыв цены × средние дневные продажи). Иначе — фолбэк на разовый разрыв по SKU.
    // Таблица может отсутствовать (модуль стратегий не задеплоен) — тогда тихо используем фолбэк.
    let useDaily = false;
    try {
        const hasTable = await dbGet(db, `SELECT name FROM sqlite_master WHERE type='table' AND name='sales_daily'`);
        if (hasTable) {
            const salesRow = await dbGet(db, `SELECT COUNT(*) c FROM sales_daily WHERE date >= date('now', '-7 days')`);
            useDaily = (salesRow?.c || 0) > 0;
        }
    } catch { useDaily = false; }
    const riskKindMoney = useDaily ? 'per_day' : 'per_unit';

    // Считает количество и риск задачи для магазина. gapExpr/where — с префиксом p. (продукты алиас p).
    async function moneyRow(store, where, gapExpr) {
        const join = useDaily
            ? `LEFT JOIN (SELECT offer_id, SUM(units)/7.0 du FROM sales_daily
                 WHERE store_id = ? AND date >= date('now','-7 days') AND is_dirty_flag = 0 GROUP BY offer_id) sr
               ON sr.offer_id = p.offer_id`
            : '';
        const riskExpr = useDaily ? `(${gapExpr}) * COALESCE(sr.du, 0)` : `(${gapExpr})`;
        const sql = `SELECT COUNT(*) cnt, COALESCE(SUM(${riskExpr}), 0) risk,
                        MAX(p.offer_id) ex_offer, MAX(p.ref_price) ex_ref, MAX(p.cost_price) ex_cost
                     FROM products p ${join}
                     WHERE p.store_id = ? AND ${where}`;
        const params = useDaily ? [store.id, store.id] : [store.id];
        return dbGet(db, sql, params);
    }

    // 1. РРЦ ниже себестоимости (ошибка данных, автомат пропускает) — danger
    {
        const t = await collectTask(stores, async (s) => {
            const row = await moneyRow(s, `p.ref_price > 0 AND p.cost_price > 0 AND p.ref_price < p.cost_price`, `p.cost_price - p.ref_price`);
            if (!row.cnt) return null;
            return { count: row.cnt, risk: Math.round(row.risk), example: `${row.ex_offer}: РРЦ ${Math.round(row.ex_ref)} < с/с ${Math.round(row.ex_cost)}` };
        });
        if (t.count) tasks.push({
            id: 'bad_ref', severity: 'danger', title: 'РРЦ ниже себестоимости',
            desc: 'Эталонная цена задана ниже себестоимости — товар продаётся в убыток, репрайсер его пропускает. Исправьте эталон в импорте.',
            count: t.count, risk: t.risk, riskKind: riskKindMoney, example: t.example,
            action: { label: 'Исправить эталон', kind: 'import' }, filter: 'bad_ref', byStore: t.byStore,
        });
    }

    // 2. Промо ниже себестоимости — danger
    {
        const t = await collectTask(stores, async (s) => {
            const row = await moneyRow(s, `p.in_promo = 1 AND p.promo_price > 0 AND p.cost_price > 0 AND p.promo_price < p.cost_price`, `p.cost_price - p.promo_price`);
            if (!row.cnt) return null;
            return { count: row.cnt, risk: Math.round(row.risk), example: `${row.ex_offer}` };
        });
        if (t.count) tasks.push({
            id: 'promo_below_cost', severity: 'danger', title: 'Промо ниже себестоимости',
            desc: 'Товары в акции с ценой ниже себестоимости. Уберите из акции в кабинете или повысьте промо-цену.',
            count: t.count, risk: t.risk, riskKind: riskKindMoney, example: t.example,
            action: { label: 'Открыть кабинет', kind: 'cabinet' }, filter: 'promo_below_cost', byStore: t.byStore,
        });
    }

    // 3. Цена ниже пола (безубыточности) — warn
    {
        const t = await collectTask(stores, async (s) => {
            const row = await moneyRow(s, `p.floor_min_price > 0 AND ${CUR_PRICE_P} > 0 AND ${CUR_PRICE_P} < p.floor_min_price`, `p.floor_min_price - ${CUR_PRICE_P}`);
            if (!row.cnt) return null;
            return { count: row.cnt, risk: Math.round(row.risk), example: `${row.ex_offer}` };
        });
        if (t.count) tasks.push({
            id: 'below_floor', severity: 'warn', title: 'Цена ниже пола',
            desc: 'Текущая цена ниже расчётной безубыточности. Репрайсер поднимет при следующем прогоне — проверьте, если держится долго.',
            count: t.count, risk: t.risk, riskKind: riskKindMoney, example: t.example,
            action: { label: 'Запустить репрайсер', kind: 'repricer' }, filter: 'below_floor', byStore: t.byStore,
        });
    }

    // 4. Софинанс Ozon ниже пола (danger, только Ozon).
    // Считаем из СОСТОЯНИЯ товаров (marketing_price < пол при корректной цене продавца),
    // а не из строк лога OZON_PROMO_BELOW_FLOOR — лог пишется на каждый прогон и кратно дублирует SKU.
    {
        const MKT = `CAST(json_extract(p.data_json, '$.marketing_price') AS REAL)`;
        const t = await collectTask(stores, async (s) => {
            if ((s.platform || 'ozon') !== 'ozon') return null;
            const row = await moneyRow(s,
                `p.floor_min_price > 0 AND ${MKT} > 0 AND ${MKT} < p.floor_min_price AND ${CUR_PRICE_P} >= p.floor_min_price`,
                `p.floor_min_price - ${MKT}`);
            if (!row.cnt) return null;
            return { count: row.cnt, risk: Math.round(row.risk), example: `${row.ex_offer}` };
        });
        if (t.count) tasks.push({
            id: 'ozon_cofund', severity: 'danger', title: 'Ozon давит цену ниже пола',
            desc: 'Софинансируемая акция Ozon продаёт ниже безубыточности (marketing_price ниже пола при корректной цене продавца). API не выводит — уберите товар из акции в кабинете вручную.',
            count: t.count, risk: t.risk, riskKind: riskKindMoney, example: t.example,
            action: { label: 'Открыть кабинет Ozon', kind: 'cabinet' }, filter: null, byStore: t.byStore,
        });
    }

    // 5. Цены не применились (отклонены / не подтвердились) — warn
    {
        const t = await collectTask(stores, async (s) => {
            const rej = await dbGet(db, `SELECT COUNT(*) cnt FROM products WHERE store_id = ? AND price_apply_status = 'REJECTED'`, [s.id]);
            const fail = await dbGet(db, `SELECT COUNT(*) cnt FROM price_updates_pending WHERE store_id = ? AND status = 'VERIFIED_FAIL' AND sent_at > datetime('now', '-24 hours')`, [s.id]);
            const cnt = (rej.cnt || 0) + (fail.cnt || 0);
            return cnt ? { count: cnt, risk: 0 } : null;
        });
        if (t.count) tasks.push({
            id: 'not_applied', severity: 'warn', title: 'Цены не применились',
            desc: 'Площадка отклонила цены или они не подтвердились. Возможна проблема аккаунта, лимита или токена.',
            count: t.count, risk: 0, riskKind: null, example: null,
            action: { label: 'Проверить', kind: 'logs' }, filter: 'rejected', byStore: t.byStore,
        });
    }

    // 6. Карантин цены — warn
    {
        const t = await collectTask(stores, async (s) => {
            const row = await dbGet(db, `SELECT COUNT(*) cnt FROM products WHERE store_id = ? AND is_quarantine = 1`, [s.id]);
            return row.cnt ? { count: row.cnt, risk: 0 } : null;
        });
        if (t.count) tasks.push({
            id: 'quarantine', severity: 'warn', title: 'Цены в карантине',
            desc: 'Площадка не применяет цену (аномалия). Подтвердите цену в кабинете.',
            count: t.count, risk: 0, riskKind: null, example: null,
            action: { label: 'Список SKU', kind: 'drill' }, filter: 'quarantine', byStore: t.byStore,
        });
    }

    // 7. Выход из акций не удался (последний прогон) — warn
    {
        const byStore = [];
        let count = 0;
        for (const store of stores) {
            const platform = store.platform || 'ozon';
            const stages = platform === 'wildberries' ? ['WB_PROMO_EXIT_SUMMARY'] : ['PROMO_EXIT_SUMMARY'];
            const raw = await latestStageSummary(store.id, stages);
            const norm = raw ? normalizePromoSummary(raw.data, platform) : null;
            const failed = norm?.failed || 0;
            if (failed > 0) { count += failed; byStore.push({ store_id: store.id, store_name: store.name, platform, count: failed, risk: 0 }); }
        }
        if (count) tasks.push({
            id: 'promo_exit_fail', severity: 'warn', title: 'Выход из акций не удался',
            desc: 'Часть товаров не выведена из акций (отказ площадки). Нужен ручной вывод и самозапрет автоучастия в кабинете.',
            count, risk: 0, riskKind: null, example: null,
            action: { label: 'Ручной вывод', kind: 'cabinet' }, filter: null, byStore,
        });
    }

    // 8. Не указана себестоимость (активные товары) — warn
    {
        const t = await collectTask(stores, async (s) => {
            const row = await dbGet(db, `
                SELECT COUNT(*) cnt FROM products
                WHERE store_id = ? AND visibility = 'VISIBLE' AND is_archived = 0
                  AND (cost_price IS NULL OR cost_price = 0)
            `, [s.id]);
            return row.cnt ? { count: row.cnt, risk: 0 } : null;
        });
        if (t.count) tasks.push({
            id: 'no_cost', severity: 'warn', title: 'Не указана себестоимость',
            desc: 'Товары без себестоимости — репрайсер не видит порога убытка и не защищает их. Дозаполните себестоимость.',
            count: t.count, risk: 0, riskKind: null, example: null,
            action: { label: 'Дозаполнить', kind: 'import' }, filter: 'no_cost', byStore: t.byStore,
        });
    }

    // 9. Нет эталона (РРЦ) у активных товаров — info
    {
        const t = await collectTask(stores, async (s) => {
            const row = await dbGet(db, `
                SELECT COUNT(*) cnt FROM products
                WHERE store_id = ? AND visibility = 'VISIBLE' AND is_archived = 0
                  AND (ref_price IS NULL OR ref_price = 0)
            `, [s.id]);
            return row.cnt ? { count: row.cnt, risk: 0 } : null;
        });
        if (t.count) tasks.push({
            id: 'no_data', severity: 'info', title: 'Нет эталона (РРЦ)',
            desc: 'Товары без РРЦ — репрайсер не знает целевую цену. Дозаполните эталонные цены.',
            count: t.count, risk: 0, riskKind: null, example: null,
            action: { label: 'Дозаполнить', kind: 'import' }, filter: 'no_data', byStore: t.byStore,
        });
    }

    // Ранжирование: severity → деньги → количество
    const sevRank = { danger: 0, warn: 1, info: 2 };
    tasks.sort((a, b) => (sevRank[a.severity] - sevRank[b.severity]) || (b.risk - a.risk) || (b.count - a.count));
    const totalRisk = tasks.reduce((a, t) => a + (t.risk || 0), 0);

    // --- Слой автоматики ---
    const automation = [];
    for (const store of stores) {
        const platform = store.platform || 'ozon';
        const acts = await repricerActions(store.id, since);
        const promo = await promoAggregate(store.id, since, platform);
        // Жёсткие окна 1д/7д для виджетов-переключателей (независимы от общего периода)
        const acts1d = await repricerActions(store.id, PERIODS['24h']);
        const acts7d = await repricerActions(store.id, PERIODS['7d']);
        const promo1d = await promoAggregate(store.id, PERIODS['24h'], platform);
        const promo7d = await promoAggregate(store.id, PERIODS['7d'], platform);
        const held = await dbGet(db, `
            SELECT COUNT(*) cnt FROM products
            WHERE store_id = ? AND ref_price > 0 AND ${CUR_PRICE} >= ref_price
        `, [store.id]);
        automation.push({
            id: store.id, name: store.name, platform,
            repricer_enabled: store.repricer_enabled,
            last_repricer_run: store.last_repricer_run || null,
            promo_exit_enabled: store.promo_exit_enabled || 0,
            held: held.cnt || 0, corrected: acts.corrected || 0, promo_exited: promo.exited || 0,
            corrected_1d: acts1d.corrected || 0, corrected_7d: acts7d.corrected || 0,
            promo_exited_1d: promo1d.exited || 0, promo_exited_7d: promo7d.exited || 0,
        });
    }

    // --- Аналитика для решений ---
    // (а) тренд «деньги под риском»: суммарный per-unit-gap пропусков по дням нет в истории —
    // используем число опасных событий репрайсера по дням как прокси-индикатор
    const lossTrendRows = await dbAll(db, `
        SELECT date(timestamp) day, COUNT(*) cnt
        FROM repricer_log
        WHERE timestamp > datetime('now', ?) AND action IN ('skipped_bad_ref', 'skipped_below_cost', 'skipped_below_floor')
        GROUP BY day ORDER BY day ASC
    `, [since]);

    // (б) маржинальность портфеля: распределение по (цена - пол)/пол
    const marginRow = await dbGet(db, `
        SELECT
          SUM(CASE WHEN ${CUR_PRICE} < floor_min_price THEN 1 ELSE 0 END) loss,
          SUM(CASE WHEN ${CUR_PRICE} >= floor_min_price AND ${CUR_PRICE} < floor_min_price*1.05 THEN 1 ELSE 0 END) b0,
          SUM(CASE WHEN ${CUR_PRICE} >= floor_min_price*1.05 AND ${CUR_PRICE} < floor_min_price*1.15 THEN 1 ELSE 0 END) b5,
          SUM(CASE WHEN ${CUR_PRICE} >= floor_min_price*1.15 AND ${CUR_PRICE} < floor_min_price*1.30 THEN 1 ELSE 0 END) b15,
          SUM(CASE WHEN ${CUR_PRICE} >= floor_min_price*1.30 THEN 1 ELSE 0 END) b30
        FROM products WHERE floor_min_price > 0 AND ${CUR_PRICE} > 0
    `);
    const margin = {
        loss: marginRow?.loss || 0, b0: marginRow?.b0 || 0, b5: marginRow?.b5 || 0,
        b15: marginRow?.b15 || 0, b30: marginRow?.b30 || 0,
    };

    // (в) под чьим контролем цена: РРЦ (не в акции) vs акции
    const ctrlRow = await dbGet(db, `
        SELECT
          SUM(CASE WHEN (in_promo = 0 OR in_promo IS NULL) THEN 1 ELSE 0 END) rrc,
          SUM(CASE WHEN in_promo = 1 THEN 1 ELSE 0 END) promo
        FROM products WHERE visibility = 'VISIBLE' AND is_archived = 0
    `);
    const control = { rrc: ctrlRow?.rrc || 0, promo: ctrlRow?.promo || 0 };

    return {
        period,
        tasks,
        totalRisk,
        moneyKind: riskKindMoney,
        automation,
        analytics: {
            lossTrend: lossTrendRows,
            margin,
            control,
        },
        platformLabels: PLATFORM_LABEL,
    };
}

module.exports = { getDecisionCockpit };
