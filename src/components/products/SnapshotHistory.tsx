import { useState, useEffect, useCallback } from 'react';
import Modal from '../ui/Modal';
import ConfirmDialog from '../ui/ConfirmDialog';
import { useToast } from '../../contexts/ToastContext';
import { errorMessage } from '../../services/apiError';
import styles from './SnapshotHistory.module.css';

const API_BASE = '';

interface Snapshot {
    id: number;
    store_id: string;
    created_at: string;
    source: string;
    items_count: number;
}

interface SnapshotHistoryProps {
    isOpen: boolean;
    storeId: string;
    onClose: () => void;
}

function formatRelativeTime(dateStr: string): string {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60_000);
    const diffHours = Math.floor(diffMins / 60);
    const diffDays = Math.floor(diffHours / 24);

    if (diffMins < 1) return 'только что';
    if (diffMins < 60) return `${diffMins} мин. назад`;
    if (diffHours < 24) return `${diffHours} ч. назад`;
    if (diffDays < 7) return `${diffDays} дн. назад`;

    return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export default function SnapshotHistory({ isOpen, storeId, onClose }: SnapshotHistoryProps) {
    const { showSuccess, showError } = useToast();
    const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
    const [loading, setLoading] = useState(false);
    const [rollbackTarget, setRollbackTarget] = useState<Snapshot | null>(null);
    const [rolling, setRolling] = useState(false);

    const fetchSnapshots = useCallback(async () => {
        setLoading(true);
        try {
            const res = await fetch(`${API_BASE}/api/stores/${storeId}/snapshots`);
            if (!res.ok) throw new Error('Не удалось загрузить историю');
            const data: Snapshot[] = await res.json();
            setSnapshots(data);
        } catch (err) {
            showError('Ошибка загрузки истории: ' + errorMessage(err));
        } finally {
            setLoading(false);
        }
    }, [storeId, showError]);

    useEffect(() => {
        if (isOpen) {
            fetchSnapshots();
        }
    }, [isOpen, fetchSnapshots]);

    const handleRollback = async () => {
        if (!rollbackTarget) return;
        setRolling(true);
        try {
            const res = await fetch(`${API_BASE}/api/stores/${storeId}/snapshots/${rollbackTarget.id}/rollback`, {
                method: 'POST',
            });
            if (!res.ok) throw new Error('Откат не удался');
            showSuccess('Цены успешно откачены');
            setRollbackTarget(null);
        } catch (err) {
            showError('Ошибка отката: ' + errorMessage(err));
        } finally {
            setRolling(false);
        }
    };

    return (
        <>
            <Modal isOpen={isOpen} onClose={onClose} title="История операций с ценами">
                {loading ? (
                    <div className={styles.loadingWrap}>
                        <div className="loader" style={{ width: 32, height: 32 }} />
                        <span>Загрузка...</span>
                    </div>
                ) : snapshots.length === 0 ? (
                    <p className={styles.empty}>Снимки цен не найдены</p>
                ) : (
                    <ul className={styles.list}>
                        {snapshots.map((snap) => (
                            <li key={snap.id} className={styles.item}>
                                <div className={styles.itemInfo}>
                                    <span className={styles.time}>{formatRelativeTime(snap.created_at)}</span>
                                    <span className={styles.source}>{snap.source || '—'}</span>
                                    <span className={styles.count}>{snap.items_count} товаров</span>
                                </div>
                                <button
                                    className={`secondary-btn ${styles.rollbackBtn}`}
                                    onClick={() => setRollbackTarget(snap)}
                                    disabled={rolling}
                                >
                                    Откатить
                                </button>
                            </li>
                        ))}
                    </ul>
                )}
            </Modal>

            <ConfirmDialog
                isOpen={rollbackTarget !== null}
                title="Откат цен"
                message={
                    rollbackTarget
                        ? `Восстановить цены из снимка "${rollbackTarget.source || 'без имени'}" (${rollbackTarget.items_count} товаров, ${formatRelativeTime(rollbackTarget.created_at)})?`
                        : ''
                }
                confirmText="Откатить"
                cancelText="Отмена"
                variant="danger"
                onConfirm={handleRollback}
                onCancel={() => setRollbackTarget(null)}
            />
        </>
    );
}
