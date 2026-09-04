/**
 * Governance — «одно поле знаний» для нескольких ЛЛМ/агентов, работающих через репрайсер.
 *
 * Слои (см. docs/API_EXTERNAL.md):
 *  1. Контекст с версией: GET /context отдаёт context_version; каждая запись цен обязана
 *     передать версию, с которой агент принимал решение. Версия устарела → 409 + свежий контекст.
 *  2. Владение SKU: products.management_mode + managed_by. Цену пишет только владелец режима.
 *  3. Журнал решений/намерений: agent_decisions (kind: decision | intent | policy).
 *  4. Рельсы (policy engine): лимит изменения цены/день, floor, лимит массовости.
 *
 * Любое решение/смена режима инкрементирует context_version (app_settings).
 */
const { db } = require('./connection.cjs');
const { getAppSetting, setAppSetting } = require('./strategies.cjs');

// ── Версия контекста ──────────────────────────────────────────────
function getContextVersion() {
    return parseInt(getAppSetting('context_version', '1'), 10) || 1;
}
function bumpContextVersion() {
    const v = getContextVersion() + 1;
    setAppSetting('context_version', String(v));
    return v;
}

// ── Политики (рельсы + расчётные правила) ─────────────────────────
const POLICY_DEFAULTS = {
    policy_price_change_max_pct: '15',   // максимум изменения цены за одну запись, % от текущего эталона
    policy_mass_change_limit: '200',     // больше SKU за один запрос — требуется confirm_mass:true
    policy_coinvest_share_ozon: '0.49',  // доля соинвеста Ozon в начислениях — замерьте по своему отчёту реализации
    policy_require_floor: 'true',        // запись цены для SKU без известного floor отклоняется
};
function getPolicies() {
    return {
        price_change_max_pct: parseFloat(getAppSetting('policy_price_change_max_pct', POLICY_DEFAULTS.policy_price_change_max_pct)),
        mass_change_limit: parseInt(getAppSetting('policy_mass_change_limit', POLICY_DEFAULTS.policy_mass_change_limit), 10),
        coinvest_share_ozon: parseFloat(getAppSetting('policy_coinvest_share_ozon', POLICY_DEFAULTS.policy_coinvest_share_ozon)),
        require_floor: getAppSetting('policy_require_floor', POLICY_DEFAULTS.policy_require_floor) !== 'false',
        coinvest: 'Соинвест Ozon (bonus в отчёте реализации) НЕ облагается налогом и НЕ является поводом поднимать цены: он уже включён в начисления. Прибыль НЕ считать самостоятельно — читать GET /stores/:id/pnl.',
        tax: 'Налоговая база — только деньги покупателей (выручка минус соинвест). Ставка — stores.tax_rate.',
    };
}

