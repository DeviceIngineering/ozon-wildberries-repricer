import { useState, useEffect, useCallback, useRef } from 'react';
import ReactDOM from 'react-dom';
import ax from 'axios';
const axios = ax.create({ withCredentials: true });
import { useToast } from '../../contexts/ToastContext';
import styles from './RepricerLogModal.module.css';
import { apiErrorMessage } from '../../services/apiError';

interface RepricerLogModalProps {
  storeId: string;
  storeName: string;
  onClose: () => void;
}

interface RepricerLogEntry {
  id: number;
  timestamp: string;
  offer_id: string;
  product_name: string;
  old_price: number;
  new_price: number;
  deviation_percent: number;
  ref_price: number | null;
  action: string;
  reason: string | null;
}

interface LogsResponse {
  rows: RepricerLogEntry[];
  total: number;
  page: number;
  totalPages: number;
}

type SortField = 'timestamp' | 'offer_id' | 'old_price' | 'new_price' | 'deviation_percent';

const ACTION_OPTIONS = [
  { value: '', label: 'Все' },
  { value: 'corrected', label: 'corrected' },
  { value: 'skipped', label: 'skipped' },
  { value: 'minor_drop', label: 'minor_drop' },
  { value: 'ok', label: 'ok' },
];

const PERIOD_OPTIONS = [
  { value: 'today', label: '24h' },
  { value: 'week', label: '7d' },
  { value: 'month', label: '30d' },
];

const LIMIT_OPTIONS = [50, 100, 200, 500];

const COLUMNS: { key: string; label: string; sortable: boolean; sortKey?: SortField }[] = [
  { key: 'time', label: 'Время', sortable: true, sortKey: 'timestamp' },
  { key: 'offer_id', label: 'Артикул', sortable: true, sortKey: 'offer_id' },
  { key: 'name', label: 'Товар', sortable: false },
  { key: 'price', label: 'Цена', sortable: true, sortKey: 'new_price' },
  { key: 'dev', label: 'Δ%', sortable: true, sortKey: 'deviation_percent' },
  { key: 'ref', label: 'Реф', sortable: false },
  { key: 'action', label: 'Действие', sortable: false },
  { key: 'reason', label: 'Причина', sortable: false },
];

