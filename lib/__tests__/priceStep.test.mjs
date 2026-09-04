import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { capStep, limitsFor, DEFAULT_RAISE_PCT } = require('../priceStep.cjs');

const WB = { platform: 'wildberries' };
const OZON = { platform: 'ozon' };

describe('limitsFor', () => {
    it('порог падения по умолчанию есть только у Wildberries', () => {
        expect(limitsFor(WB).dropRatio).toBe(1.5);
        expect(limitsFor(OZON).dropRatio).toBeNull();
        expect(limitsFor({ platform: 'yandex' }).dropRatio).toBeNull();
    });

    it('настройка магазина перекрывает значение по умолчанию', () => {
        expect(limitsFor({ ...WB, max_drop_ratio: 2 }).dropRatio).toBe(2);
        expect(limitsFor({ ...OZON, max_drop_ratio: 1.8 }).dropRatio).toBe(1.8);
    });

    it('прежнее имя настройки роста продолжает работать', () => {
        expect(limitsFor({ ym_floor_max_raise_percent: 35 }).raisePct).toBe(35);
        // новое имя выигрывает, если заданы оба
        expect(limitsFor({ max_raise_percent: 10, ym_floor_max_raise_percent: 35 }).raisePct).toBe(10);
    });

    it('бессмысленные значения трактуются как «не задано»', () => {
        expect(limitsFor({ ...WB, max_drop_ratio: 1 }).dropRatio).toBeNull();   // «никогда не снижать»
        expect(limitsFor({ ...WB, max_drop_ratio: 0.5 }).dropRatio).toBeNull();
        expect(limitsFor({ max_raise_percent: 0 }).raisePct).toBeNull();
        expect(limitsFor({ max_raise_percent: 'abc' }).raisePct).toBeNull();
    });

    it('пустая строка из формы — это «не задано», а не ноль', () => {
        expect(limitsFor({ ...WB, max_drop_ratio: '' }).dropRatio).toBe(1.5);
        expect(limitsFor({ max_raise_percent: '' }).raisePct).toBe(DEFAULT_RAISE_PCT);
    });
});

describe('capStep — снижение', () => {
    it('умеренное снижение проходит целиком', () => {
        const r = capStep({ current: 1000, target: 800, store: WB });
        expect(r.applied).toBe(800);
        expect(r.capped).toBe(false);
    });

    it('падение ровно на пороге ещё разрешено', () => {
        const r = capStep({ current: 1500, target: 1000, store: WB }); // ровно 1.5×
        expect(r.applied).toBe(1000);
        expect(r.capped).toBe(false);
    });

    it('резкое падение ограничивается и помечается', () => {
        const r = capStep({ current: 1000, target: 400, store: WB });
        expect(r.capped).toBe(true);
        expect(r.applied).toBe(Math.ceil(1000 / 1.45)); // 690
        expect(r.applied).toBeGreaterThan(400);
        expect(r.reason).toContain('карантин');
    });

    it('шаг остаётся чуть выше порога — не садимся на границу', () => {
        const r = capStep({ current: 1000, target: 300, store: WB });
        expect(r.applied / 1000).toBeGreaterThan(1 / 1.5 * 0.999);
    });

    it('до цели доходит за несколько прогонов и не проскакивает её', () => {
        let price = 3000;
        const target = 900;
        const seen = [];
        for (let i = 0; i < 12 && price !== target; i++) {
            const r = capStep({ current: price, target, store: WB });
            price = r.applied;
            seen.push(price);
        }
        expect(price).toBe(target);
        expect(seen.length).toBeLessThanOrEqual(6);
        // монотонно вниз, без колебаний
        for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeLessThan(seen[i - 1]);
    });

    it('без настроенного порога снижение не ограничивается', () => {
        const r = capStep({ current: 1000, target: 100, store: OZON });
        expect(r.applied).toBe(100);
        expect(r.capped).toBe(false);
    });

    it('ограничение включается для любой площадки, если его задали', () => {
        const r = capStep({ current: 1000, target: 100, store: { ...OZON, max_drop_ratio: 1.5 } });
        expect(r.capped).toBe(true);
    });
});

describe('capStep — поднятие', () => {
    it('умеренный рост проходит целиком', () => {
        const r = capStep({ current: 1000, target: 1100, store: OZON });
        expect(r.applied).toBe(1100);
        expect(r.capped).toBe(false);
    });

    it('резкий рост ограничивается процентом за прогон', () => {
        const r = capStep({ current: 1000, target: 2000, store: OZON });
        expect(r.applied).toBe(1200); // +20% по умолчанию
        expect(r.capped).toBe(true);
        expect(r.reason).toContain('20%');
    });

    it('не перескакивает через floor, когда он известен', () => {
        const r = capStep({ current: 1000, target: 2000, store: OZON, floor: 1150 });
        expect(r.applied).toBe(1150);
    });

    it('процент берётся из настроек магазина', () => {
        const r = capStep({ current: 1000, target: 2000, store: { ...OZON, max_raise_percent: 50 } });
        expect(r.applied).toBe(1500);
    });

    it('доходит до цели за несколько прогонов', () => {
        let price = 1000;
        const target = 2000;
        for (let i = 0; i < 12 && price !== target; i++) {
            price = capStep({ current: price, target, store: OZON }).applied;
        }
        expect(price).toBe(target);
    });
});

describe('capStep — вырожденные случаи', () => {
    it('цель равна текущей цене — ничего не делаем', () => {
        const r = capStep({ current: 1000, target: 1000, store: WB });
        expect(r.direction).toBe('none');
        expect(r.capped).toBe(false);
    });

    it.each([
        ['нет текущей цены', { current: 0, target: 500 }],
        ['текущая отрицательная', { current: -100, target: 500 }],
        ['цель ноль', { current: 500, target: 0 }],
        ['цель не число', { current: 500, target: NaN }],
    ])('%s — цель возвращается как есть, без ограничений', (_l, args) => {
        const r = capStep({ ...args, store: WB });
        expect(r.capped).toBe(false);
    });

    it('шаг никогда не хуже самой цели', () => {
        // цель выше ограниченного шага — берём цель, а не шаг
        const r = capStep({ current: 1000, target: 800, store: { ...WB, max_drop_ratio: 3 } });
        expect(r.applied).toBe(800);
    });
});
