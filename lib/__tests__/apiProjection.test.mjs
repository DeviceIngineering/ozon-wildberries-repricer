import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
    PRODUCT_PRICING_FIELDS, STORE_AGENT_FIELDS,
    parseFields, project, compact, shape, omit,
} = require('../apiProjection.cjs');

const rows = [
    { offer_id: 'SKU-1', price: '100', ref_price: 120, cost_price: 40, promo_price: null, name: 'Товар' },
    { offer_id: 'SKU-2', price: '200', ref_price: 210, cost_price: null, promo_price: 180, name: 'Другой' },
];

describe('parseFields', () => {
    it('без параметра возвращает null — полный ответ сохраняется', () => {
        expect(parseFields(undefined, ['a', 'b'], ['a'])).toBeNull();
        expect(parseFields('', ['a', 'b'], ['a'])).toBeNull();
    });

    it('"default" даёт набор по умолчанию', () => {
        expect(parseFields('default', ['a', 'b'], ['a', 'b'])).toEqual(['a', 'b']);
    });

    it('берёт только известные поля', () => {
        expect(parseFields('a,zzz,b', ['a', 'b'], ['a'])).toEqual(['a', 'b']);
    });

    it('игнорирует пробелы вокруг имён', () => {
        expect(parseFields(' a , b ', ['a', 'b'], ['a'])).toEqual(['a', 'b']);
    });

    it('если ни одно поле не распознано — отдаёт набор по умолчанию, а не пустоту', () => {
        expect(parseFields('нет,таких', ['a', 'b'], ['a'])).toEqual(['a']);
    });
});

describe('project', () => {
    it('оставляет только запрошенные поля', () => {
        const out = project(rows, ['offer_id', 'price']);
        expect(Object.keys(out[0])).toEqual(['offer_id', 'price']);
    });

    it('выбрасывает null и undefined — за них платят токенами впустую', () => {
        const out = project(rows, ['offer_id', 'cost_price', 'promo_price']);
        expect(out[0]).toEqual({ offer_id: 'SKU-1', cost_price: 40 });   // promo_price null
        expect(out[1]).toEqual({ offer_id: 'SKU-2', promo_price: 180 }); // cost_price null
    });

    it('без списка полей ничего не меняет', () => {
        expect(project(rows, null)).toBe(rows);
    });
});

describe('compact', () => {
    it('выносит имена колонок из строк', () => {
        const out = compact(rows, ['offer_id', 'price']);
        expect(out.cols).toEqual(['offer_id', 'price']);
        expect(out.rows).toEqual([['SKU-1', '100'], ['SKU-2', '200']]);
    });

    it('сохраняет null: позиция в строке несёт смысл', () => {
        const out = compact(rows, ['offer_id', 'cost_price']);
        expect(out.rows[1]).toEqual(['SKU-2', null]);
    });

    it('на пустом списке отдаёт пустые колонки, а не падает', () => {
        expect(compact([], null)).toEqual({ cols: [], rows: [] });
    });
});

describe('shape', () => {
    it('по умолчанию — прежний формат объектов', () => {
        const { payload, format } = shape(rows, {});
        expect(format).toBe('objects');
        expect(payload).toBe(rows);
    });

    it('compact применяется поверх выбора полей', () => {
        const { payload } = shape(rows, { fields: ['offer_id', 'price'], format: 'compact' });
        expect(payload.cols).toEqual(['offer_id', 'price']);
        expect(payload.rows[0]).toEqual(['SKU-1', '100']);
    });
});

describe('omit', () => {
    it('убирает перечисленные ключи', () => {
        const out = omit([{ a: 1, store_id: 'uuid', b: 2 }], ['store_id']);
        expect(out[0]).toEqual({ a: 1, b: 2 });
    });
});

describe('экономия на реальной форме ответа', () => {
    // Приближение к строке товара из /products: 31 поле, часть всегда пуста.
    const product = {
        offer_id: 'DEMO-0001', product_id: 900000001, name: 'Органайзер настольный, белый',
        price: '922', marketing_price: '881', min_price: '507', old_price: '1295',
        currency_code: 'RUB', commission_percent: 15, logistics_amount: 43, acquiring_amount: 23,
        sales_30d: 31, ref_price: 920, ref_min_price: null, cost_price: 360, floor_min_price: 619,
        visibility: 'VISIBLE', is_quarantine: 0, is_archived: 0,
        price_apply_status: 'APPLIED', price_apply_error: null,
        in_promo: 0, promo_price: null, promo_action_id: null,
        has_price: 1, has_stock: 1, ozon_is_created: 1, last_status_check: null,
        stocks_fbo: 106, stocks_fbs: 4, stocks_updated_at: '2026-09-04 10:00:00',
        management_mode: 'ref_price', managed_by: null, strategy_type: 'ref_price', in_experiment: 0,
    };
    const many = Array.from({ length: 100 }, () => product);
    const size = (v) => JSON.stringify(v).length;

    it('выбор полей сокращает ответ более чем вдвое', () => {
        const full = size(many);
        const picked = size(project(many, PRODUCT_PRICING_FIELDS));
        expect(picked).toBeLessThan(full * 0.5);
    });

    it('компактный формат сокращает ответ более чем вчетверо', () => {
        const full = size(many);
        const { payload } = shape(many, { fields: PRODUCT_PRICING_FIELDS, format: 'compact' });
        expect(size(payload)).toBeLessThan(full * 0.25);
    });

    it('компактный формат не теряет данные — строка восстанавливается по колонкам', () => {
        const { payload } = shape([product], { fields: PRODUCT_PRICING_FIELDS, format: 'compact' });
        const restored = Object.fromEntries(payload.cols.map((c, i) => [c, payload.rows[0][i]]));
        expect(restored.offer_id).toBe('DEMO-0001');
        expect(restored.floor_min_price).toBe(619);
        expect(restored.management_mode).toBe('ref_price');
    });

    it('набор по умолчанию содержит всё, что нужно для решения о цене', () => {
        for (const f of ['offer_id', 'price', 'ref_price', 'cost_price', 'floor_min_price', 'management_mode']) {
            expect(PRODUCT_PRICING_FIELDS).toContain(f);
        }
    });

    it('в наборе полей магазина нет секретов', () => {
        for (const f of ['api_key', 'client_id', 'wb_api_key', 'ym_api_key']) {
            expect(STORE_AGENT_FIELDS).not.toContain(f);
        }
    });
});
