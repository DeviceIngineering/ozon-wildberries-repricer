import React from 'react';
import Modal from '../ui/Modal';
import type { OzonProduct } from '../../services/ozonApi';
import styles from './PriceHistoryModal.module.css';

interface PriceHistoryItem {
    id: number;
    checked_at: string;
    price: number;
    marketing_price: number;
    min_price: number;
}

interface PriceHistoryModalProps {
    product: OzonProduct | null;
    onClose: () => void;
}

const PriceHistoryModal: React.FC<PriceHistoryModalProps> = ({ product, onClose }) => {
    const [priceHistory, setPriceHistory] = React.useState<PriceHistoryItem[]>([]);
    const [isLoadingHistory, setIsLoadingHistory] = React.useState(false);

    React.useEffect(() => {
        if (!product) return;

        const fetchHistory = async () => {
            setIsLoadingHistory(true);
            setPriceHistory([]);
            try {
                const res = await fetch(`/api/products/${product.product_id}/history`);
                const data = await res.json();
                setPriceHistory(data);
            } catch (err) {
                console.error(err);
            } finally {
                setIsLoadingHistory(false);
            }
        };

        fetchHistory();
    }, [product]);

    if (!product) return null;

    return (
        <Modal isOpen={true} onClose={onClose} title="История цен">
            <div className={styles.productHeader}>
                <div className={styles.productName}>{product.name}</div>
                <div className={styles.productOffer}>({product.offer_id})</div>
            </div>

            <div className={styles.tableContainer}>
                {isLoadingHistory ? (
                    <p className={styles.emptyText}>Загрузка...</p>
                ) : priceHistory.length === 0 ? (
                    <p className={styles.emptyText}>Нет данных о ценах</p>
                ) : (
                    <table className={styles.historyTable}>
                        <thead className={styles.stickyHead}>
                            <tr className={styles.headerRow}>
                                <th className={styles.thLeft}>Дата</th>
                                <th className={styles.thRight}>Цена</th>
                                <th className={styles.thRight}>Маркетинг</th>
                                <th className={styles.thRight}>Мин.</th>
                            </tr>
                        </thead>
                        <tbody>
                            {priceHistory.map((item, idx) => {
                                const prev = priceHistory[idx + 1];
                                let diff = 0;
                                if (prev) {
                                    const currP = item.marketing_price > 0 ? item.marketing_price : item.price;
                                    const prevP = prev.marketing_price > 0 ? prev.marketing_price : prev.price;
                                    diff = currP - prevP;
                                }

                                return (
                                    <tr key={item.id} className={styles.dataRow}>
                                        <td className={styles.dateCell}>
                                            {new Date(item.checked_at).toLocaleString('ru-RU')}
                                        </td>
                                        <td className={styles.priceCell}>
                                            {item.price}
                                            {diff !== 0 && (
                                                <span className={diff > 0 ? styles.diffUp : styles.diffDown}>
                                                    {diff > 0 ? '▲' : '▼'} {Math.abs(diff)}
                                                </span>
                                            )}
                                        </td>
                                        <td className={styles.marketingCell}>{item.marketing_price || '-'}</td>
                                        <td className={styles.minPriceCell}>{item.min_price || '-'}</td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </Modal>
    );
};

export default PriceHistoryModal;
