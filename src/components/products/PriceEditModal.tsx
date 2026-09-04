import React from 'react';
import Modal from '../ui/Modal';
import { useToast } from '../../contexts/ToastContext';
import type { OzonProduct } from '../../services/ozonApi';
import styles from './PriceEditModal.module.css';

interface PriceEditModalProps {
    product: OzonProduct | null;
    storeId: string | null;
    onClose: () => void;
    onPriceUpdate: (productId: number, offerId: string, newPrice: number, oldPrice: number, minPrice: number) => Promise<void>;
}

const PriceEditModal: React.FC<PriceEditModalProps> = ({ product, storeId, onClose, onPriceUpdate }) => {
    const { showSuccess, showError } = useToast();

    const [newPrice, setNewPrice] = React.useState('');
    const [newMinPrice, setNewMinPrice] = React.useState('');
    const [newOldPrice, setNewOldPrice] = React.useState('');
    const [isUpdating, setIsUpdating] = React.useState(false);
    const [isSyncingSingle, setIsSyncingSingle] = React.useState(false);
    const [showSyncPrompt, setShowSyncPrompt] = React.useState(false);
    const [wasSynced, setWasSynced] = React.useState(false);

    // Editing product state (may be updated after sync)
    const [editingProduct, setEditingProduct] = React.useState<OzonProduct | null>(null);

    React.useEffect(() => {
        if (product) {
            setEditingProduct(product);
            setNewPrice(product.price?.toString() || '');
            setNewMinPrice(product.min_price?.toString() || '');
            setNewOldPrice(product.old_price?.toString() || '');
            setWasSynced(false);
            setShowSyncPrompt(false);
            setIsUpdating(false);
        }
    }, [product]);

    const handleClose = () => {
        setShowSyncPrompt(false);
        onClose();
    };

    const handleSavePrice = async () => {
        if (!editingProduct) return;

        const priceValue = parseFloat(newPrice);
        const minPriceValue = parseFloat(newMinPrice);
        const oldPriceValue = parseFloat(newOldPrice);

        if (isNaN(priceValue) || priceValue <= 0) {
            showError('Введите корректную основную цену');
            return;
        }

        if (!isNaN(minPriceValue) && minPriceValue > 0) {
            if (minPriceValue < priceValue * 0.5) {
                showError(`Ошибка: Минимальная цена (${minPriceValue}) должна быть не менее 50% от основной (${Math.ceil(priceValue * 0.5)}).`);
                return;
            }
            if (priceValue < minPriceValue) {
                showError(`Ошибка: Основная цена (${priceValue}) не может быть меньше минимальной (${minPriceValue}).`);
                return;
            }
            if (!isNaN(oldPriceValue) && oldPriceValue > 0) {
                if (oldPriceValue < minPriceValue * 2) {
                    showError(`Ошибка: Старая цена (${oldPriceValue}) должна быть как минимум в 2 раза больше минимальной цены (${minPriceValue * 2}).`);
                    return;
                }
            }
        }

        setIsUpdating(true);
        try {
            await onPriceUpdate(
                editingProduct.product_id,
                editingProduct.offer_id,
                priceValue,
                !isNaN(oldPriceValue) && oldPriceValue > 0 ? oldPriceValue : 0,
                !isNaN(minPriceValue) && minPriceValue > 0 ? minPriceValue : 0
            );

            if (!wasSynced) {
                setShowSyncPrompt(true);
            } else {
                handleClose();
                showSuccess('Цена успешно обновлена!');
            }
        } catch (err: any) {
            showError('Ошибка обновления цены: ' + (err.message || 'Неизвестная ошибка'));
        } finally {
            setIsUpdating(false);
        }
    };

    const handleSingleSync = async (productId: number, closeAfter = false) => {
        if (!storeId) return;
        setIsSyncingSingle(true);
        try {
            const res = await fetch(`/api/stores/${storeId}/products/${productId}/sync`, { method: 'POST' });
            const data = await res.json();
            if (data.success) {
                if (editingProduct && editingProduct.product_id === productId) {
                    setEditingProduct({ ...editingProduct, ...data.product });
                    setNewPrice(data.product.price?.toString() || '');
                    setNewMinPrice(data.product.min_price?.toString() || '');
                    setNewOldPrice(data.product.old_price?.toString() || '');
                    setWasSynced(true);
                }
                showSuccess('Товар успешно синхронизирован с Ozon!');
                if (closeAfter) handleClose();
            } else {
                showError('Ошибка синхронизации: ' + data.error);
            }
        } catch (err: any) {
            showError('Ошибка запроса: ' + err.message);
        } finally {
            setIsSyncingSingle(false);
        }
    };

    const handleFullSync = async () => {
        if (!storeId || !editingProduct) return;
        try {
            fetch(`/api/stores/${storeId}/sync`, { method: 'POST' });
            showSuccess('Запущена полная синхронизация магазина. Это займет некоторое время.');
            handleClose();
        } catch (err: any) {
            showError('Ошибка запуска синхронизации: ' + err.message);
        }
    };

    if (!product || !editingProduct) return null;

    return (
        <Modal isOpen={true} onClose={handleClose} title="Изменить цену товара">
            {showSyncPrompt ? (
                <div className={styles.syncPrompt}>
                    <h3 className={styles.syncTitle}>Цена обновлена!</h3>
                    <p className={styles.syncText}>Хотите синхронизировать данные с Ozon?</p>
                    <div className={styles.syncActions}>
                        <button
                            onClick={() => handleSingleSync(editingProduct.product_id, true)}
                            className="primary-btn"
                        >
                            Синхронизировать этот товар
                        </button>
                        <button
                            onClick={handleFullSync}
                            className="secondary-btn"
                        >
                            Синхронизировать весь магазин
                        </button>
                        <button
                            onClick={handleClose}
                            className={styles.skipSyncBtn}
                        >
                            Закрыть без синхронизации
                        </button>
                    </div>
                </div>
            ) : (
                <>
                    <div className={styles.productInfo}>
                        <div className={styles.productInfoText}>
                            <p className={styles.infoRow}>
                                <strong>Товар:</strong> {editingProduct.name}
                            </p>
                            <p className={styles.infoRow}>
                                <strong>Артикул:</strong> {editingProduct.offer_id}
                            </p>
                            <p className={styles.infoRow}>
                                <strong>Текущая цена:</strong> {editingProduct.price} {editingProduct.currency_code}
                            </p>
                        </div>
                        <button
                            onClick={() => handleSingleSync(editingProduct.product_id)}
                            disabled={isSyncingSingle}
                            title="Обновить данные этого товара из Ozon"
                            className={styles.syncBtn}
                        >
                            {isSyncingSingle ? '...' : '↻ Sync'}
                        </button>
                    </div>

                    <div className={styles.priceGrid}>
                        <div className={styles.priceFieldFull}>
                            <label className={styles.labelPrimary}>
                                Основная цена <span className={styles.required}>*</span>
                            </label>
                            <input
                                type="number"
                                value={newPrice}
                                onChange={(e) => setNewPrice(e.target.value)}
                                placeholder="Текущая цена"
                                className={styles.priceInput}
                                disabled={isUpdating}
                            />
                        </div>

                        <div>
                            <label className={styles.labelSecondary}>Мин. цена</label>
                            <input
                                type="number"
                                value={newMinPrice}
                                onChange={(e) => setNewMinPrice(e.target.value)}
                                placeholder="Минимум"
                                className={styles.priceInputSmall}
                                disabled={isUpdating}
                            />
                        </div>

                        <div>
                            <label className={styles.labelSecondary}>Старая цена</label>
                            <input
                                type="number"
                                value={newOldPrice}
                                onChange={(e) => setNewOldPrice(e.target.value)}
                                placeholder="До скидки"
                                className={styles.priceInputSmall}
                                disabled={isUpdating}
                            />
                        </div>
                    </div>

                    <div className={styles.actions}>
                        <button
                            onClick={handleSavePrice}
                            className="primary-btn"
                            disabled={isUpdating}
                            style={{ flex: 1 }}
                        >
                            {isUpdating ? 'Обновление...' : 'Сохранить'}
                        </button>
                        <button
                            onClick={handleClose}
                            className="secondary-btn"
                            disabled={isUpdating}
                            style={{ flex: 1 }}
                        >
                            Отмена
                        </button>
                    </div>
                </>
            )}
        </Modal>
    );
};

export default PriceEditModal;
