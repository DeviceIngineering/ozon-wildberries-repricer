import { useState, useRef, useCallback, type DragEvent, type ChangeEvent } from 'react';
import ax from 'axios';
import Modal from '../ui/Modal';

const axios = ax.create({ withCredentials: true });
import Tooltip from '../ui/Tooltip';
import { useToast } from '../../contexts/ToastContext';
import styles from './PriceImportModal.module.css';

interface PriceImportModalProps {
  storeId: string;
  storeName: string;
  platform?: string;
  onClose: () => void;
}

interface PreviewItem {
  offer_id: string;
  name: string;
  currentPrice: number;
  newPrice: number;
  oldPrice: number | null;
  minPrice: number | null;
  costPrice: number | null;
  deviationPercent: number;
  refPrice: number | null;
  deviationFromRef: number | null;
  blocked: boolean;
}

interface MissingProduct {
  offer_id: string;
  name: string;
}

interface PreviewData {
  totalInFile: number;
  totalInCatalog: number;
  matchedCount: number;
  missingInFile: number;
  notFoundInCatalog: number;
  blockedCount: number;
  items: PreviewItem[];
  missingProducts: MissingProduct[];
  unknownOfferIds: string[];
  originalFilename: string;
  importId: number;
}

type Step = 'upload' | 'preview' | 'result';
type Filter = 'all' | 'blocked' | 'missing' | 'unknown';

