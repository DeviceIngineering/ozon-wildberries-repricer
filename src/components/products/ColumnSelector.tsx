import React, { useEffect, useRef, useState } from 'react';
import styles from './ColumnSelector.module.css';

export type ColumnKey =
    | 'status'
    | 'photo'
    | 'name'
    | 'price'
    | 'marketing_price'
    | 'min_price'
    | 'ref_price'
    | 'old_price'
    | 'cost_price'
    | 'floor_min_price'
    | 'promo_price'
    | 'margin'
    | 'stocks_fbo'
    | 'stocks_fbs'
    | 'sales_30d'
    | 'risk';

export const ALL_COLUMNS: ColumnKey[] = [
    'status',
    'photo',
    'name',
    'price',
    'marketing_price',
    'min_price',
    'promo_price',
    'ref_price',
    'old_price',
    'cost_price',
    'floor_min_price',
    'margin',
    'stocks_fbo',
    'stocks_fbs',
    'sales_30d',
    'risk',
];

export const COLUMN_LABELS: Record<ColumnKey, string> = {
    status: 'Статус',
    photo: 'Фото',
    name: 'Название / Артикул',
    price: 'Цена',
    marketing_price: 'Маркетинг',
    min_price: 'Мин. цена',
    promo_price: 'Акция',
    ref_price: 'Эталон',
    old_price: 'Старая',
    cost_price: 'Себестоимость',
    floor_min_price: 'Пол цены',
    margin: 'Маржа',
    stocks_fbo: 'Остатки FBO',
    stocks_fbs: 'Остатки FBS',
    sales_30d: 'Продажи за 30 дней',
    risk: 'Риск',
};

export const DEFAULT_COLUMN_WIDTHS: Record<ColumnKey, number> = {
    status: 36,
    photo: 44,
    name: 220,
    price: 80,
    marketing_price: 96,
    min_price: 96,
    promo_price: 90,
    ref_price: 90,
    old_price: 80,
    cost_price: 90,
    floor_min_price: 90,
    margin: 80,
    stocks_fbo: 96,
    stocks_fbs: 96,
    sales_30d: 96,
    risk: 90,
};

export const MIN_COLUMN_WIDTH = 40;

const STORAGE_KEY = 'ozon-viewer-columns';
const ORDER_STORAGE_KEY = 'ozon-viewer-column-order';
const WIDTHS_STORAGE_KEY = 'ozon-viewer-column-widths';

export function loadVisibleColumns(): Set<ColumnKey> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const arr: ColumnKey[] = JSON.parse(raw);
            return new Set(arr);
        }
    } catch {
        // Corrupted or unreadable localStorage: fall back to defaults below.
    }
    return new Set(ALL_COLUMNS);
}

export function saveVisibleColumns(cols: Set<ColumnKey>): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...cols]));
}

export function loadColumnOrder(): ColumnKey[] {
    try {
        const raw = localStorage.getItem(ORDER_STORAGE_KEY);
        if (raw) {
            const saved: ColumnKey[] = JSON.parse(raw);
            const known = saved.filter((c) => ALL_COLUMNS.includes(c));
            const missing = ALL_COLUMNS.filter((c) => !saved.includes(c));
            return [...known, ...missing];
        }
    } catch {
        // Corrupted or unreadable localStorage: fall back to defaults below.
    }
    return [...ALL_COLUMNS];
}

export function saveColumnOrder(order: ColumnKey[]): void {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(order));
}

export function loadColumnWidths(): Record<ColumnKey, number> {
    try {
        const raw = localStorage.getItem(WIDTHS_STORAGE_KEY);
        if (raw) {
            const saved: Partial<Record<ColumnKey, number>> = JSON.parse(raw);
            return { ...DEFAULT_COLUMN_WIDTHS, ...saved };
        }
    } catch {
        // Corrupted or unreadable localStorage: fall back to defaults below.
    }
    return { ...DEFAULT_COLUMN_WIDTHS };
}

export function saveColumnWidths(widths: Record<ColumnKey, number>): void {
    localStorage.setItem(WIDTHS_STORAGE_KEY, JSON.stringify(widths));
}

interface ColumnSelectorProps {
    visibleColumns: Set<ColumnKey>;
    onChange: (cols: Set<ColumnKey>) => void;
    columnOrder: ColumnKey[];
    onReorderChange: (order: ColumnKey[]) => void;
}

const DragHandleIcon = () => (
    <svg className={styles.dragHandle} width="12" height="16" viewBox="0 0 12 16" fill="currentColor">
        <circle cx="3" cy="3" r="1.3" />
        <circle cx="9" cy="3" r="1.3" />
        <circle cx="3" cy="8" r="1.3" />
        <circle cx="9" cy="8" r="1.3" />
        <circle cx="3" cy="13" r="1.3" />
        <circle cx="9" cy="13" r="1.3" />
    </svg>
);

const ColumnSelector: React.FC<ColumnSelectorProps> = ({ visibleColumns, onChange, columnOrder, onReorderChange }) => {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const toggle = (col: ColumnKey) => {
        const next = new Set(visibleColumns);
        if (next.has(col)) {
            // Keep at least one column
            if (next.size <= 1) return;
            next.delete(col);
        } else {
            next.add(col);
        }
        onChange(next);
        saveVisibleColumns(next);
    };

    const handleDragStart = (index: number) => {
        setDragIndex(index);
    };

    const handleDragOver = (e: React.DragEvent, index: number) => {
        e.preventDefault();
        if (index !== dragOverIndex) setDragOverIndex(index);
    };

    const handleDrop = (index: number) => {
        if (dragIndex === null || dragIndex === index) {
            setDragIndex(null);
            setDragOverIndex(null);
            return;
        }
        const next = [...columnOrder];
        const [moved] = next.splice(dragIndex, 1);
        next.splice(index, 0, moved);
        onReorderChange(next);
        saveColumnOrder(next);
        setDragIndex(null);
        setDragOverIndex(null);
    };

    const handleDragEnd = () => {
        setDragIndex(null);
        setDragOverIndex(null);
    };

    return (
        <div className={styles.wrapper} ref={ref}>
            <button className={styles.trigger} onClick={() => setOpen((v) => !v)}>
                Колонки ▾
            </button>
            {open && (
                <div className={styles.dropdown}>
                    {columnOrder.map((col, index) => (
                        <label
                            key={col}
                            className={`${styles.option} ${dragIndex === index ? styles.optionDragging : ''} ${dragOverIndex === index && dragIndex !== index ? styles.optionDragOver : ''}`}
                            draggable
                            onDragStart={() => handleDragStart(index)}
                            onDragOver={(e) => handleDragOver(e, index)}
                            onDrop={() => handleDrop(index)}
                            onDragEnd={handleDragEnd}
                        >
                            <DragHandleIcon />
                            <input
                                type="checkbox"
                                checked={visibleColumns.has(col)}
                                onChange={() => toggle(col)}
                            />
                            {COLUMN_LABELS[col]}
                        </label>
                    ))}
                </div>
            )}
        </div>
    );
};

export default ColumnSelector;
