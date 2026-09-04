import { useState, useEffect, useCallback } from 'react';
import ax from 'axios';
import Modal from '../ui/Modal';
const axios = ax.create({ withCredentials: true });
import { useToast } from '../../contexts/ToastContext';
import styles from './PriceHistoryModal.module.css';

interface PriceHistoryModalProps {
  storeId: string;
  storeName: string;
  onClose: () => void;
}

type TabKey = 'manual' | 'repricer';

interface Snapshot {
  id: number;
  created_at: string;
  source: string;
  items_count: number;
  category: string;
  comment: string | null;
}

interface SnapshotItem {
  offer_id: string;
  price: number;
  old_price?: number;
  min_price?: number;
  new_price?: number;
}

export default function PriceHistoryModal({ storeId, storeName, onClose }: PriceHistoryModalProps) {
  const { showSuccess, showError } = useToast();

  const [tab, setTab] = useState<TabKey>('manual');
  const [loading, setLoading] = useState(false);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);

  // Expand / compare
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [expandedItems, setExpandedItems] = useState<SnapshotItem[]>([]);
  const [expandLoading, setExpandLoading] = useState(false);

  // Rollback confirm
  const [rollbackId, setRollbackId] = useState<number | null>(null);
  const [rollbackLoading, setRollbackLoading] = useState(false);

  const fetchSnapshots = useCallback(async (category: TabKey) => {
    setLoading(true);
    setExpandedId(null);
    setExpandedItems([]);
    try {
      const { data } = await axios.get<Snapshot[]>(
        `/api/stores/${storeId}/snapshots`,
        { params: { category } }
      );
      setSnapshots(data);
    } catch (err: any) {
      showError(err?.response?.data?.error || 'Ошибка загрузки снапшотов');
      setSnapshots([]);
    } finally {
      setLoading(false);
    }
  }, [storeId, showError]);

  useEffect(() => {
    fetchSnapshots(tab);
  }, [tab, fetchSnapshots]);

  const handleCompare = async (snapshotId: number) => {
    if (expandedId === snapshotId) {
      setExpandedId(null);
      setExpandedItems([]);
      return;
    }
    setExpandLoading(true);
    setExpandedId(snapshotId);
    try {
      const { data } = await axios.get(`/api/stores/${storeId}/snapshots/${snapshotId}`);
      const json = typeof data.snapshot_json === 'string' ? JSON.parse(data.snapshot_json) : (data.snapshot_json ?? []);
      setExpandedItems(json);
    } catch {
      showError('Не удалось загрузить данные снапшота');
      setExpandedItems([]);
    } finally {
      setExpandLoading(false);
    }
  };

  const handleRollback = async () => {
    if (rollbackId == null) return;
    setRollbackLoading(true);
    try {
      await axios.post(`/api/stores/${storeId}/snapshots/${rollbackId}/rollback`);
      showSuccess('Откат выполнен');
      setRollbackId(null);
      fetchSnapshots(tab);
    } catch (err: any) {
      showError(err?.response?.data?.error || 'Ошибка отката');
    } finally {
      setRollbackLoading(false);
    }
  };

  const fmtDate = (d: string) => {
    const dt = new Date(d);
    return dt.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <Modal isOpen onClose={onClose} title={`История цен — ${storeName}`}>
      {/* Tabs */}
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${tab === 'manual' ? styles.tabActive : ''}`}
          onClick={() => setTab('manual')}
        >
          Ручные изменения
        </button>
        <button
          className={`${styles.tab} ${tab === 'repricer' ? styles.tabActive : ''}`}
          onClick={() => setTab('repricer')}
        >
          Repricer
        </button>
      </div>

      {loading ? (
        <div className={styles.loading}>
          <span className={styles.spinner} />
          Загрузка...
        </div>
      ) : snapshots.length === 0 ? (
        <div className={styles.empty}>Нет записей</div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th>Дата</th>
                <th>Источник</th>
                <th>Позиций</th>
                <th>Комментарий</th>
                <th>Действия</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <>
                  <tr key={s.id}>
                    <td>{fmtDate(s.created_at)}</td>
                    <td>{s.source}</td>
                    <td>{s.items_count}</td>
                    <td
                      title={s.comment ?? ''}
                      style={{
                        maxWidth: 140,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                    >
                      {s.comment || '—'}
                    </td>
                    <td>
                      <div className={styles.actionsCell}>
                        <button
                          className={styles.actionBtn}
                          onClick={() => handleCompare(s.id)}
                        >
                          {expandedId === s.id ? 'Скрыть' : 'Сравнить'}
                        </button>
                        <button
                          className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
                          onClick={() => setRollbackId(s.id)}
                        >
                          Откат
                        </button>
                      </div>
                    </td>
                  </tr>

                  {/* Expanded comparison */}
                  {expandedId === s.id && (
                    <tr key={`exp-${s.id}`} className={styles.expandedRow}>
                      <td colSpan={5}>
                        <div className={styles.expandedContent}>
                          {expandLoading ? (
                            <div className={styles.loading}>
                              <span className={styles.spinner} />
                              Загрузка деталей...
                            </div>
                          ) : expandedItems.length === 0 ? (
                            <div className={styles.empty}>Нет данных</div>
                          ) : (
                            <table className={styles.subTable}>
                              <thead>
                                <tr>
                                  <th>Артикул</th>
                                  <th>Цена</th>
                                  <th>Старая цена</th>
                                  <th>Мин. цена</th>
                                </tr>
                              </thead>
                              <tbody>
                                {expandedItems.map((item) => (
                                  <tr key={item.offer_id}>
                                    <td>{item.offer_id}</td>
                                    <td>{Number(item.price || 0).toLocaleString('ru-RU')} ₽</td>
                                    <td>{item.old_price ? Number(item.old_price).toLocaleString('ru-RU') + ' ₽' : '—'}</td>
                                    <td>{item.min_price ? Number(item.min_price).toLocaleString('ru-RU') + ' ₽' : '—'}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          )}
                        </div>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Rollback confirm */}
      {rollbackId != null && (
        <div className={styles.confirmOverlay} onClick={() => setRollbackId(null)}>
          <div className={styles.confirmBox} onClick={(e) => e.stopPropagation()}>
            <div className={styles.confirmText}>
              Откатить цены к снапшоту #{rollbackId}? Текущие цены будут заменены.
            </div>
            <div className={styles.confirmActions}>
              <button
                className={styles.confirmYes}
                disabled={rollbackLoading}
                onClick={handleRollback}
              >
                {rollbackLoading ? 'Откат...' : 'Откатить'}
              </button>
              <button
                className={styles.confirmNo}
                onClick={() => setRollbackId(null)}
              >
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
