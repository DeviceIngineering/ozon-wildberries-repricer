import React, { useEffect, useRef, useState } from 'react';
import styles from './NumericFilters.module.css';

export interface NumericFilterValues {
    sales_30d_min?: number;
    sales_30d_max?: number;
    stocks_fbo_min?: number;
    stocks_fbo_max?: number;
    stocks_fbs_min?: number;
    stocks_fbs_max?: number;
    cost_price_min?: number;
    cost_price_max?: number;
    price_min?: number;
    price_max?: number;
}

export const EMPTY_NUMERIC_FILTERS: NumericFilterValues = {};

type FieldKey = 'sales_30d' | 'stocks_fbo' | 'stocks_fbs' | 'cost_price' | 'price';

const FIELDS: { key: FieldKey; label: string }[] = [
    { key: 'sales_30d', label: 'Продажи 30д' },
    { key: 'stocks_fbo', label: 'Остатки FBO' },
    { key: 'stocks_fbs', label: 'Остатки FBS' },
    { key: 'cost_price', label: 'Себестоимость' },
    { key: 'price', label: 'Цена продажи' },
];

type DraftState = Record<string, string>;

function valuesToDraft(value: NumericFilterValues): DraftState {
    const draft: DraftState = {};
    for (const { key } of FIELDS) {
        draft[`${key}_min`] = value[`${key}_min` as keyof NumericFilterValues]?.toString() ?? '';
        draft[`${key}_max`] = value[`${key}_max` as keyof NumericFilterValues]?.toString() ?? '';
    }
    return draft;
}

export function countActiveFilters(value: NumericFilterValues): number {
    return Object.values(value).filter((v) => v !== undefined).length;
}

interface NumericFiltersProps {
    value: NumericFilterValues;
    onApply: (v: NumericFilterValues) => void;
}

const NumericFilters: React.FC<NumericFiltersProps> = ({ value, onApply }) => {
    const [open, setOpen] = useState(false);
    const [draft, setDraft] = useState<DraftState>(() => valuesToDraft(value));
    const [errors, setErrors] = useState<Set<FieldKey>>(new Set());
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, []);

    const handleToggleOpen = () => {
        if (!open) {
            setDraft(valuesToDraft(value));
            setErrors(new Set());
        }
        setOpen((v) => !v);
    };

    const handleDraftChange = (field: string, raw: string) => {
        setDraft((d) => ({ ...d, [field]: raw }));
    };

    const handleReset = () => {
        setDraft(valuesToDraft({}));
        setErrors(new Set());
        onApply({});
        setOpen(false);
    };

    const handleApply = () => {
        const nextErrors = new Set<FieldKey>();
        const parsed: NumericFilterValues = {};

        for (const { key } of FIELDS) {
            const minRaw = draft[`${key}_min`];
            const maxRaw = draft[`${key}_max`];
            const min = minRaw !== '' ? parseFloat(minRaw) : undefined;
            const max = maxRaw !== '' ? parseFloat(maxRaw) : undefined;

            if (min !== undefined && !Number.isNaN(min)) (parsed as any)[`${key}_min`] = min;
            if (max !== undefined && !Number.isNaN(max)) (parsed as any)[`${key}_max`] = max;

            if (
                min !== undefined && !Number.isNaN(min) &&
                max !== undefined && !Number.isNaN(max) &&
                min > max
            ) {
                nextErrors.add(key);
            }
        }

        if (nextErrors.size > 0) {
            setErrors(nextErrors);
            return;
        }

        setErrors(new Set());
        onApply(parsed);
        setOpen(false);
    };

    const activeCount = countActiveFilters(value);

    return (
        <div className={styles.wrapper} ref={ref}>
            <button
                className={`${styles.trigger} ${activeCount > 0 ? styles.triggerActive : ''}`}
                onClick={handleToggleOpen}
            >
                Фильтры {activeCount > 0 ? `(${activeCount})` : '▾'}
            </button>
            {open && (
                <div className={styles.dropdown}>
                    {FIELDS.map(({ key, label }) => {
                        const hasError = errors.has(key);
                        return (
                            <React.Fragment key={key}>
                                <div className={styles.row}>
                                    <span className={styles.label}>{label}</span>
                                    <input
                                        type="number"
                                        className={`${styles.rangeInput} ${hasError ? styles.rangeInputError : ''}`}
                                        placeholder="от"
                                        value={draft[`${key}_min`] ?? ''}
                                        onChange={(e) => handleDraftChange(`${key}_min`, e.target.value)}
                                    />
                                    <input
                                        type="number"
                                        className={`${styles.rangeInput} ${hasError ? styles.rangeInputError : ''}`}
                                        placeholder="до"
                                        value={draft[`${key}_max`] ?? ''}
                                        onChange={(e) => handleDraftChange(`${key}_max`, e.target.value)}
                                    />
                                </div>
                                {hasError && <div className={styles.error}>«от» больше «до»</div>}
                            </React.Fragment>
                        );
                    })}
                    <div className={styles.actions}>
                        <button className={styles.resetBtn} onClick={handleReset}>Сбросить</button>
                        <button className={styles.applyBtn} onClick={handleApply}>Применить</button>
                    </div>
                </div>
            )}
        </div>
    );
};

export default NumericFilters;
