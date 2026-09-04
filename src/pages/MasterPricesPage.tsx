import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import PlatformBadge from '../components/PlatformBadge';
import Pagination from '../components/ui/Pagination';
import Modal from '../components/ui/Modal';
import { useToast } from '../contexts/ToastContext';
import {
  fetchMasterGroups,
  saveMasterPrice,
  applyMasterPrices,
  type MasterGroup,
  type ApplyResponse,
} from '../services/masterPricesApi';
import styles from './MasterPricesPage.module.css';

const money = (v: number | string | null | undefined): string => {
  if (v == null || v === '' || v === '0') return '—';
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return '—';
  return `${Math.round(n).toLocaleString('ru-RU')} ₽`;
};

const REASON_LABEL: Record<string, string> = {
  below_cost: 'ниже себестоимости',
  archived: 'архив',
  bad_master: 'нет мастер-цены',
  send_failed: 'ошибка отправки',
  derive_failed: 'ошибка расчёта',
};

export default function MasterPricesPage() {
  const { showSuccess, showError } = useToast();

  const [groups, setGroups] = useState<MasterGroup[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(false);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Черновики мастер-цены по offer_id (редактирование инпута до сохранения).
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const [preview, setPreview] = useState<ApplyResponse | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [sending, setSending] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchMasterGroups({ page, pageSize, search });
      setGroups(res.items);
      setTotal(res.total);
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Ошибка загрузки');
    } finally {
      setLoading(false);
    }
  }, [page, pageSize, search, showError]);

  useEffect(() => { load(); }, [load]);

  // Debounce поиска.
  useEffect(() => {
    const t = setTimeout(() => { setSearch(searchInput.trim()); setPage(1); }, 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  const toggleExpand = (offerId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(offerId)) next.delete(offerId); else next.add(offerId);
      return next;
    });
  };

  const toggleSelect = (offerId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(offerId)) next.delete(offerId); else next.add(offerId);
      return next;
    });
  };

  const allOnPageSelected = groups.length > 0 && groups.every((g) => selected.has(g.offer_id));
  const toggleSelectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPageSelected) groups.forEach((g) => next.delete(g.offer_id));
      else groups.forEach((g) => next.add(g.offer_id));
      return next;
    });
  };

  const masterValue = (g: MasterGroup): string => {
    if (drafts[g.offer_id] !== undefined) return drafts[g.offer_id];
    return g.master_price != null ? String(Math.round(g.master_price)) : '';
  };

  const handleSaveMaster = async (g: MasterGroup) => {
    const raw = drafts[g.offer_id];
    if (raw === undefined) return;
    const val = Number(raw);
    if (!(val > 0)) { showError('Мастер-цена должна быть > 0'); return; }
    if (val === Math.round(g.master_price ?? -1)) { // без изменений
      setDrafts((d) => { const n = { ...d }; delete n[g.offer_id]; return n; });
      return;
    }
    try {
      await saveMasterPrice(g.offer_id, val);
      setGroups((prev) => prev.map((x) => x.offer_id === g.offer_id ? { ...x, master_price: val } : x));
      setDrafts((d) => { const n = { ...d }; delete n[g.offer_id]; return n; });
      showSuccess(`Мастер-цена ${g.offer_id} сохранена`);
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Ошибка сохранения');
    }
  };

  const selectedItems = useMemo(
    () => groups.filter((g) => selected.has(g.offer_id)).map((g) => ({
      offer_id: g.offer_id,
      master_price: drafts[g.offer_id] !== undefined ? Number(drafts[g.offer_id]) : (g.master_price ?? undefined),
    })).filter((it) => it.master_price && it.master_price > 0),
    [groups, selected, drafts]
  );

  const handlePreview = async () => {
    if (selectedItems.length === 0) {
      showError('Выберите изделия с заданной мастер-ценой');
      return;
    }
    try {
      const res = await applyMasterPrices(selectedItems, { dry_run: true });
      setPreview(res);
      setPreviewOpen(true);
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Ошибка предпросмотра');
    }
  };

  const handleSend = async () => {
    setSending(true);
    try {
      const res = await applyMasterPrices(selectedItems, { dry_run: false });
      const sent = res.summary.stores_sent ?? 0;
      const failed = res.summary.stores_failed ?? 0;
      if (failed > 0) showError(`Отправлено магазинов: ${sent}, с ошибкой: ${failed}`);
      else showSuccess(`Цены отправлены. Магазинов: ${sent}`);
      setPreviewOpen(false);
      setSelected(new Set());
      setDrafts({});
      load();
    } catch (e) {
      showError(e instanceof Error ? e.message : 'Ошибка отправки');
    } finally {
      setSending(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.title}>Управление ценами</h1>
        <div className={styles.actions}>
          <input
            className={styles.search}
            placeholder="Поиск по артикулу или названию"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
          <button
            className={styles.primaryBtn}
            onClick={handlePreview}
            disabled={selected.size === 0}
          >
            Проверить и отправить{selected.size > 0 ? ` (${selected.size})` : ''}
          </button>
        </div>
      </div>

      <div className={styles.tableWrap}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.chkCol}>
                <input type="checkbox" checked={allOnPageSelected} onChange={toggleSelectAll} />
              </th>
              <th className={styles.expandCol}></th>
              <th>Товар</th>
              <th>Магазины</th>
              <th className={styles.num}>Себестоимость</th>
              <th className={styles.num}>Мастер-цена</th>
              <th>Артикул</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={7} className={styles.empty}>Загрузка…</td></tr>
            )}
            {!loading && groups.length === 0 && (
              <tr><td colSpan={7} className={styles.empty}>Ничего не найдено</td></tr>
            )}
            {!loading && groups.map((g) => {
              const isOpen = expanded.has(g.offer_id);
              const belowCost = g.cost_price != null && g.master_price != null && g.master_price < g.cost_price;
              return (
                <Fragment key={g.offer_id}>
                  <tr className={styles.groupRow}>
                    <td className={styles.chkCol}>
                      <input
                        type="checkbox"
                        checked={selected.has(g.offer_id)}
                        onChange={() => toggleSelect(g.offer_id)}
                      />
                    </td>
                    <td className={styles.expandCol}>
                      <button className={styles.expandBtn} onClick={() => toggleExpand(g.offer_id)}>
                        {isOpen ? '▾' : '▸'}
                      </button>
                    </td>
                    <td>
                      <div className={styles.product}>
                        {g.image
                          ? <img className={styles.thumb} src={g.image} alt="" />
                          : <span className={styles.thumbEmpty}>—</span>}
                        <span className={styles.name} title={g.name ?? ''}>{g.name ?? '—'}</span>
                      </div>
                    </td>
                    <td>
                      <div className={styles.badges}>
                        {g.stores.map((s) => (
                          <PlatformBadge key={s.store_id} platform={s.platform} title={s.store_name} />
                        ))}
                        <span className={styles.count}>{g.stores_count}</span>
                      </div>
                    </td>
                    <td className={styles.num}>{money(g.cost_price)}</td>
                    <td className={styles.num}>
                      <input
                        className={`${styles.priceInput} ${belowCost ? styles.priceDanger : ''}`}
                        value={masterValue(g)}
                        onChange={(e) => setDrafts((d) => ({ ...d, [g.offer_id]: e.target.value.replace(/[^\d.]/g, '') }))}
                        onBlur={() => handleSaveMaster(g)}
                        onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); }}
                        inputMode="decimal"
                      />
                    </td>
                    <td className={styles.offer}>{g.offer_id}</td>
                  </tr>
                  {isOpen && g.stores.map((s) => (
                    <tr key={`${g.offer_id}-${s.store_id}`} className={styles.storeRow}>
                      <td></td>
                      <td></td>
                      <td className={styles.storeName}>
                        <PlatformBadge platform={s.platform} />
                        <span>{s.store_name}</span>
                        {s.is_archived ? <span className={styles.tagArchive}>архив</span> : null}
                      </td>
                      <td className={styles.storeMeta}>
                        {s.platform === 'wildberries'
                          ? `скидка ${s.wb_discount ?? 0}%`
                          : `остаток FBO: ${s.stocks_fbo ?? 0}`}
                      </td>
                      <td className={styles.num}>{money(s.cost_price)}</td>
                      <td className={styles.num}>{money(s.price)}</td>
                      <td className={styles.offer}>{s.ozon_id ?? '—'}</td>
                    </tr>
                  ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <Pagination
        totalItems={total}
        currentPage={page}
        pageSize={pageSize}
        onPageChange={setPage}
        onPageSizeChange={(s) => { setPageSize(s); setPage(1); }}
      />

      <Modal isOpen={previewOpen} onClose={() => setPreviewOpen(false)} title="Проверка перед отправкой">
        {preview && (
          <div className={styles.preview}>
            <p className={styles.previewHint}>
              Будет отправлено во все магазины выбранных изделий. Строки с пометкой не отправляются.
            </p>
            <table className={styles.previewTable}>
              <thead>
                <tr>
                  <th>Изделие / магазин</th>
                  <th className={styles.num}>Было</th>
                  <th className={styles.num}>Станет</th>
                  <th className={styles.num}>Скидка</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {preview.results.map((g) => (
                  <Fragment key={g.offer_id}>
                    <tr className={styles.previewGroup}>
                      <td colSpan={5}>{g.offer_id} — мастер {money(g.master_price)}</td>
                    </tr>
                    {g.stores.map((s, i) => (
                      <tr key={`${g.offer_id}-${i}`}>
                        <td className={styles.previewStore}>
                          <PlatformBadge platform={s.platform} /> {s.store_name}
                        </td>
                        <td className={styles.num}>{money(s.before.price)}</td>
                        <td className={styles.num}>{s.after ? money(s.after.buyerPrice) : '—'}</td>
                        <td className={styles.num}>{s.after ? `${s.after.discountPercent}%` : '—'}</td>
                        <td>
                          {s.ok && !s.reason
                            ? <span className={styles.okTag}>✓</span>
                            : <span className={styles.skipTag}>{REASON_LABEL[s.reason ?? ''] ?? s.reason ?? 'пропуск'}</span>}
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
            <div className={styles.previewActions}>
              <button className={styles.secondaryBtn} onClick={() => setPreviewOpen(false)} disabled={sending}>
                Отмена
              </button>
              <button className={styles.primaryBtn} onClick={handleSend} disabled={sending}>
                {sending ? 'Отправка…' : 'Отправить в магазины'}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
