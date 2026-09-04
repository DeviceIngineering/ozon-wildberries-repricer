import { useState, useEffect, useRef } from 'react';
import ReactDOM from 'react-dom';
import styles from './CrossStorePopup.module.css';

const API_BASE = '';

interface CrossStoreEntry {
    store_id: string;
    store_name: string;
    price: string | null;
    cost_price: number | null;
    marketing_price: string | null;
}

interface CrossStorePopupProps {
    offerId: string;
    triggerRef: React.RefObject<HTMLElement | null>;
    onClose: () => void;
}

function computeMarginPct(price: string | null, marketingPrice: string | null, costPrice: number | null): string {
    if (!costPrice) return '—';
    const raw = marketingPrice && marketingPrice !== '0' && marketingPrice !== '0.00'
        ? marketingPrice
        : price;
    const p = parseFloat(raw || '0');
    if (!p) return '—';
    const m = ((p - costPrice) / p) * 100;
    return m.toFixed(1) + '%';
}

function marginColor(price: string | null, marketingPrice: string | null, costPrice: number | null): string {
    if (!costPrice) return 'var(--text-secondary)';
    const raw = marketingPrice && marketingPrice !== '0' && marketingPrice !== '0.00'
        ? marketingPrice
        : price;
    const p = parseFloat(raw || '0');
    if (!p) return 'var(--text-secondary)';
    const m = ((p - costPrice) / p) * 100;
    if (m >= 30) return '#4ade80';
    if (m >= 10) return '#facc15';
    return '#ef4444';
}

export default function CrossStorePopup({ offerId, triggerRef, onClose }: CrossStorePopupProps) {
    const [data, setData] = useState<CrossStoreEntry[] | null>(null);
    const [loading, setLoading] = useState(true);
    const popupRef = useRef<HTMLDivElement>(null);

    // Позиционирование относительно триггера
    const [pos, setPos] = useState({ top: 0, left: 0 });

    useEffect(() => {
        if (triggerRef.current) {
            const rect = triggerRef.current.getBoundingClientRect();
            const popupWidth = 340;
            let left = rect.left + window.scrollX;

            // Не выходить за правый край экрана
            if (left + popupWidth > window.innerWidth) {
                left = window.innerWidth - popupWidth - 12;
            }
            // Не уходить левее 8px
            if (left < 8) left = 8;

            setPos({
                top: rect.bottom + window.scrollY + 6,
                left,
            });
        }
    }, [triggerRef]);

    useEffect(() => {
        async function load() {
            try {
                const res = await fetch(`${API_BASE}/api/products/${encodeURIComponent(offerId)}/cross-store`);
                if (!res.ok) throw new Error('Ошибка загрузки');
                const rows: CrossStoreEntry[] = await res.json();
                setData(rows);
            } catch {
                setData([]);
            } finally {
                setLoading(false);
            }
        }
        load();
    }, [offerId]);

    // Закрытие по клику вне попапа
    useEffect(() => {
        const handler = (e: MouseEvent) => {
            if (
                popupRef.current &&
                !popupRef.current.contains(e.target as Node) &&
                triggerRef.current &&
                !triggerRef.current.contains(e.target as Node)
            ) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handler);
        return () => document.removeEventListener('mousedown', handler);
    }, [onClose, triggerRef]);

    const popup = (
        <div
            ref={popupRef}
            className={styles.popup}
            style={{ top: pos.top, left: pos.left }}
            role="dialog"
        >
            <div className={styles.header}>
                <span className={styles.title}>Сравнение по магазинам</span>
                <button className={styles.closeBtn} onClick={onClose}>✕</button>
            </div>

            {loading ? (
                <div className={styles.loading}>Загрузка...</div>
            ) : !data || data.length === 0 ? (
                <div className={styles.empty}>Товар не найден в других магазинах</div>
            ) : data.length === 1 ? (
                <div className={styles.empty}>Товар только в этом магазине</div>
            ) : (
                <table className={styles.table}>
                    <thead>
                        <tr>
                            <th>Магазин</th>
                            <th>Цена</th>
                            <th>Маржа</th>
                        </tr>
                    </thead>
                    <tbody>
                        {data.map((row) => (
                            <tr key={row.store_id}>
                                <td className={styles.storeName}>{row.store_name}</td>
                                <td className={styles.price}>
                                    {row.marketing_price && row.marketing_price !== '0' && row.marketing_price !== '0.00'
                                        ? <><span className={styles.promoPrice}>{row.marketing_price}</span></>
                                        : (row.price || '—')}
                                    {' ₽'}
                                </td>
                                <td style={{ color: marginColor(row.price, row.marketing_price, row.cost_price) }}>
                                    {computeMarginPct(row.price, row.marketing_price, row.cost_price)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </div>
    );

    return ReactDOM.createPortal(popup, document.body);
}
