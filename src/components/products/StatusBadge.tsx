import React from 'react';
import type { OzonProduct } from '../../services/ozonApi';
import Tooltip from '../ui/Tooltip';
import styles from './StatusBadge.module.css';

interface StatusBadgeProps {
    product: OzonProduct;
}

type StatusLevel = 'quarantine' | 'archived' | 'price_rejected' | 'promo_below_cost' | 'needs_work' | 'ready' | 'removed' | 'ok';

interface StatusInfo {
    level: StatusLevel;
    label: string;
    tooltip: string;
}

export function getProductStatus(product: OzonProduct): StatusInfo {
    // 1. Карантин (Ошибки)
    if (product.is_quarantine === 1) {
        return {
            level: 'quarantine',
            label: 'Карантин',
            tooltip: 'Товар в ценовом карантине Ozon',
        };
    }

    // 2. Архив
    if (product.is_archived === 1) {
        return {
            level: 'archived',
            label: 'Архив',
            tooltip: 'Товар выведен из ассортимента',
        };
    }

    // 3. Акция ниже себестоимости
    if (
        product.in_promo === 1 &&
        product.promo_price !== undefined &&
        product.cost_price !== undefined &&
        product.promo_price < product.cost_price
    ) {
        return {
            level: 'promo_below_cost',
            label: 'Акция < себест.',
            tooltip: `Акционная цена (${product.promo_price} ₽) ниже себестоимости (${product.cost_price} ₽)`,
        };
    }

    // 4. Цена отклонена
    if (product.price_apply_status === 'rejected') {
        const errMsg = product.price_apply_error ? `: ${product.price_apply_error}` : '';
        return {
            level: 'price_rejected',
            label: 'Цена ≠',
            tooltip: `Цена не принята Ozon${errMsg}`,
        };
    }

    // 5. Товар невидим (только для Ozon — visibility явно задан)
    if (product.visibility === 'INVISIBLE') {
        const isCreated = product.ozon_is_created !== 0; // default true if undefined

        // Карточка не прошла проверку / не заполнена
        if (!isCreated) {
            return {
                level: 'needs_work',
                label: 'На доработку',
                tooltip: 'Товар не прошёл проверку или требует заполнения',
            };
        }

        // Готовы к продаже: карточка ок, нет стока
        if (product.has_stock === 0) {
            return {
                level: 'ready',
                label: 'Готов к продаже',
                tooltip: 'Товар готов, ожидает поставки на склад',
            };
        }

        // Снят с продажи: есть цена и сток, но не продаётся
        return {
            level: 'removed',
            label: 'Снят с продажи',
            tooltip: 'Товар снят с продажи продавцом',
        };
    }

    // 6. OK — продаётся
    return {
        level: 'ok',
        label: 'OK',
        tooltip: 'Товар активен и продаётся',
    };
}

const StatusBadge: React.FC<StatusBadgeProps> = ({ product }) => {
    const status = getProductStatus(product);

    if (status.level === 'ok') {
        return (
            <Tooltip text={status.tooltip} delay={300}>
                <span className={styles.dot} aria-label={status.tooltip} />
            </Tooltip>
        );
    }

    return (
        <Tooltip text={status.tooltip} delay={200}>
            <span
                className={`${styles.badge} ${styles[status.level]}`}
                aria-label={status.tooltip}
            >
                {status.label}
            </span>
        </Tooltip>
    );
};

export default StatusBadge;
