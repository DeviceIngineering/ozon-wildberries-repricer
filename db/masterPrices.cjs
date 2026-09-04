const { db, dbRun, dbGet, dbAll } = require('./connection.cjs');

// Условие валидной группы: артикул задан и не пустой (пустые/NULL не группируем — см. критику плана).
const VALID_OFFER = `p.offer_id IS NOT NULL AND TRIM(p.offer_id) != ''`;

/**
 * Список изделий, сгруппированных по offer_id, со строками по каждому магазину.
 * Один агрегирующий запрос (json_group_array) — без N+1.
 * Мастер-цена = эталон группы (MAX(ref_price); в норме един по группе).
 */
async function getMasterPriceGroups({ page = 1, pageSize = 20, search = '' } = {}) {
    const p = Math.max(1, parseInt(page, 10) || 1);
    const ps = Math.min(200, Math.max(1, parseInt(pageSize, 10) || 20));
    const offset = (p - 1) * ps;

    const where = [VALID_OFFER];
    const params = [];
    const searchTrim = (search || '').trim();
    if (searchTrim) {
        where.push(`(p.offer_id LIKE ? OR p.name LIKE ?)`);
        params.push(`%${searchTrim}%`, `%${searchTrim}%`);
    }
    const whereSql = where.join(' AND ');

    const totalRow = await dbGet(db,
        `SELECT COUNT(*) AS n FROM (SELECT 1 FROM products p WHERE ${whereSql} GROUP BY p.offer_id)`,
        params);
    const total = totalRow ? totalRow.n : 0;

    const rows = await dbAll(db, `
        SELECT
            p.offer_id AS offer_id,
            MAX(p.name) AS name,
            MAX(p.cost_price) AS cost_price,
            MAX(p.ref_price) AS master_price,
            COUNT(*) AS stores_count,
            MAX(p.updated_at) AS updated_at,
            json_group_array(json_object(
                'store_id', p.store_id,
                'store_name', s.name,
                'platform', s.platform,
                'ozon_id', p.ozon_id,
                'ref_price', p.ref_price,
                'ref_min_price', p.ref_min_price,
                'cost_price', p.cost_price,
                'wb_discount', p.wb_discount,
                'wb_price_base', p.wb_price_base,
                'stocks_fbo', p.stocks_fbo,
                'is_archived', p.is_archived,
                'price', json_extract(p.data_json, '$.price'),
                'marketing_price', json_extract(p.data_json, '$.marketing_price'),
                'old_price', json_extract(p.data_json, '$.old_price'),
                'image', json_extract(p.data_json, '$.primary_image')
            )) AS stores_json
        FROM products p
        JOIN stores s ON s.id = p.store_id
        WHERE ${whereSql}
        GROUP BY p.offer_id
        ORDER BY MAX(p.updated_at) DESC
        LIMIT ? OFFSET ?
    `, [...params, ps, offset]);

    const items = rows.map((r) => {
        let stores = [];
        try { stores = JSON.parse(r.stores_json) || []; } catch { stores = []; }
        // Картинку берём из первой строки, где она есть.
        const image = stores.map((x) => x.image).find((x) => x && x !== '0') || null;
        return {
            offer_id: r.offer_id,
            name: r.name,
            image,
            cost_price: r.cost_price,
            master_price: r.master_price,
            stores_count: r.stores_count,
            updated_at: r.updated_at,
            stores,
        };
    });

    return { items, total, page: p, pageSize: ps };
}

/**
 * Строки products одного изделия по всем магазинам (для предпросмотра/отправки).
 * Включает платформу и креды магазина для маршрутизации отправки.
 */
function getGroupProducts(offerId) {
    return dbAll(db, `
        SELECT
            p.id, p.store_id, p.ozon_id, p.offer_id, p.name,
            p.ref_price, p.ref_min_price, p.cost_price, p.floor_min_price,
            p.wb_discount, p.wb_price_base, p.is_archived, p.is_quarantine, p.has_price,
            json_extract(p.data_json, '$.price') AS price,
            json_extract(p.data_json, '$.old_price') AS old_price,
            s.name AS store_name, s.platform AS platform,
            s.client_id, s.api_key, s.wb_api_key
        FROM products p
        JOIN stores s ON s.id = p.store_id
        WHERE p.offer_id = ?
    `, [offerId]);
}

/**
 * Записать мастер-цену (эталон) во ВСЕ магазины группы (свойство изделия, как cost_price).
 * Возвращает число затронутых строк.
 */
// Мастер-цена применяется ТОЛЬКО к магазинам в обычном режиме (governance):
// один и тот же товар может быть под сливом/утилизацией в одном магазине и
// прибыльным в других — управляемые (experiment/liquidation/disposal) не трогаем.
async function setMasterPrice(offerId, masterPrice) {
    const res = await dbRun(db,
        `UPDATE products SET ref_price = ? WHERE offer_id = ?
         AND (management_mode IS NULL OR management_mode = 'ref_price')`,
        [masterPrice, offerId]);
    return res && typeof res.changes === 'number' ? res.changes : 0;
}

// Магазины изделия, пропущенные мастер-ценой (управляемые режимы) — для отчёта в UI/API.
function getManagedStoresForOffer(offerId) {
    return db.prepare(`SELECT p.store_id, s.name store_name, s.platform, p.management_mode, p.managed_by, p.freeze_reason
        FROM products p JOIN stores s ON s.id = p.store_id
        WHERE p.offer_id = ? AND p.management_mode IS NOT NULL AND p.management_mode != 'ref_price'`).all(offerId);
}

module.exports = { getMasterPriceGroups, getGroupProducts, setMasterPrice, getManagedStoresForOffer };