// ── Журнал решений ────────────────────────────────────────────────
function addDecision({ author, kind = 'decision', title, body = null, store_id = null, skus = null, active_until = null }) {
    if (!author || !title) throw new Error('author and title are required');
    if (!['decision', 'intent', 'policy'].includes(kind)) throw new Error('kind must be decision|intent|policy');
    const r = db.prepare(`INSERT INTO agent_decisions (author, kind, title, body, store_id, skus_json, active_until)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(author, kind, title, body, store_id, skus ? JSON.stringify(skus) : null, active_until);
    const version = bumpContextVersion();
    return { id: r.lastInsertRowid, context_version: version };
}
function listDecisions({ status = 'active', limit = 100 } = {}) {
    // scope: store_id задан → решение про конкретный магазин; NULL → про все магазины.
    const base = `SELECT d.*, s.name store_name, s.platform store_platform
        FROM agent_decisions d LEFT JOIN stores s ON s.id = d.store_id`;
    const rows = status
        ? db.prepare(`${base} WHERE d.status = ? ORDER BY d.id DESC LIMIT ?`).all(status, limit)
        : db.prepare(`${base} ORDER BY d.id DESC LIMIT ?`).all(limit);
    return rows.map((r) => ({
        ...r,
        skus: r.skus_json ? JSON.parse(r.skus_json) : null,
        skus_json: undefined,
        scope: r.store_id ? `${r.store_platform}:${r.store_name}` : 'все магазины',
    }));
}
function closeDecision(id, status = 'done') {
    const r = db.prepare('UPDATE agent_decisions SET status = ? WHERE id = ?').run(status, id);
    if (r.changes > 0) bumpContextVersion();
    return r.changes;
}

// ── Владение SKU ──────────────────────────────────────────────────
const MODES = ['ref_price', 'experiment', 'liquidation', 'disposal'];
function setManagementMode(storeId, offerIds, mode, managedBy, reason = null) {
    if (!MODES.includes(mode)) throw new Error(`mode must be one of: ${MODES.join(', ')}`);
    const stmt = db.prepare('UPDATE products SET management_mode = ?, managed_by = ?, freeze_reason = ? WHERE store_id = ? AND offer_id = ?');
    let changed = 0;
    for (const offerId of offerIds) changed += stmt.run(mode, managedBy, reason, storeId, offerId).changes;
    if (changed > 0) bumpContextVersion();
    return changed;
}
function getManagedSkus(storeId = null) {
    const sql = `SELECT p.store_id, s.name store_name, s.platform, p.offer_id, p.management_mode, p.managed_by, p.freeze_reason, p.ref_price
        FROM products p JOIN stores s ON s.id = p.store_id
        WHERE p.management_mode IS NOT NULL AND p.management_mode != 'ref_price'` + (storeId ? ' AND p.store_id = ?' : '');
    return storeId ? db.prepare(sql).all(storeId) : db.prepare(sql).all();
}

// ── Контекст целиком ──────────────────────────────────────────────
function getContext() {
    const skuStates = {};
    for (const r of getManagedSkus()) {
        const key = `${r.platform}:${r.store_name}:${r.offer_id}`;
        skuStates[key] = { store_id: r.store_id, offer_id: r.offer_id, mode: r.management_mode, owner: r.managed_by, reason: r.freeze_reason, hold_price: r.ref_price };
    }
    return {
        context_version: getContextVersion(),
        policies: getPolicies(),
        managed_sku_count: Object.keys(skuStates).length,
        sku_states: skuStates,
        active_decisions: listDecisions({ status: 'active' }),
        acks: db.prepare('SELECT agent, context_version, acked_at FROM agent_acks ORDER BY acked_at DESC').all(),
        contract: 'Перед действиями: GET /context. Каждый POST /stores/:id/prices обязан содержать context_version и agent (имя агента). Устаревшая версия → 409 с этим же контекстом. SKU в режиме disposal неизменяемы; experiment/liquidation меняет только владелец (managed_by). Прибыль не считать самим — GET /stores/:id/pnl.',
    };
}

/**
 * Валидация записи цен (слои 1, 2, 4).
 * @returns {{ ok: boolean, error?: {status:number, code:string, message:string, context?:object},
 *             accepted: any[], rejected: {offer_id:string, code:string, reason:string}[] }}
 */
function validatePriceUpdates(store, updates, { agent, contextVersion, confirmMass = false } = {}) {
    const policies = getPolicies();
    // Слой 1: версия контекста
    const current = getContextVersion();
    if (contextVersion == null) {
        return { ok: false, error: { status: 428, code: 'context_version_required', message: 'Передайте context_version из GET /context — записи без версии контекста запрещены.' }, accepted: [], rejected: [] };
    }
    if (parseInt(contextVersion, 10) !== current) {
        // Раньше здесь возвращался весь контекст целиком. На каталоге с сотнями
        // управляемых SKU это десятки тысяч токенов на каждую коллизию версий,
        // притом что изменилось, как правило, одно решение. Отдаём то, что
        // изменилось; полный контекст агент возьмёт из GET /context, если нужен.
        return {
            ok: false,
            error: {
                status: 409, code: 'context_stale',
                message: `Контекст устарел (ваша версия ${contextVersion}, текущая ${current}). Изменения — в changed; при необходимости перечитайте GET /context.`,
                current_version: current,
                your_version: parseInt(contextVersion, 10) || null,
                changed: getContextChanges(),
            },
            accepted: [], rejected: [],
        };
    }
    if (!agent) {
        return { ok: false, error: { status: 400, code: 'agent_required', message: 'Укажите agent — имя агента (пишется в аудит и владение).' }, accepted: [], rejected: [] };
    }
    // Слой 4: лимит массовости
    if (updates.length > policies.mass_change_limit && !confirmMass) {
        return { ok: false, error: { status: 400, code: 'mass_change_confirm_required', message: `Изменение ${updates.length} SKU превышает лимит ${policies.mass_change_limit}. Повторите с confirm_mass:true, если это осознанно.` }, accepted: [], rejected: [] };
    }
    // Слои 2 и 4: пер-SKU
    const rows = db.prepare('SELECT offer_id, management_mode, managed_by, freeze_reason, ref_price, floor_min_price FROM products WHERE store_id = ?').all(store.id);
    const byOffer = new Map(rows.map((p) => [p.offer_id, p]));
    const accepted = [], rejected = [];
    for (const u of updates) {
        const p = byOffer.get(u.offer_id);
        const price = parseFloat(u.price) || 0;
        if (!p) { rejected.push({ offer_id: u.offer_id, code: 'unknown_offer', reason: 'Товар не найден в магазине' }); continue; }
        const mode = p.management_mode || 'ref_price';
        if (mode === 'disposal') {
            rejected.push({ offer_id: u.offer_id, code: 'sku_disposal', reason: `SKU в утилизации (${p.freeze_reason || 'без причины'}) — цена заморожена` });
            continue;
        }
        if ((mode === 'experiment' || mode === 'liquidation') && p.managed_by && p.managed_by !== agent && agent !== 'user') {
            rejected.push({ offer_id: u.offer_id, code: 'sku_owned', reason: `SKU в режиме ${mode}, владелец ${p.managed_by} — чужая запись запрещена` });
            continue;
        }
        // Рельса: максимум изменения за запись (от текущего эталона; liquidation освобождён — слив сознательно резкий)
        const base = parseFloat(p.ref_price) || 0;
        if (mode !== 'liquidation' && base > 0 && Math.abs(price - base) / base * 100 > policies.price_change_max_pct) {
            rejected.push({ offer_id: u.offer_id, code: 'price_jump', reason: `Изменение ${(Math.abs(price - base) / base * 100).toFixed(1)}% > лимита ${policies.price_change_max_pct}% (эталон ${base}). Меняйте ступенчато или поднимите policy_price_change_max_pct.` });
            continue;
        }
        // Рельса: floor (liquidation освобождён — слив сознательно уходит ниже)
        const floor = parseFloat(p.floor_min_price) || 0;
        if (mode !== 'liquidation') {
            if (floor > 0 && price < floor) {
                rejected.push({ offer_id: u.offer_id, code: 'below_floor', reason: `Цена ${price} ниже floor ${floor}` });
                continue;
            }
            // Товар без себестоимости не имеет floor, и проверка выше молча пропускала
            // любую цену — самый дешёвый способ уйти в минус. Требуем floor явно.
            if (floor <= 0 && policies.require_floor) {
                rejected.push({ offer_id: u.offer_id, code: 'no_floor', reason: `Для ${u.offer_id} не рассчитан floor (нет себестоимости). Заполните cost_price или отключите policy_require_floor.` });
                continue;
            }
        }
        accepted.push(u);
    }
    return { ok: true, accepted, rejected };
}

/**
 * Что изменилось, если контекст агента устарел: активные решения и SKU,
 * тронутые недавно. Заведомо дешевле полного контекста и в подавляющем
 * большинстве случаев отвечает на вопрос «что я пропустил».
 */
function getContextChanges(limit = 20) {
    const decisions = db.prepare(
        `SELECT id, author, kind, title, store_id, created_at
         FROM agent_decisions
         WHERE status = 'active'
         ORDER BY id DESC LIMIT ?`).all(limit);

    const skus = db.prepare(
        `SELECT p.offer_id, p.management_mode, p.managed_by, s.name AS store, s.platform
         FROM products p JOIN stores s ON s.id = p.store_id
         WHERE p.management_mode IS NOT NULL AND p.management_mode != 'ref_price'
         ORDER BY p.updated_at DESC LIMIT ?`).all(limit);

    return { active_decisions: decisions, managed_sku: skus };
}

// ── Брифинг («ознакомься») и подтверждения ────────────────────────
function ackBriefing(agent) {
    if (!agent) throw new Error('agent is required');
    const version = getContextVersion();
    db.prepare(`INSERT INTO agent_acks (agent, context_version, acked_at) VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(agent) DO UPDATE SET context_version = excluded.context_version, acked_at = CURRENT_TIMESTAMP`)
        .run(agent, version);
    return { agent, context_version: version };
}
function listAcks() {
    const current = getContextVersion();
    return db.prepare('SELECT agent, context_version, acked_at FROM agent_acks ORDER BY acked_at DESC').all()
        .map((a) => ({ ...a, up_to_date: a.context_version === current }));
}

/** Живой брифинг в markdown — собирается из журнала решений и состояния SKU. */
function getBriefing() {
    const version = getContextVersion();
    const policies = getPolicies();
    const decisions = listDecisions({ status: 'active' });
    const managed = getManagedSkus();
    const byMode = {};
    for (const m of managed) {
        const k = `${m.platform}:${m.store_name}`;
        (byMode[m.management_mode] = byMode[m.management_mode] || {})[k] = ((byMode[m.management_mode] || {})[k] || 0) + 1;
    }
    const lines = [];
    lines.push(`# Брифинг проекта (context_version: ${version})`);
    lines.push('');
    lines.push('Ты — один из НЕСКОЛЬКИХ агентов, работающих с этим репрайсером. Ниже — общее поле знаний.');
    lines.push('Прочитай целиком, затем подтверди ознакомление: `POST /briefing/ack {"agent":"<твоё имя>"}`.');
    lines.push('');
    lines.push('## Активные решения и политики (свежие сверху)');
    lines.push('У каждого решения есть ОХВАТ: конкретный магазин или «все магазины». Решение про один магазин НЕ переносить на другие.');
    for (const d of decisions) {
        lines.push(`- **[${d.kind}] ${d.title}** — охват: ${d.scope} (${d.author}, ${d.created_at})`);
        if (d.body) lines.push(`  ${d.body}`);
    }
    lines.push('');
    lines.push('## SKU под управлением (их цены НЕ трогать без владельца)');
    lines.push('ВАЖНО: товары одинаковые во всех магазинах, но режим у каждого магазина СВОЙ.');
    lines.push('Один и тот же offer_id может быть под сливом/утилизацией в одном магазине и обычным прибыльным товаром в других — смотри режим строго по паре (магазин, offer_id), не переноси вывод на другие магазины.');
    for (const [mode, stores] of Object.entries(byMode)) {
        lines.push(`- \`${mode}\`: ${Object.entries(stores).map(([s, n]) => `${s} — ${n} SKU`).join('; ')}`);
    }
    lines.push('  Полный список — GET /context (sku_states).');
    lines.push('');
    lines.push('## Правила записи цен');
    lines.push(`- Каждый POST /stores/:id/prices: \`agent\` + \`context_version\` (текущая: ${version}). Устарела → 409 со свежим контекстом.`);
    lines.push(`- Лимиты: изменение ≤${policies.price_change_max_pct}% за раз; не ниже floor; >${policies.mass_change_limit} SKU только с confirm_mass:true.`);
    lines.push(`- ${policies.coinvest}`);
    lines.push(`- ${policies.tax}`);
    lines.push('- Крупные намерения объявляй заранее: POST /decisions {kind:"intent", ...}.');
    return lines.join('\n');
}

module.exports = {
    getContextChanges,
    getContextVersion, bumpContextVersion, getPolicies, getContext,
    addDecision, listDecisions, closeDecision,
    setManagementMode, getManagedSkus, validatePriceUpdates,
    getBriefing, ackBriefing, listAcks,
};
