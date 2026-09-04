import { useState, useEffect, useCallback } from 'react';
import ax from 'axios';
import Modal from '../ui/Modal';
const axios = ax.create({ withCredentials: true });
import { useToast } from '../../contexts/ToastContext';
import styles from './ApiLogsModal.module.css';

interface ApiLogsModalProps {
  storeId: string;
  storeName: string;
  onClose: () => void;
}

interface LogEntry {
  id: number;
  timestamp: string;
  endpoint: string;
  source: string;
  status_code: number;
  duration_ms: number;
  items_count: number;
  request_summary: string | null;
  response_summary: string | null;
  error_message: string | null;
}

interface LogsResponse {
  rows: LogEntry[];
  total: number;
  page: number;
  totalPages: number;
}

const PAGE_SIZE = 50;

const SOURCE_OPTIONS = [
  { value: '', label: 'Все источники' },
  { value: 'manual', label: 'Ручной' },
  { value: 'repricer', label: 'Repricer' },
  { value: 'sync', label: 'Синхронизация' },
  { value: 'import', label: 'Импорт' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'Все статусы' },
  { value: 'success', label: 'Успешные' },
  { value: 'error', label: 'Ошибки' },
];

const PERIOD_OPTIONS = [
  { value: '', label: 'Все время' },
  { value: 'today', label: 'Сегодня' },
  { value: 'week', label: 'Неделя' },
  { value: 'month', label: 'Месяц' },
];

export default function ApiLogsModal({ storeId, storeName, onClose }: ApiLogsModalProps) {
  const { showError } = useToast();

  const [source, setSource] = useState('');
  const [status, setStatus] = useState('');
  const [period, setPeriod] = useState('');
  const [page, setPage] = useState(1);

  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [total, setTotal] = useState(0);

  const [expandedId, setExpandedId] = useState<number | null>(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await axios.get<LogsResponse>(
        `/api/stores/${storeId}/api-logs`,
        { params: { source: source || undefined, status: status || undefined, period: period || undefined, page } }
      );
      setLogs(data.rows);
      setTotal(data.total);
    } catch (err: any) {
      showError(err?.response?.data?.error || 'Ошибка загрузки логов');
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [storeId, source, status, period, page, showError]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Reset page on filter change
  useEffect(() => {
    setPage(1);
  }, [source, status, period]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const fmtDate = (d: string) => {
    const dt = new Date(d);
    return dt.toLocaleString('ru-RU', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  };

  const statusClass = (code: number) => {
    if (code >= 200 && code < 300) return styles.statusOk;
    if (code >= 400) return styles.statusError;
    return styles.statusWarn;
  };

  const toggleExpand = (id: number) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <Modal isOpen onClose={onClose} title={`API логи — ${storeName}`}>
      {/* Filters */}
      <div className={styles.filters}>
        <select className={styles.select} value={source} onChange={(e) => setSource(e.target.value)}>
          {SOURCE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select className={styles.select} value={status} onChange={(e) => setStatus(e.target.value)}>
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <select className={styles.select} value={period} onChange={(e) => setPeriod(e.target.value)}>
          {PERIOD_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      {loading ? (
        <div className={styles.loading}>
          <span className={styles.spinner} />
          Загрузка...
        </div>
      ) : logs.length === 0 ? (
        <div className={styles.empty}>Нет записей</div>
      ) : (
        <>
          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Время</th>
                  <th>Endpoint</th>
                  <th>Источник</th>
                  <th>Статус</th>
                  <th>Время, мс</th>
                  <th>Позиций</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <>
                    <tr key={log.id} onClick={() => toggleExpand(log.id)}>
                      <td>{fmtDate(log.timestamp)}</td>
                      <td
                        title={log.endpoint}
                        style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis' }}
                      >
                        {log.endpoint}
                      </td>
                      <td>{log.source}</td>
                      <td className={statusClass(log.status_code)}>{log.status_code}</td>
                      <td>{log.duration_ms}</td>
                      <td>{log.items_count}</td>
                    </tr>

                    {expandedId === log.id && (
                      <tr key={`exp-${log.id}`} className={styles.expandedRow}>
                        <td colSpan={6}>
                          <div className={styles.expandedContent}>
                            {log.request_summary && (
                              <div className={styles.detailBlock}>
                                <span className={styles.detailLabel}>Запрос</span>
                                <div className={styles.detailValue}>
                                  {log.request_summary}
                                </div>
                              </div>
                            )}
                            {log.response_summary && (
                              <div className={styles.detailBlock}>
                                <span className={styles.detailLabel}>Ответ</span>
                                <div className={styles.detailValue}>
                                  {log.response_summary}
                                </div>
                              </div>
                            )}
                            {log.error_message && (
                              <div className={styles.detailBlock}>
                                <span className={styles.detailLabel}>Ошибка</span>
                                <div className={`${styles.detailValue} ${styles.errorValue}`}>
                                  {log.error_message}
                                </div>
                              </div>
                            )}
                            {!log.request_summary && !log.response_summary && !log.error_message && (
                              <div className={styles.empty} style={{ padding: '8px 0' }}>
                                Нет дополнительных данных
                              </div>
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

          {/* Pagination */}
          <div className={styles.pagination}>
            <button
              className={styles.pageBtn}
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              ← Назад
            </button>
            <span className={styles.pageInfo}>
              {page} / {totalPages} (всего {total})
            </span>
            <button
              className={styles.pageBtn}
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Вперёд →
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
