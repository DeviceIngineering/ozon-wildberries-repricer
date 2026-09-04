import { describe, it, expect } from 'vitest';
import { getProductStatus } from '../StatusBadge';
import type { OzonProduct } from '../../../services/ozonApi';

function makeProduct(overrides: Partial<OzonProduct> = {}): OzonProduct {
    return {
        offer_id: 'TEST-001',
        visibility: 'VISIBLE',
        is_quarantine: 0,
        is_archived: 0,
        in_promo: 0,
        ...overrides,
    } as OzonProduct;
}

describe('getProductStatus', () => {
    it('returns OK for healthy product', () => {
        const status = getProductStatus(makeProduct());
        expect(status.level).toBe('ok');
    });

    it('returns quarantine when is_quarantine=1', () => {
        const status = getProductStatus(makeProduct({ is_quarantine: 1 }));
        expect(status.level).toBe('quarantine');
    });

    it('returns archived when is_archived=1', () => {
        const status = getProductStatus(makeProduct({ is_archived: 1 }));
        expect(status.level).toBe('archived');
    });

    it('returns removed when INVISIBLE with stock and created', () => {
        const status = getProductStatus(makeProduct({ visibility: 'INVISIBLE' }));
        expect(status.level).toBe('removed');
    });

    it('returns ready when INVISIBLE, created, but no stock', () => {
        const status = getProductStatus(makeProduct({ visibility: 'INVISIBLE', has_stock: 0, ozon_is_created: 1 }));
        expect(status.level).toBe('ready');
    });

    it('returns needs_work when INVISIBLE and not created', () => {
        const status = getProductStatus(makeProduct({ visibility: 'INVISIBLE', ozon_is_created: 0 }));
        expect(status.level).toBe('needs_work');
    });

    it('returns OK when visibility is NULL (Yandex products)', () => {
        const status = getProductStatus(makeProduct({ visibility: undefined }));
        expect(status.level).toBe('ok');
    });

    it('returns OK when visibility is null string (Yandex products)', () => {
        const status = getProductStatus(makeProduct({ visibility: null as unknown as string }));
        expect(status.level).toBe('ok');
    });

    it('returns promo_below_cost when promo price < cost', () => {
        const status = getProductStatus(makeProduct({
            in_promo: 1,
            promo_price: 100,
            cost_price: 200,
        }));
        expect(status.level).toBe('promo_below_cost');
    });

    it('returns OK when in_promo=1 but promo_price >= cost_price', () => {
        const status = getProductStatus(makeProduct({
            in_promo: 1,
            promo_price: 300,
            cost_price: 200,
        }));
        expect(status.level).toBe('ok');
    });

    it('returns OK when in_promo=0 (promo was reset)', () => {
        const status = getProductStatus(makeProduct({ in_promo: 0 }));
        expect(status.level).toBe('ok');
    });

    it('quarantine takes priority over promo_below_cost', () => {
        const status = getProductStatus(makeProduct({
            is_quarantine: 1,
            in_promo: 1,
            promo_price: 100,
            cost_price: 200,
        }));
        expect(status.level).toBe('quarantine');
    });
});
