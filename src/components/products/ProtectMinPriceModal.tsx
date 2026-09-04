import React, { useState } from 'react';
import { useToast } from '../../contexts/ToastContext';
import styles from './ProtectMinPriceModal.module.css';

interface Props {
    storeId: string;
    selectedProductIds: string[];
    onClose: () => void;
    onDone: () => void;
}

interface Result {
    updated: number;
    skipped: number;
    skipped_details: Array<{ offer_id: string; reason: string }>;
    ozon_errors?: Array<{ offer_id: string; errors: unknown[] }> | null;
}

const ProtectMinPriceModal: React.FC<Props> = ({ storeId, selectedProductIds, onClose, onDone }) => {
    const { showSuccess, showError } = useToast();
    const [margin, setMargin] = useState<string>('10');
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<Result | null>(null);

    const submit = async () => {
        setLoading(true);
        try {
            const res = await fetch(`/api/stores/${storeId}/protect-min-price`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    product_ids: selectedProductIds.map((id) => Number(id)),
                    margin_percent: Number(margin) || 0,
                }),
            });
            if (!res.ok) {
                const err = await res.text();
                throw new Error(err || `HTTP ${res.status}`);
            }
            const data: Result = await res.json();
            setResult(data);
            if (data.updated > 0) {
                showSuccess(`Защищено min_price у ${data.updated} товаров`);
            } else {
                showError(`Ничего не обновлено (${data.skipped} пропущено)`);
            }
        } catch (err) {
            showError('Ошибка: ' + (err instanceof Error ? err.message : String(err)));
        } finally {
            setLoading(false);
        }
    };

    return (
        <div className={styles.overlay} onClick={onClose}>
            <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
                <h3 className={styles.title}>Защитить min_price</h3>
                <p className={styles.intro}>
                    Для выбранных товаров ({selectedProductIds.length}) будет установлено:
                    <br />
                    <code className={styles.formula}>min_price = max(cost × (1 + маржа%), floor_min_price)</code>
                </p>
                <p className={styles.note}>
                    Ozon не сможет опустить цену ниже этого значения в своих автоакциях.
                    Пропускаются товары без cost_price и floor_min_price,
                    а также те, у кого текущий min_price уже выше рассчитанного.
                </p>

                {!result ? (
                    <>
                        <div className={styles.field}>
                            <label>Минимальная маржа к себестоимости (%)</label>
                            <input
                                type="number"
                                value={margin}
                                onChange={(e) => setMargin(e.target.value)}
                                min={0}
                                max={500}
                                step={1}
                                disabled={loading}
                            />
                        </div>
                        <div className={styles.actions}>
                            <button className={styles.secondaryBtn} onClick={onClose} disabled={loading}>
                                Отмена
                            </button>
                            <button className={styles.primaryBtn} onClick={submit} disabled={loading}>
                                {loading ? 'Отправка...' : `Применить к ${selectedProductIds.length} тов.`}
                            </button>
                        </div>
                    </>
                ) : (
                    <>
                        <div className={styles.resultBlock}>
                            <p><strong>{result.updated}</strong> обновлено в Ozon</p>
                            <p><strong>{result.skipped}</strong> пропущено</p>
                            {result.skipped_details.length > 0 && (
                                <details className={styles.details}>
                                    <summary>Причины пропуска ({result.skipped_details.length})</summary>
                                    <ul>
                                        {result.skipped_details.slice(0, 50).map((s, i) => (
                                            <li key={i}><code>{s.offer_id}</code>: {s.reason}</li>
                                        ))}
                                        {result.skipped_details.length > 50 && (
                                            <li>...и ещё {result.skipped_details.length - 50}</li>
                                        )}
                                    </ul>
                                </details>
                            )}
                            {result.ozon_errors && result.ozon_errors.length > 0 && (
                                <details className={styles.details}>
                                    <summary>Ошибки Ozon ({result.ozon_errors.length})</summary>
                                    <pre>{JSON.stringify(result.ozon_errors, null, 2)}</pre>
                                </details>
                            )}
                        </div>
                        <div className={styles.actions}>
                            <button className={styles.primaryBtn} onClick={() => { onDone(); onClose(); }}>
                                Закрыть
                            </button>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};

export default ProtectMinPriceModal;