export default function PriceImportModal({ storeId, storeName, platform = 'ozon', onClose }: PriceImportModalProps) {
  const { showSuccess, showError } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [step, setStep] = useState<Step>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [loading, setLoading] = useState(false);

  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [unlocked, setUnlocked] = useState<Set<string>>(new Set());
  const [confirmUnlock, setConfirmUnlock] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const [resultMessage, setResultMessage] = useState('');
  const [resultCount, setResultCount] = useState(0);

  const [autoMinPrice, setAutoMinPrice] = useState(true);
  const [autoMinPercent, setAutoMinPercent] = useState(50);

  const BLOCK_THRESHOLD = 20;
  const platformLabel = platform === 'yandex' ? 'Яндекс' : platform === 'wildberries' ? 'Wildberries' : 'Озон';
  // WB: импорт только задаёт эталон (РРЦ+себестоимость), цены на площадку выставляет репрайсер
  // парой price+discount — поэтому кнопка прямой отправки не показывается.
  const canSendToPlatform = platform !== 'wildberries';

  const isBlocked = useCallback(
    (item: PreviewItem) =>
      Math.abs(item.deviationPercent) > BLOCK_THRESHOLD && !unlocked.has(item.offer_id),
    [unlocked]
  );

  /* ---------- Step 1: Upload ---------- */

  const handleDrag = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === 'dragenter' || e.type === 'dragover') setDragActive(true);
    if (e.type === 'dragleave') setDragActive(false);
  };

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    const f = e.dataTransfer.files?.[0];
    if (f && (f.name.endsWith('.xlsx') || f.name.endsWith('.xls'))) {
      setFile(f);
    } else {
      showError('Допустимые форматы: .xlsx, .xls');
    }
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0] ?? null;
    if (f) setFile(f);
  };

  const handleUpload = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await axios.post<PreviewData>(
        `/api/stores/${storeId}/price-import/preview`,
        fd,
        { headers: { 'Content-Type': 'multipart/form-data' } }
      );
      setPreview(data);
      const sel = new Set<string>();
      data.items.forEach((item) => {
        if (Math.abs(item.deviationPercent) <= BLOCK_THRESHOLD) {
          sel.add(item.offer_id);
        }
      });
      setSelected(sel);
      setStep('preview');
    } catch (err: any) {
      showError(err?.response?.data?.error || 'Ошибка при загрузке файла');
    } finally {
      setLoading(false);
    }
  };

  /* ---------- Step 2: Preview ---------- */

  const toggleSelect = (offerId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(offerId)) next.delete(offerId);
      else next.add(offerId);
      return next;
    });
  };

  const handleUnlockConfirm = (offerId: string) => {
    setUnlocked((prev) => new Set(prev).add(offerId));
    setSelected((prev) => new Set(prev).add(offerId));
    setConfirmUnlock(null);
  };

  const handleUnlockAll = () => {
    if (!preview) return;
    const newUnlocked = new Set(unlocked);
    const newSelected = new Set(selected);
    for (const item of preview.items) {
      if (Math.abs(item.deviationPercent) > BLOCK_THRESHOLD) {
        newUnlocked.add(item.offer_id);
        newSelected.add(item.offer_id);
      }
    }
    setUnlocked(newUnlocked);
    setSelected(newSelected);
  };

  const handleSelectAll = () => {
    if (!preview) return;
    const newSelected = new Set<string>();
    for (const item of preview.items) {
      if (!isBlocked(item)) newSelected.add(item.offer_id);
    }
    setSelected(newSelected);
  };

  const handleDeselectAll = () => {
    setSelected(new Set());
  };

  const toggleFilter = (f: Filter) => {
    setFilter(prev => prev === f ? 'all' : f);
  };

  const filteredItems = preview?.items.filter((item) => {
    if (filter === 'blocked') return isBlocked(item);
    return true;
  }) ?? [];

  const computeMinPrice = (item: PreviewItem): number | null => {
    if (item.minPrice && item.minPrice > 0) return item.minPrice;
    if (autoMinPrice) return Math.ceil(item.newPrice * autoMinPercent / 100);
    return null;
  };

  const getSelectedItems = () => {
    if (!preview) return [];
    return preview.items
      .filter((i) => selected.has(i.offer_id))
      .map((i) => ({
        offer_id: i.offer_id,
        newPrice: i.newPrice,
        currentPrice: i.currentPrice,
        oldPrice: i.oldPrice,
        minPrice: computeMinPrice(i),
        costPrice: i.costPrice,
      }));
  };

  const handleSaveRefOnly = async () => {
    if (!preview || selected.size === 0) return;
    setLoading(true);
    try {
      // Server-side: шлём только выбор + importId (крошечное тело, без лимита на 1000+ строк).
      // Сервер перечитывает уже загруженный файл и берёт из него цены/себестоимость.
      const { data } = await axios.post(`/api/stores/${storeId}/price-import/ref-only-server`, {
        importId: preview.importId,
        offerIds: [...selected],
        autoMinPercent: autoMinPrice ? autoMinPercent : 0,
      });
      const count = data.saved_count ?? selected.size;
      setResultMessage('Эталонные цены сохранены');
      setResultCount(count);
      setStep('result');
      showSuccess(`Эталонные цены сохранены: ${count} позиций`);
    } catch (err: any) {
      showError(err?.response?.data?.error || 'Ошибка сохранения');
    } finally {
      setLoading(false);
    }
  };

  const handleSaveAndSend = async () => {
    const items = getSelectedItems();
    if (items.length === 0) return;
    setLoading(true);
    try {
      const { data } = await axios.post(`/api/stores/${storeId}/price-import`, {
        items,
        originalFilename: preview?.originalFilename,
      });
      setResultMessage(`Цены сохранены и отправлены в ${platformLabel}`);
      setResultCount(data.sent_count || items.length);
      setStep('result');
      showSuccess(`Отправлено в ${platformLabel}: ${data.sent_count || items.length} позиций`);
    } catch (err: any) {
      showError(err?.response?.data?.error || 'Ошибка отправки');
    } finally {
      setLoading(false);
    }
  };

  /* ---------- Helpers ---------- */

  const fmtDev = (val: number) => (val > 0 ? `+${val.toFixed(1)}%` : `${val.toFixed(1)}%`);

  const devClass = (val: number) => {
    if (val > 0) return styles.deviationUp;
    if (val < 0) return styles.deviationDown;
    return styles.deviationNeutral;
  };

  const stepLabel = (s: Step, idx: number, label: string) => {
    const steps: Step[] = ['upload', 'preview', 'result'];
    const current = steps.indexOf(step);
    const cls =
      steps.indexOf(s) < current
        ? styles.stepDone
        : s === step
          ? styles.stepActive
          : '';
    return (
      <span className={`${styles.step} ${cls}`}>
        {idx}. {label}
      </span>
    );
  };

  const blockedCount = preview?.items.filter((i) => isBlocked(i)).length ?? 0;
  const allSelected = preview ? selected.size === preview.items.length - blockedCount : false;

  /* ---------- Render ---------- */

  return (
    <Modal isOpen onClose={onClose} title={`Импорт цен — ${storeName}`}>
      <div className={styles.steps}>
        {stepLabel('upload', 1, 'Загрузка')}
        <span className={styles.stepSep}>&rsaquo;</span>
        {stepLabel('preview', 2, 'Просмотр')}
        <span className={styles.stepSep}>&rsaquo;</span>
        {stepLabel('result', 3, 'Результат')}
      </div>

      {/* STEP 1 — Upload */}
      {step === 'upload' && (
        <>
          <div
            className={`${styles.dropZone} ${dragActive ? styles.dropZoneActive : ''}`}
            onDragEnter={handleDrag}
            onDragOver={handleDrag}
            onDragLeave={handleDrag}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
          >
            <span className={styles.dropIcon}>📄</span>
            <span className={styles.dropText}>Перетащите файл или нажмите</span>
            <span className={styles.dropHint}>.xlsx / .xls</span>
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls"
              className={styles.fileInput}
              onChange={handleFileChange}
            />
          </div>

          {file && (
            <div className={styles.selectedFile}>
              <span>📎 {file.name}</span>
              <button className={styles.removeFile} onClick={(e) => { e.stopPropagation(); setFile(null); }}>
                ✕
              </button>
            </div>
          )}

          {loading ? (
            <div className={styles.loading}>
              <span className={styles.spinner} />
              Анализ файла...
            </div>
          ) : (
            <>
              <button className={styles.uploadBtn} disabled={!file} onClick={handleUpload}>
                Загрузить и проверить
              </button>
              <div className={styles.uploadLinks}>
                <a
                  href={`/api/stores/${storeId}/price-import/template`}
                  download
                  className={styles.templateLink}
                >
                  ⬇ Скачать шаблон с артикулами
                </a>
                <a href="/docs" target="_blank" className={styles.docsLink}>
                  📖 Инструкция
                </a>
              </div>
            </>
          )}
        </>
      )}

      {/* STEP 2 — Preview */}
      {step === 'preview' && preview && (
        <>
          {/* Banners with tooltips */}
          <div className={styles.banners}>
            <Tooltip text="Товаров из файла, найденных в каталоге этого магазина" position="bottom">
              <span className={`${styles.banner} ${styles.bannerOk}`}>
                Совпало: {preview.matchedCount}
              </span>
            </Tooltip>
            {preview.notFoundInCatalog > 0 && (
              <Tooltip text="Артикулы из файла, которых нет в этом магазине. Это нормально если файл общий для нескольких магазинов" position="bottom">
                <span
                  className={`${styles.banner} ${styles.bannerWarn} ${filter === 'unknown' ? styles.bannerActive : ''}`}
                  onClick={() => toggleFilter('unknown')}
                >
                  Не найдено в магазине: {preview.notFoundInCatalog}
                </span>
              </Tooltip>
            )}
            {preview.missingInFile > 0 && (
              <Tooltip text="Товары магазина, для которых нет цены в загруженном файле" position="bottom">
                <span
                  className={`${styles.banner} ${styles.bannerWarn} ${filter === 'missing' ? styles.bannerActive : ''}`}
                  onClick={() => toggleFilter('missing')}
                >
                  Нет цены в файле: {preview.missingInFile}
                </span>
              </Tooltip>
            )}
            {blockedCount > 0 && (
              <Tooltip text={`Цена отличается от текущей более чем на ${BLOCK_THRESHOLD}%. Заблокировано для безопасности — разблокируйте вручную`} position="bottom">
                <span
                  className={`${styles.banner} ${styles.bannerDanger} ${filter === 'blocked' ? styles.bannerActive : ''}`}
                  onClick={() => toggleFilter('blocked')}
                >
                  Отклонение &gt;{BLOCK_THRESHOLD}%: {blockedCount}
                </span>
              </Tooltip>
            )}
          </div>

          {/* Expanded list for missing/unknown filter */}
          {filter === 'missing' && preview.missingProducts.length > 0 && (
            <div className={styles.expandedList}>
              {preview.missingProducts.map(p => (
                <div key={p.offer_id}>{p.offer_id} — {p.name}</div>
              ))}
            </div>
          )}
          {filter === 'unknown' && preview.unknownOfferIds.length > 0 && (
            <div className={styles.expandedList}>
              {preview.unknownOfferIds.map(id => (
                <div key={id}>{id}</div>
              ))}
            </div>
          )}

          {/* Auto min price settings */}
          <div className={styles.autoMinBar}>
            <label className={styles.autoMinLabel}>
              <input
                type="checkbox"
                className={styles.checkbox}
                checked={autoMinPrice}
                onChange={(e) => setAutoMinPrice(e.target.checked)}
              />
              Авто мин. цена
            </label>
            {autoMinPrice && (
              <select
                className={styles.autoMinSelect}
                value={autoMinPercent}
                onChange={(e) => setAutoMinPercent(Number(e.target.value))}
              >
                <option value={50}>50%</option>
                <option value={60}>60%</option>
                <option value={70}>70%</option>
                <option value={80}>80%</option>
              </select>
            )}
            {autoMinPrice && (
              <span className={styles.autoMinHint}>
                для позиций без мин. цены в файле
              </span>
            )}
          </div>

          {/* Legend + controls */}
          <div className={styles.tableInfo}>
            <span className={styles.legend}>
              ✅ будет обновлено · 🔒 заблокировано — нажмите чтобы разблокировать
            </span>
            <span className={styles.tableControls}>
              {blockedCount > 0 && (
                <button className={styles.linkBtn} onClick={handleUnlockAll}>Разблокировать все</button>
              )}
              {allSelected
                ? <button className={styles.linkBtn} onClick={handleDeselectAll}>Снять все</button>
                : <button className={styles.linkBtn} onClick={handleSelectAll}>Выбрать все</button>
              }
            </span>
          </div>

          <div className={styles.tableWrap}>
            <table className={styles.table}>
              <thead>
                <tr>
                  <th style={{ width: 24 }}></th>
                  <th>Артикул</th>
                  <th>Название</th>
                  <th>Текущая</th>
                  <th>Новая</th>
                  <th>Мин.</th>
                  <th>Δ%</th>
                  <th>С/с</th>
                  <th>Эталон</th>
                  <th>Δ реф.</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((item) => {
                  const blocked = isBlocked(item);
                  return (
                    <tr key={item.offer_id} className={blocked ? styles.rowBlocked : ''}>
                      <td>
                        {blocked ? (
                          <button
                            className={styles.lockBtn}
                            onClick={() => setConfirmUnlock(item.offer_id)}
                          >
                            🔒
                          </button>
                        ) : (
                          <input
                            type="checkbox"
                            className={styles.checkbox}
                            checked={selected.has(item.offer_id)}
                            onChange={() => toggleSelect(item.offer_id)}
                          />
                        )}
                      </td>
                      <td>{item.offer_id}</td>
                      <td title={item.name} style={{ maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {item.name?.slice(0, 25)}{(item.name?.length || 0) > 25 ? '...' : ''}
                      </td>
                      <td>{item.currentPrice?.toLocaleString('ru-RU')}</td>
                      <td>{item.newPrice?.toLocaleString('ru-RU')}</td>
                      <td>
                        {(() => {
                          const mp = computeMinPrice(item);
                          if (!mp) return '—';
                          const isAuto = !(item.minPrice && item.minPrice > 0) && autoMinPrice;
                          return (
                            <span className={isAuto ? styles.autoMinValue : ''}>
                              {mp.toLocaleString('ru-RU')}
                            </span>
                          );
                        })()}
                      </td>
                      <td className={devClass(item.deviationPercent)}>
                        {fmtDev(item.deviationPercent)}
                      </td>
                      <td>{item.costPrice ? item.costPrice.toLocaleString('ru-RU') : '—'}</td>
                      <td>
                        {item.refPrice != null ? item.refPrice.toLocaleString('ru-RU') : '—'}
                      </td>
                      <td>
                        {item.deviationFromRef != null ? (
                          <span className={devClass(item.deviationFromRef)}>
                            {fmtDev(item.deviationFromRef)}
                          </span>
                        ) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Submit bar */}
          <div className={styles.submitBar}>
            <span className={styles.selectedCount}>
              Выбрано: {selected.size} из {preview.items.length}{blockedCount > 0 ? ` (${blockedCount} заблок.)` : ''}
            </span>
            {loading ? (
              <div className={styles.loading} style={{ padding: 0 }}>
                <span className={styles.spinner} />
              </div>
            ) : (
              <div className={styles.submitBtns}>
                <button
                  className={styles.btnRef}
                  disabled={selected.size === 0}
                  onClick={handleSaveRefOnly}
                >
                  Сохранить эталон ({selected.size})
                </button>
                {canSendToPlatform && (
                  <button
                    className={styles.btnOzon}
                    disabled={selected.size === 0}
                    onClick={handleSaveAndSend}
                  >
                    Эталон + {platformLabel} ({selected.size})
                  </button>
                )}
              </div>
            )}
          </div>
        </>
      )}

      {/* STEP 3 — Result */}
      {step === 'result' && (
        <div className={styles.result}>
          <span className={styles.resultIcon}>✅</span>
          <span className={styles.resultTitle}>{resultMessage}</span>
          <div className={styles.resultStats}>
            <span className={styles.resultStat}>Позиций: {resultCount}</span>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>
            Закрыть
          </button>
        </div>
      )}

      {/* Confirm unlock dialog */}
      {confirmUnlock && (
        <div className={styles.confirmOverlay} onClick={() => setConfirmUnlock(null)}>
          <div className={styles.confirmBox} onClick={(e) => e.stopPropagation()}>
            <div className={styles.confirmText}>
              Отклонение больше {BLOCK_THRESHOLD}%. Разблокировать{' '}
              <strong>{confirmUnlock}</strong>?
            </div>
            <div className={styles.confirmActions}>
              <button className={styles.confirmYes} onClick={() => handleUnlockConfirm(confirmUnlock)}>
                Разблокировать
              </button>
              <button className={styles.confirmNo} onClick={() => setConfirmUnlock(null)}>
                Отмена
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
