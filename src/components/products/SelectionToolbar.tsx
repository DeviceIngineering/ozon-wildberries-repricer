import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSelection } from '../../contexts/SelectionContext';
import Tooltip from '../ui/Tooltip';
import ProtectMinPriceModal from './ProtectMinPriceModal';
import styles from './SelectionToolbar.module.css';

interface SelectionToolbarProps {
    selectedCount: number;
    storeId: string | null;
    onClear: () => void;
}

const SelectionToolbar: React.FC<SelectionToolbarProps> = ({ selectedCount, storeId, onClear }) => {
    const navigate = useNavigate();
    const { selectedIds } = useSelection();
    const [protectOpen, setProtectOpen] = useState(false);

    if (selectedCount === 0) return null;

    const handleMassEdit = () => {
        if (storeId) {
            navigate(`/store/${storeId}/mass-edit`);
        }
    };

    return (
        <>
            <div className={styles.toolbar}>
                <span className={styles.count}>
                    Выбрано: <strong>{selectedCount}</strong> {pluralTovars(selectedCount)}
                </span>
                <div className={styles.actions}>
                    <button className={styles.primaryBtn} onClick={handleMassEdit}>
                        Изменить цены
                    </button>
                    {storeId && (
                        <Tooltip text="Массово поднять min_price = max(cost × (1 + маржа%), floor). Ozon не опустит цену ниже этого в автоакциях. Только повышает, не снижает." position="top">
                            <button
                                className={styles.primaryBtn}
                                onClick={() => setProtectOpen(true)}
                            >
                                🛡 Защитить min_price
                            </button>
                        </Tooltip>
                    )}
                    <button className={styles.clearBtn} onClick={onClear}>
                        Снять выделение
                    </button>
                </div>
            </div>
            {protectOpen && storeId && (
                <ProtectMinPriceModal
                    storeId={storeId}
                    selectedProductIds={[...selectedIds]}
                    onClose={() => setProtectOpen(false)}
                    onDone={onClear}
                />
            )}
        </>
    );
};

function pluralTovars(n: number): string {
    const mod10 = n % 10;
    const mod100 = n % 100;
    if (mod10 === 1 && mod100 !== 11) return 'товар';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'товара';
    return 'товаров';
}

export default SelectionToolbar;
