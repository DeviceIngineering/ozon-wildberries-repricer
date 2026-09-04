import React, { useEffect, useRef, useState } from 'react';
import Tooltip from '../ui/Tooltip';
import styles from './ProductFilters.module.css';

export type ActiveFilter = 'all' | 'on_sale' | 'ready' | 'removed' | 'errors' | 'needs_work' | 'archived' | 'promo' | 'below_ref' | 'can_improve' | 'price_rejected' | 'has_fbo' | 'has_fbs' | 'no_cost' | 'no_data';

export interface FilterCounts {
    all: number;
    on_sale: number;
    ready: number;
    removed: number;
    errors: number;
    needs_work: number;
    archived: number;
    can_improve: number;
    has_fbo: number;
    has_fbs: number;
}

interface ProductFiltersProps {
    searchQuery: string;
    onSearchChange: (query: string) => void;
    activeFilter: ActiveFilter;
    onSelectFilter: (filter: ActiveFilter) => void;
    counts: FilterCounts;
    platform?: string;
}

type TabFilter = Exclude<ActiveFilter, 'promo' | 'below_ref' | 'price_rejected' | 'no_cost' | 'no_data'>;

const OZON_TABS: { key: TabFilter; label: string; badge?: 'red' | 'orange'; tooltip?: string }[] = [
    { key: 'all', label: 'Все', tooltip: 'Все активные товары (без архива)' },
    { key: 'on_sale', label: 'В продаже', tooltip: 'Товары со статусом VISIBLE на Ozon' },
    { key: 'ready', label: 'Готовы к продаже', tooltip: 'INVISIBLE + ozon_is_created=1 + нет стока' },
    { key: 'removed', label: 'Сняты с продажи', tooltip: 'INVISIBLE, карточка валидна, сток есть, но не в продаже' },
    { key: 'errors', label: 'Ошибки', badge: 'red', tooltip: 'Ценовой карантин — Ozon отклонил цену' },
    { key: 'needs_work', label: 'На доработку', badge: 'orange', tooltip: 'Карточка не прошла валидацию Ozon' },
    { key: 'has_fbo', label: 'Есть FBO', tooltip: 'Доступные остатки на складах Ozon > 0 (present − reserved)' },
    { key: 'has_fbs', label: 'Есть FBS', tooltip: 'Доступные остатки на складе продавца > 0 (present − reserved)' },
    { key: 'archived', label: 'Архив', tooltip: 'Архивные карточки (is_archived=1)' },
];

const YM_TABS: { key: TabFilter; label: string; badge?: 'red' | 'orange'; tooltip?: string }[] = [
    { key: 'all', label: 'Товары' },
    { key: 'needs_work', label: 'С ошибками', badge: 'orange' },
    { key: 'errors', label: 'Карантин', badge: 'red' },
    { key: 'can_improve', label: 'Можно улучшить' },
    { key: 'archived', label: 'Архив' },
];

const ProductFilters: React.FC<ProductFiltersProps> = ({
    searchQuery,
    onSearchChange,
    activeFilter,
    onSelectFilter,
    counts,
    platform,
}) => {
    const TABS = platform === 'yandex' ? YM_TABS : OZON_TABS;
    const [localQuery, setLocalQuery] = useState(searchQuery);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    useEffect(() => {
        setLocalQuery(searchQuery);
    }, [searchQuery]);

    const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const value = e.target.value;
        setLocalQuery(value);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
            onSearchChange(value);
        }, 300);
    };

    return (
        <div className={styles.wrapper}>
            <div className={styles.tabBar}>
                {TABS.map(({ key, label, badge, tooltip }) => {
                    const count = counts[key];
                    const isActive = activeFilter === key;
                    const showBadge = badge && count > 0;
                    const btn = (
                        <button
                            key={key}
                            className={`${styles.tab} ${isActive ? styles.tabActive : ''}`}
                            onClick={() => onSelectFilter(key)}
                        >
                            {label}
                            {showBadge ? (
                                <span className={`${styles.badgeCircle} ${badge === 'red' ? styles.badgeRed : styles.badgeOrange}`}>
                                    {count}
                                </span>
                            ) : (
                                <span className={styles.count}>{count}</span>
                            )}
                        </button>
                    );
                    return tooltip ? (
                        <Tooltip key={key} text={tooltip} position="bottom">{btn}</Tooltip>
                    ) : btn;
                })}
            </div>
            <div className={styles.searchRow}>
                <input
                    type="text"
                    className={styles.searchInput}
                    value={localQuery}
                    onChange={handleInputChange}
                    placeholder="Поиск по названию, ID или артикулу..."
                />
            </div>
        </div>
    );
};

export default ProductFilters;
