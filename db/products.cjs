const { db, dbRun, dbGet, dbAll } = require('./connection.cjs');

async function saveProduct(storeId, ozonProduct) {
    const sql = `INSERT INTO products (store_id, ozon_id, offer_id, name, data_json, updated_at)
                 VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(store_id, ozon_id) DO UPDATE SET
                 name = excluded.name,
                 offer_id = excluded.offer_id,
                 data_json = excluded.data_json,
                 updated_at = CURRENT_TIMESTAMP`;
    const params = [storeId, ozonProduct.product_id, ozonProduct.offer_id, ozonProduct.name, JSON.stringify(ozonProduct)];
    await dbRun(db, sql, params);

    const row = await dbGet(db, "SELECT id FROM products WHERE store_id = ? AND ozon_id = ?", [storeId, ozonProduct.product_id]);
    return row ? row.id : null;
}

async function savePrice(dbProductId, priceData) {
    const lastRow = await dbGet(db, "SELECT * FROM price_history WHERE product_id = ? ORDER BY id DESC LIMIT 1", [dbProductId]);

    const newPrice = parseFloat(priceData.price || 0);
    const newMarketing = parseFloat(priceData.marketing_price || 0);
    const newMin = parseFloat(priceData.min_price || 0);

    if (lastRow) {
        const oldPrice = parseFloat(lastRow.price || 0);
        const oldMarketing = parseFloat(lastRow.marketing_price || 0);
        const oldMin = parseFloat(lastRow.min_price || 0);

        if (oldPrice === newPrice && oldMarketing === newMarketing && oldMin === newMin) {
            return;
        }
    }

    await dbRun(db,
        `INSERT INTO price_history (product_id, price, marketing_price, min_price, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [dbProductId, newPrice, newMarketing, newMin]
    );
}

async function getStoreProducts(storeId) {
    const rows = await dbAll(db, `
        SELECT p.*, COALESCE(sd.sales_30d, 0) AS sales_30d
        FROM products p
        LEFT JOIN (SELECT offer_id, SUM(units) sales_30d FROM sales_daily
                   WHERE store_id = ? AND date >= date('now', '-30 days') GROUP BY offer_id) sd
        ON sd.offer_id = p.offer_id
        WHERE p.store_id = ?`, [storeId, storeId]);
    return rows.map(r => {
        let d = {};
        try { d = JSON.parse(r.data_json); } catch { }
        d.id = r.id;               // PK строки products (для FK price_updates_pending.product_id)
        d.sales_30d = r.sales_30d;
        d.ref_price = r.ref_price;
        d.ref_min_price = r.ref_min_price;
        d.cost_price = r.cost_price;
        d.floor_min_price = r.floor_min_price;
        d.visibility = r.visibility;
        d.is_quarantine = r.is_quarantine;
        d.is_archived = r.is_archived;
        d.price_apply_status = r.price_apply_status;
        d.price_apply_error = r.price_apply_error;
        d.in_promo = r.in_promo;
        d.promo_price = r.promo_price;
        d.promo_action_id = r.promo_action_id;
        d.has_price = r.has_price;
        d.has_stock = r.has_stock;
        d.ozon_status = r.ozon_status;
        d.moderate_status = r.moderate_status;
        d.ozon_is_created = r.ozon_is_created;
        d.last_status_check = r.last_status_check;
        d.stocks_fbo = r.stocks_fbo;
        d.stocks_fbs = r.stocks_fbs;
        d.stocks_updated_at = r.stocks_updated_at;
        d.wb_price_base = r.wb_price_base;
        d.wb_discount = r.wb_discount;
        d.wb_subject_id = r.wb_subject_id;
        d.wb_volume_liters = r.wb_volume_liters;
        d.strategy_type = r.strategy_type;
        d.in_experiment = r.in_experiment;
        return d;
    });
}

function addRange(where, params, sqlExpr, min, max) {
    if (min !== undefined) { where += ` AND ${sqlExpr} >= ?`; params.push(min); }
    if (max !== undefined) { where += ` AND ${sqlExpr} <= ?`; params.push(max); }
    return where;
}

async function getStoreProductsPaginated(storeId, { page = 1, pageSize = 20, sort, search, filter, numericFilters } = {}) {
    let where = 'WHERE p.store_id = ?';
    let params = [storeId];

    if (search) {
        where += ' AND (p.name LIKE ? OR p.offer_id LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }

    if (filter === 'on_sale') { where += " AND p.visibility = 'VISIBLE' AND p.is_archived = 0"; }
    else if (filter === 'ready') { where += " AND p.visibility = 'INVISIBLE' AND p.ozon_is_created = 1 AND p.has_stock = 0 AND p.is_quarantine = 0 AND p.is_archived = 0"; }
    else if (filter === 'errors') { where += ' AND p.is_quarantine = 1 AND p.is_archived = 0'; }
    else if (filter === 'needs_work') { where += " AND p.visibility = 'INVISIBLE' AND p.ozon_is_created = 0 AND p.is_quarantine = 0 AND p.is_archived = 0"; }
    else if (filter === 'removed') { where += " AND p.visibility = 'INVISIBLE' AND p.ozon_is_created = 1 AND p.has_stock = 1 AND p.is_quarantine = 0 AND p.is_archived = 0"; }
    else if (filter === 'can_improve') { where += " AND p.moderate_status = 'can_improve' AND p.is_archived = 0"; }
    else if (filter === 'archived') { where += ' AND p.is_archived = 1'; }
    else if (filter === 'promo') { where += ' AND p.in_promo = 1 AND p.is_archived = 0'; }
    else if (filter === 'below_ref') { where += " AND p.ref_price > 0 AND (p.in_promo = 0 OR p.in_promo IS NULL) AND CAST(json_extract(p.data_json, '$.price') AS REAL) < p.ref_price AND p.is_archived = 0"; }
    else if (filter === 'price_rejected') { where += " AND p.price_apply_status = 'REJECTED' AND p.is_archived = 0"; }
    else if (filter === 'has_fbo') { where += ' AND p.stocks_fbo > 0 AND p.is_archived = 0'; }
    else if (filter === 'has_fbs') { where += ' AND p.stocks_fbs > 0 AND p.is_archived = 0'; }
    else if (filter === 'no_cost') { where += " AND p.visibility = 'VISIBLE' AND p.is_archived = 0 AND (p.cost_price IS NULL OR p.cost_price = 0)"; }
    else if (filter === 'no_data') { where += " AND p.visibility = 'VISIBLE' AND p.is_archived = 0 AND (p.ref_price IS NULL OR p.ref_price = 0)"; }
    else { where += ' AND p.is_archived = 0'; } // "all" — exclude archived by default

    if (numericFilters) {
        const nf = numericFilters;
        where = addRange(where, params, 'COALESCE(sd.sales_30d, 0)', nf.sales_30d_min, nf.sales_30d_max);
        where = addRange(where, params, 'COALESCE(p.stocks_fbo, 0)', nf.stocks_fbo_min, nf.stocks_fbo_max);
        where = addRange(where, params, 'COALESCE(p.stocks_fbs, 0)', nf.stocks_fbs_min, nf.stocks_fbs_max);
        where = addRange(where, params, 'COALESCE(p.cost_price, 0)', nf.cost_price_min, nf.cost_price_max);
        where = addRange(where, params, "COALESCE(CAST(json_extract(p.data_json, '$.price') AS REAL), 0)", nf.price_min, nf.price_max);
    }

    const salesJoin = `LEFT JOIN (SELECT offer_id, SUM(units) sales_30d FROM sales_daily
                            WHERE store_id = ? AND date >= date('now', '-30 days') GROUP BY offer_id) sd
                        ON sd.offer_id = p.offer_id`;

    // Count total (джойн на sales_daily нужен и здесь — where может ссылаться на sd.sales_30d)
    const countSql = `SELECT COUNT(*) as total FROM products p ${salesJoin} ${where}`;
    const countRow = await dbGet(db, countSql, [storeId, ...params]);
    const total = countRow.total;

    // Sort
    let orderBy = 'ORDER BY p.id DESC';
    if (sort) {
        const [field, dir] = sort.split(':');
        const allowedFields = ['name', 'offer_id', 'price', 'marketing_price', 'min_price', 'old_price', 'cost_price', 'stocks_fbo', 'stocks_fbs', 'risk', 'sales_30d'];
        const allowedDirs = ['asc', 'desc'];
        if (allowedFields.includes(field) && allowedDirs.includes(dir)) {
            if (['price', 'marketing_price', 'min_price', 'old_price'].includes(field)) {
                orderBy = `ORDER BY CAST(json_extract(p.data_json, '$.${field}') AS REAL) ${dir}`;
            } else if (field === 'sales_30d') {
                orderBy = `ORDER BY COALESCE(sd.sales_30d, 0) ${dir}`;
            } else if (field === 'risk') {
                // Риск-скор: убыточные сверху (x10), потом провал от эталона.
                // effective_price = marketing_price если >0, иначе price.
                const effective = `COALESCE(NULLIF(CAST(json_extract(p.data_json, '$.marketing_price') AS REAL), 0), CAST(json_extract(p.data_json, '$.price') AS REAL))`;
                const score = `(
                    CASE
                        WHEN p.cost_price IS NOT NULL AND p.cost_price > 0 AND ${effective} < p.cost_price
                            THEN 1000 + ((p.cost_price - ${effective}) * 100.0 / p.cost_price)
                        WHEN p.ref_price IS NOT NULL AND p.ref_price > 0 AND ${effective} < p.ref_price * 0.9
                            THEN ((p.ref_price - ${effective}) * 100.0 / p.ref_price)
                        ELSE 0
                    END
                )`;
                orderBy = `ORDER BY ${score} ${dir}`;
            } else if (field === 'cost_price' || field === 'stocks_fbo' || field === 'stocks_fbs') {
                orderBy = `ORDER BY p.${field} ${dir}`;
            } else {
                orderBy = `ORDER BY p.${field} ${dir}`;
            }
        }
    }

    const offset = (page - 1) * pageSize;
    const dataSql = `SELECT p.*, COALESCE(sd.sales_30d, 0) AS sales_30d FROM products p ${salesJoin} ${where} ${orderBy} LIMIT ? OFFSET ?`;
    const rows = await dbAll(db, dataSql, [storeId, ...params, pageSize, offset]);

    const items = rows.map(r => {
        let d = {};
        try { d = JSON.parse(r.data_json); } catch {}
        d.sales_30d = r.sales_30d;
        d.ref_price = r.ref_price;
        d.ref_min_price = r.ref_min_price;
        d.cost_price = r.cost_price;
        d.floor_min_price = r.floor_min_price;
        d.visibility = r.visibility;
        d.is_quarantine = r.is_quarantine;
        d.is_archived = r.is_archived;
        d.price_apply_status = r.price_apply_status;
        d.price_apply_error = r.price_apply_error;
        d.in_promo = r.in_promo;
        d.promo_price = r.promo_price;
        d.promo_action_id = r.promo_action_id;
        d.has_price = r.has_price;
        d.has_stock = r.has_stock;
        d.ozon_is_created = r.ozon_is_created;
        d.last_status_check = r.last_status_check;
        d.stocks_fbo = r.stocks_fbo;
        d.stocks_fbs = r.stocks_fbs;
        d.stocks_updated_at = r.stocks_updated_at;
        return d;
    });

    return { items, total, page, pageSize };
}

function updateProductRefPrice(storeId, offerId, refPrice, refMinPrice) {
    return dbRun(db, `UPDATE products SET ref_price = ?, ref_min_price = ? WHERE store_id = ? AND offer_id = ?`,
        [refPrice, refMinPrice, storeId, offerId]);
}

function updateProductCostPrice(storeId, offerId, costPrice) {
    // cost_price is a product property, not store-specific — update across all stores
    return dbRun(db, `UPDATE products SET cost_price = ? WHERE offer_id = ?`,
        [costPrice, offerId]);
}

function updateProductFloorPrice(storeId, offerId, floorMinPrice) {
    return dbRun(db, `UPDATE products SET floor_min_price = ? WHERE store_id = ? AND offer_id = ?`,
        [floorMinPrice, storeId, offerId]);
}

function updateProductLocalPrice(storeId, offerId, price, minPrice, oldPrice) {
    return dbRun(db, `
        UPDATE products SET data_json = json_set(
            json_set(
                json_set(
                    json_set(COALESCE(data_json, '{}'),
                        '$.price', CAST(? AS TEXT)),
                    '$.marketing_price', CAST(? AS TEXT)),
                '$.marketing_seller_price', CAST(? AS TEXT)),
            '$.min_price', CAST(? AS TEXT),
            '$.old_price', CAST(? AS TEXT)
        )
        WHERE store_id = ? AND offer_id = ?
    `, [price, price, price, minPrice || price, oldPrice || 0, storeId, offerId]);
}

function updateProductStatus(storeId, ozonId, { visibility, is_quarantine, is_archived, has_price, has_stock, ozon_status, moderate_status, ozon_is_created, in_promo, promo_price, promo_action_id, last_status_check }) {
    const setClauses = [];
    const params = [];

    if (visibility !== undefined) { setClauses.push('visibility = ?'); params.push(visibility); }
    if (is_quarantine !== undefined) { setClauses.push('is_quarantine = ?'); params.push(is_quarantine); }
    if (is_archived !== undefined) { setClauses.push('is_archived = ?'); params.push(is_archived); }
    if (has_price !== undefined) { setClauses.push('has_price = ?'); params.push(has_price); }
    if (has_stock !== undefined) { setClauses.push('has_stock = ?'); params.push(has_stock); }
    if (ozon_status !== undefined) { setClauses.push('ozon_status = ?'); params.push(ozon_status); }
    if (moderate_status !== undefined) { setClauses.push('moderate_status = ?'); params.push(moderate_status); }
    if (ozon_is_created !== undefined) { setClauses.push('ozon_is_created = ?'); params.push(ozon_is_created); }
    if (in_promo !== undefined) { setClauses.push('in_promo = ?'); params.push(in_promo); }
    if (promo_price !== undefined) { setClauses.push('promo_price = ?'); params.push(promo_price); }
    if (promo_action_id !== undefined) { setClauses.push('promo_action_id = ?'); params.push(promo_action_id); }
    if (last_status_check !== undefined) { setClauses.push('last_status_check = ?'); params.push(last_status_check); }

    if (setClauses.length === 0) return Promise.resolve();

    params.push(storeId, ozonId);
    return dbRun(db,
        `UPDATE products SET ${setClauses.join(', ')} WHERE store_id = ? AND ozon_id = ?`,
        params
    );
}

function resetStorePromo(storeId) {
    return dbRun(db, "UPDATE products SET in_promo = 0, promo_price = NULL, promo_action_id = NULL WHERE store_id = ? AND in_promo = 1", [storeId]);
}

function resetStoreVisibility(storeId) {
    return dbRun(db, "UPDATE products SET visibility = NULL WHERE store_id = ?", [storeId]);
}

function resetStoreQuarantine(storeId) {
    return dbRun(db, "UPDATE products SET is_quarantine = 0 WHERE store_id = ?", [storeId]);
}

function resetStoreModerateStatus(storeId) {
    return dbRun(db, "UPDATE products SET moderate_status = NULL WHERE store_id = ?", [storeId]);
}

// Батчевое сохранение товаров WB одной транзакцией better-sqlite3 (быстро, без гонки за WAL-локом).
// items: [{ product_id(nmID), offer_id, name, dataJson(строка), price, marketing_price, min_price,
//           wb_subject_id, wb_volume_liters, wb_price_base, wb_discount }]
// Возвращает число изменившихся цен.
function saveWbProductsBatch(storeId, items) {
    if (!items || items.length === 0) return 0;
    const upsert = db.prepare(`INSERT INTO products (store_id, ozon_id, offer_id, name, data_json, updated_at)
        VALUES (@store_id, @ozon_id, @offer_id, @name, @data_json, CURRENT_TIMESTAMP)
        ON CONFLICT(store_id, ozon_id) DO UPDATE SET
          name = excluded.name, offer_id = excluded.offer_id,
          data_json = excluded.data_json, updated_at = CURRENT_TIMESTAMP`);
    const getId = db.prepare("SELECT id FROM products WHERE store_id = ? AND ozon_id = ?");
    const lastPrice = db.prepare("SELECT price, marketing_price, min_price FROM price_history WHERE product_id = ? ORDER BY id DESC LIMIT 1");
    const insPrice = db.prepare("INSERT INTO price_history (product_id, price, marketing_price, min_price, created_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)");
    const updMeta = db.prepare(`UPDATE products SET wb_subject_id = @wb_subject_id, wb_volume_liters = @wb_volume_liters,
          wb_price_base = @wb_price_base, wb_discount = @wb_discount WHERE store_id = @store_id AND ozon_id = @ozon_id`);

    let changed = 0;
    const tx = db.transaction((rows) => {
        for (const it of rows) {
            upsert.run({ store_id: storeId, ozon_id: it.product_id, offer_id: it.offer_id ?? null, name: it.name ?? null, data_json: it.dataJson });
            const row = getId.get(storeId, it.product_id);
            if (!row) continue;
            const pid = row.id;
            const np = parseFloat(it.price || 0), nm = parseFloat(it.marketing_price || 0), nmin = parseFloat(it.min_price || 0);
            const last = lastPrice.get(pid);
            if (!last || parseFloat(last.price || 0) !== np || parseFloat(last.marketing_price || 0) !== nm || parseFloat(last.min_price || 0) !== nmin) {
                insPrice.run(pid, np, nm, nmin);
                if (last) changed++;
            }
            updMeta.run({ store_id: storeId, ozon_id: it.product_id,
                wb_subject_id: it.wb_subject_id ?? null, wb_volume_liters: it.wb_volume_liters ?? null,
                wb_price_base: it.wb_price_base ?? null, wb_discount: it.wb_discount ?? null });
        }
    });
    tx(items);
    return changed;
}

// Батчевая установка флага карантина для WB одной транзакцией.
function setWbQuarantineBatch(storeId, nmIds, quarantinedSet, nowIso) {
    if (!nmIds || nmIds.length === 0) return;
    const stmt = db.prepare("UPDATE products SET is_quarantine = ?, last_status_check = ? WHERE store_id = ? AND ozon_id = ?");
    const tx = db.transaction((ids) => {
        for (const nm of ids) stmt.run(quarantinedSet.has(nm) ? 1 : 0, nowIso, storeId, nm);
    });
    tx(nmIds);
}

// Сохранить WB-специфичные поля товара (subjectID, объём, текущая пара цена/скидка).
// nmID хранится в products.ozon_id.
function saveWbProductMeta(storeId, nmID, { subjectId, volumeLiters, priceBase, discount }) {
    const setClauses = [];
    const params = [];
    if (subjectId !== undefined) { setClauses.push('wb_subject_id = ?'); params.push(subjectId); }
    if (volumeLiters !== undefined) { setClauses.push('wb_volume_liters = ?'); params.push(volumeLiters); }
    if (priceBase !== undefined) { setClauses.push('wb_price_base = ?'); params.push(priceBase); }
    if (discount !== undefined) { setClauses.push('wb_discount = ?'); params.push(discount); }
    if (setClauses.length === 0) return Promise.resolve();
    params.push(storeId, nmID);
    return dbRun(db, `UPDATE products SET ${setClauses.join(', ')} WHERE store_id = ? AND ozon_id = ?`, params);
}

async function getStoreProductIds(storeId) {
    const rows = await dbAll(db, "SELECT ozon_id FROM products WHERE store_id = ?", [storeId]);
    return rows.map(r => r.ozon_id);
}

function getPromoProducts(storeId) {
    return dbAll(db, `SELECT ozon_id, offer_id, name, promo_price, promo_action_id, cost_price, floor_min_price, ref_price
        FROM products WHERE store_id = ? AND in_promo = 1 AND promo_action_id IS NOT NULL`, [storeId]);
}

function updateProductStocks(storeId, updates) {
    // updates: [{ ozon_id, stocks_fbo, stocks_fbs }, ...]
    if (!updates || updates.length === 0) return Promise.resolve();
    try {
        const stmt = db.prepare(
            "UPDATE products SET stocks_fbo = ?, stocks_fbs = ?, stocks_updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND ozon_id = ?"
        );
        const tx = db.transaction((rows) => {
            for (const u of rows) {
                stmt.run(u.stocks_fbo | 0, u.stocks_fbs | 0, storeId, u.ozon_id);
            }
        });
        tx(updates);
        return Promise.resolve();
    } catch (err) {
        return Promise.reject(err);
    }
}

function getCrossStoreProducts(offerId) {
    const sql = `
        SELECT p.offer_id, p.store_id, s.name as store_name,
               json_extract(p.data_json, '$.price') as price,
               p.cost_price,
               json_extract(p.data_json, '$.marketing_price') as marketing_price,
               p.management_mode, p.managed_by
        FROM products p
        JOIN stores s ON p.store_id = s.id
        WHERE p.offer_id = ?
    `;
    return dbAll(db, sql, [offerId]);
}

// Снять промо-флаги у конкретных товаров (после подтверждённого deactivate)
async function clearPromoFlags(storeId, ozonIds) {
    if (!ozonIds || ozonIds.length === 0) return;
    const CHUNK = 500;
    for (let i = 0; i < ozonIds.length; i += CHUNK) {
        const chunk = ozonIds.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        await dbRun(db,
            `UPDATE products SET in_promo = 0, promo_price = NULL, promo_action_id = NULL
             WHERE store_id = ? AND ozon_id IN (${placeholders})`,
            [storeId, ...chunk]);
    }
}

// Товары без установленного самозапрета автодобавления в акции
function getUnblockedProducts(storeId, limit = 500) {
    return dbAll(db,
        `SELECT offer_id FROM products
         WHERE store_id = ? AND auto_add_blocked = 0 AND is_archived = 0 AND offer_id IS NOT NULL AND offer_id != ''
         LIMIT ?`,
        [storeId, limit]);
}

async function markAutoAddBlocked(storeId, offerIds, blocked = 1) {
    if (!offerIds || offerIds.length === 0) return;
    const CHUNK = 500;
    for (let i = 0; i < offerIds.length; i += CHUNK) {
        const chunk = offerIds.slice(i, i + CHUNK);
        const placeholders = chunk.map(() => '?').join(',');
        await dbRun(db,
            `UPDATE products SET auto_add_blocked = ? WHERE store_id = ? AND offer_id IN (${placeholders})`,
            [blocked ? 1 : 0, storeId, ...chunk]);
    }
}

module.exports = {
    saveProduct, savePrice, getStoreProducts, getStoreProductsPaginated,
    updateProductRefPrice, updateProductCostPrice, updateProductLocalPrice, updateProductFloorPrice,
    updateProductStatus, resetStorePromo, resetStoreVisibility, resetStoreQuarantine, resetStoreModerateStatus,
    getStoreProductIds, getPromoProducts, getCrossStoreProducts, updateProductStocks,
    clearPromoFlags, getUnblockedProducts, markAutoAddBlocked,
    saveWbProductMeta, saveWbProductsBatch, setWbQuarantineBatch,
};