export default function RepricerLogModal({ storeId, storeName, onClose }: RepricerLogModalProps) {
  const { showError } = useToast();
  const searchRef = useRef<HTMLInputElement>(null);

  const [action, setAction] = useState('');
  const [period, setPeriod] = useState('today');
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(100);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [sort, setSort] = useState<SortField>('timestamp');
  const [order, setOrder] = useState<'asc' | 'desc'>('desc');

  const [loading, setLoading] = useState(false);
  const [logs, setLogs] = useState<RepricerLogEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [expandedId, setExpandedId] = useState<number | null>(null);

  // Debounced search
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await axios.get<LogsResponse>(
        `/api/stores/${storeId}/repricer-logs`,
        { params: { action: action || undefined, period, page, limit, search: search || undefined, sort, order } }
      );
      setLogs(data.rows);
      setTotal(data.total);
    } catch (err) {
      showError(apiErrorMessage(err, 'Ошибка загрузки логов'));
      setLogs([]);
    } finally {
      setLoading(false);
    }
  }, [storeId, action, period, page, limit, search, sort, order, showError]);

  useEffect(() => { fetchLogs(); }, [fetchLogs]);
  useEffect(() => { setPage(1); }, [action, period, search, limit]);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') {
        e.preventDefault();
        searchRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const totalPages = Math.max(1, Math.ceil(total / limit));

  const handleSort = (field: SortField) => {
    if (sort === field) {
      setOrder(o => o === 'desc' ? 'asc' : 'desc');
    } else {
      setSort(field);
      setOrder('desc');
    }
  };

  const fmtTime = (d: string) => {
    const dt = new Date(d);
    return dt.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const fmtPrice = (v: number) => v.toLocaleString('ru-RU');
  const fmtDev = (v: number) => (v > 0 ? `+${v.toFixed(1)}%` : `${v.toFixed(1)}%`);

  return ReactDOM.createPortal(
    <div className={styles.overlay} onClick={onClose}>
      <div className={styles.container} onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className={styles.header}>
          <span className={styles.headerTitle}>repricer-log :: {storeName}</span>
          <span className={styles.kbdHint}>/ search · esc close</span>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Toolbar */}
        <div className={styles.toolbar}>
          <div className={styles.searchWrap}>
            <span className={styles.searchIcon}>/</span>
            <input
              ref={searchRef}
              className={styles.searchInput}
              placeholder="grep артикул, название..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
            />
          </div>
          <select className={styles.select} value={action} onChange={e => setAction(e.target.value)}>
            {ACTION_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select className={styles.select} value={period} onChange={e => setPeriod(e.target.value)}>
            {PERIOD_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <select className={styles.select} value={limit} onChange={e => setLimit(Number(e.target.value))}>
            {LIMIT_OPTIONS.map(n => <option key={n} value={n}>{n}/стр</option>)}
          </select>
          <span className={styles.statsText}>{total.toLocaleString('ru-RU')} записей</span>
        </div>

        {/* Table */}
        {loading ? (
          <div className={styles.loading}><span className={styles.spinner} />загрузка...</div>
        ) : logs.length === 0 ? (
          <div className={styles.empty}>нет записей</div>
        ) : (
          <div className={styles.tableArea}>
            <table className={styles.table}>
              <thead>
                <tr>
                  {COLUMNS.map(col => (
                    <th
                      key={col.key}
                      className={col.sortable && sort === col.sortKey ? styles.thActive : undefined}
                      onClick={() => col.sortable && col.sortKey && handleSort(col.sortKey)}
                    >
                      {col.label}
                      {col.sortable && sort === col.sortKey && (
                        <span className={styles.sortArrow}>{order === 'asc' ? '▲' : '▼'}</span>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {logs.map(log => (
                  <>
                    <tr
                      key={log.id}
                      className={log.action === 'corrected' ? styles.rowCorrected : log.action === 'ok' ? styles.rowOk : log.action === 'minor_drop' ? styles.rowMinorDrop : styles.rowSkipped}
                      onClick={() => setExpandedId(prev => prev === log.id ? null : log.id)}
                    >
                      <td>{fmtTime(log.timestamp)}</td>
                      <td>{log.offer_id}</td>
                      <td title={log.product_name} style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {log.product_name}
                      </td>
                      <td>
                        {fmtPrice(log.old_price)}
                        <span className={styles.priceArrow}>&rarr;</span>
                        {fmtPrice(log.new_price)}
                      </td>
                      <td className={log.deviation_percent > 0 ? styles.devUp : log.deviation_percent < 0 ? styles.devDown : ''}>
                        {fmtDev(log.deviation_percent)}
                      </td>
                      <td>{log.ref_price != null ? fmtPrice(log.ref_price) : '—'}</td>
                      <td className={log.action === 'corrected' ? styles.badgeCorrected : log.action === 'ok' ? styles.badgeOk : log.action === 'minor_drop' ? styles.badgeMinorDrop : styles.badgeSkipped}>
                        {log.action}
                      </td>
                      <td className={styles.reasonCell} title={log.reason || ''}>
                        {log.reason || ''}
                      </td>
                    </tr>
                    {expandedId === log.id && log.reason && (
                      <tr key={`exp-${log.id}`} className={styles.expandedRow}>
                        <td colSpan={8}>
                          <div className={styles.expandedContent}>{log.reason}</div>
                        </td>
                      </tr>
                    )}
                  </>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Pagination */}
        <div className={styles.pagination}>
          <span className={styles.pageInfo}>стр {page}/{totalPages}</span>
          <div className={styles.pageControls}>
            <button className={styles.pageBtn} disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
              prev
            </button>
            <button className={styles.pageBtn} disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>
              next
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
