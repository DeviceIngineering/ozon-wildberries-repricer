import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useSelection } from '../contexts/SelectionContext';
import { useToast } from '../contexts/ToastContext';
import type { OzonProduct } from '../services/ozonApi';
import FormulaBar, { type FormulaResult } from '../components/mass-edit/FormulaBar';
import PreviewTable from '../components/mass-edit/PreviewTable';
import InlineEditTable, { type InlineChange } from '../components/mass-edit/InlineEditTable';
import ScheduleDialog from '../components/mass-edit/ScheduleDialog';
import ConfirmDialog from '../components/ui/ConfirmDialog';
import styles from './MassEditPage.module.css';

const API_BASE = '';

type Tab = 'formula' | 'table';

export default function MassEditPage() {
  const { id: storeIdParam } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { selectedIds, clear: clearSelection } = useSelection();
  const { showSuccess, showError, showProgress, dismiss } = useToast();

  const storeId = storeIdParam || null;

  const [products, setProducts] = useState<OzonProduct[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<Tab>('formula');

  // Formula tab state
  const [formulaResults, setFormulaResults] = useState<FormulaResult[]>([]);
  const [excludedIds, setExcludedIds] = useState<Set<string>>(new Set());

  // Inline table state
  const [inlineChanges, setInlineChanges] = useState<Map<string, InlineChange>>(new Map());

  // Dialogs
  const [showConfirm, setShowConfirm] = useState(false);
  const [showSchedule, setShowSchedule] = useState(false);

  // Load products
  const loadProducts = useCallback(async () => {
    if (!storeId) return;
    setIsLoading(true);
    try {
      const res = await fetch(`${API_BASE}/api/stores/${storeId}/products?pageSize=10000`);
      if (!res.ok) throw new Error('Не удалось загрузить товары');
      const data = await res.json();
      const items: OzonProduct[] = Array.isArray(data) ? data : (data.items ?? []);

      if (selectedIds.size > 0) {
        setProducts(items.filter((p) => selectedIds.has(p.offer_id)));
      } else {
        setProducts(items);
      }
    } catch (e: any) {
      showError('Ошибка загрузки товаров: ' + e.message);
    } finally {
      setIsLoading(false);
    }
  }, [storeId, selectedIds, showError]);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  // Build updates for formula tab
  const buildFormulaUpdates = useCallback(() => {
    const included = formulaResults.filter((r) => !excludedIds.has(r.offerId));
    return included.map((r) => {
      const p = r.product;
      const basePrice = parseFloat(p.price || '0');
      const baseMinPrice = parseFloat(p.min_price || '0');
      const baseOldPrice = parseFloat(p.old_price || '0');

      return {
        offer_id: r.offerId,
        price: r.field === 'price' ? String(r.newValue) : String(basePrice),
        old_price: r.field === 'old_price' ? String(r.newValue) : String(baseOldPrice),
        min_price: r.field === 'min_price' ? String(r.newValue) : String(baseMinPrice || basePrice),
        currency_code: p.currency_code || 'RUB',
      };
    });
  }, [formulaResults, excludedIds]);

  // Build updates for inline tab
  const buildInlineUpdates = useCallback(() => {
    return Array.from(inlineChanges.entries()).map(([offerId, ch]) => {
      const product = products.find((p) => p.offer_id === offerId);
      const basePrice = parseFloat(product?.price || '0');
      const baseMinPrice = parseFloat(product?.min_price || '0');
      const baseOldPrice = parseFloat(product?.old_price || '0');

      return {
        offer_id: offerId,
        price: ch.price !== undefined ? String(ch.price) : String(basePrice),
        old_price: ch.oldPrice !== undefined ? String(ch.oldPrice) : String(baseOldPrice),
        min_price: ch.minPrice !== undefined ? String(ch.minPrice) : String(baseMinPrice || basePrice),
        currency_code: product?.currency_code || 'RUB',
      };
    });
  }, [inlineChanges, products]);

  const getUpdates = useCallback(() => {
    return activeTab === 'formula' ? buildFormulaUpdates() : buildInlineUpdates();
  }, [activeTab, buildFormulaUpdates, buildInlineUpdates]);

  const getUpdatesCount = () => {
    if (activeTab === 'formula') {
      return formulaResults.filter((r) => !excludedIds.has(r.offerId)).length;
    }
    return inlineChanges.size;
  };

  const handleApply = async () => {
    if (!storeId) return;
    const updates = getUpdates();
    if (updates.length === 0) {
      showError('Нет изменений для применения');
      return;
    }
    setShowConfirm(false);

    const toastId = showProgress(`Обновление цен для ${updates.length} товаров...`);
    try {
      const res = await fetch(`${API_BASE}/api/stores/${storeId}/mass-price-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priceUpdates: updates }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Ошибка обновления цен');
      }
      dismiss(toastId);
      showSuccess(`Успешно обновлено ${updates.length} товаров`);
      clearSelection();
      navigate(`/store/${storeId}`);
    } catch (e: any) {
      dismiss(toastId);
      showError('Ошибка: ' + e.message);
    }
  };

  const handleScheduled = () => {
    showSuccess('Обновление запланировано');
  };

  const canApply = getUpdatesCount() > 0;

  if (!storeId) {
    return (
      <div className={styles.page}>
        <p className={styles.noStore}>Магазин не выбран</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className={styles.page}>
        <div className={styles.loading}>
          <div className="loader"></div>
          <p>Загрузка товаров...</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Массовое редактирование цен</h1>
          <p className={styles.subtitle}>
            {selectedIds.size > 0
              ? `Выбрано: ${products.length} товаров`
              : `Всего: ${products.length} товаров`}
          </p>
        </div>
      </div>

      {/* Tabs */}
      <div className={styles.tabs}>
        <button
          className={`${styles.tab} ${activeTab === 'formula' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('formula')}
        >
          Формула
        </button>
        <button
          className={`${styles.tab} ${activeTab === 'table' ? styles.tabActive : ''}`}
          onClick={() => setActiveTab('table')}
        >
          Таблица
        </button>
      </div>

      {/* Tab content */}
      <div className={styles.content}>
        {activeTab === 'formula' && (
          <div className={styles.formulaTab}>
            <FormulaBar
              products={products}
              onCalculate={(results) => {
                setFormulaResults(results);
                setExcludedIds(new Set());
              }}
            />
            <PreviewTable
              results={formulaResults}
              onExcludedChange={setExcludedIds}
            />
          </div>
        )}

        {activeTab === 'table' && (
          <InlineEditTable
            products={products}
            onChange={setInlineChanges}
          />
        )}
      </div>

      {/* Bottom actions */}
      <div className={styles.actions}>
        <button
          className={styles.cancelBtn}
          onClick={() => navigate(`/store/${storeId}`)}
        >
          Отмена
        </button>

        <div className={styles.primaryActions}>
          <button
            className={styles.scheduleBtn}
            onClick={() => setShowSchedule(true)}
            disabled={!canApply}
          >
            Запланировать
          </button>
          <button
            className={styles.applyBtn}
            onClick={() => setShowConfirm(true)}
            disabled={!canApply}
          >
            Применить
          </button>
        </div>
      </div>

      {/* Confirm dialog */}
      <ConfirmDialog
        isOpen={showConfirm}
        title="Обновить цены"
        message={`Обновить цены для ${getUpdatesCount()} товаров? Изменения будут немедленно применены в Ozon.`}
        confirmText="Обновить"
        cancelText="Отмена"
        variant="info"
        onConfirm={handleApply}
        onCancel={() => setShowConfirm(false)}
      />

      {/* Schedule dialog */}
      {showSchedule && (
        <ScheduleDialog
          isOpen={showSchedule}
          storeId={storeId}
          updates={getUpdates()}
          onClose={() => setShowSchedule(false)}
          onScheduled={handleScheduled}
        />
      )}
    </div>
  );
}
