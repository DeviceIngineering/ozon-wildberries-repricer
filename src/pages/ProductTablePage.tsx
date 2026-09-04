import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import * as XLSX from 'xlsx';
import ProductTable, { type SortConfig } from '../components/products/ProductTable';
import ProductFilters, { type ActiveFilter, type FilterCounts } from '../components/products/ProductFilters';
import { type NumericFilterValues } from '../components/products/NumericFilters';
import { useStores } from '../contexts/StoreContext';
import { useToast } from '../contexts/ToastContext';
import { SelectionProvider } from '../contexts/SelectionContext';
import type {
    OzonProduct,
    DashboardSummary,
    ProductsResponse,
    PriceUpdateResponse,
} from '../services/ozonApi';
import { runRepricerNow, runMonitorNow } from '../services/ozonApi';
import { errorMessage, type ApiErrorBody } from '../services/apiError';
import styles from './ProductTablePage.module.css';

function ageMin(dateStr: string | null | undefined): number {
    if (!dateStr) return Infinity;
    return Math.floor((Date.now() - new Date(dateStr).getTime()) / 60000);
}

function timeAgoShort(dateStr: string | null | undefined): string {
    const m = ageMin(dateStr);
    if (m === Infinity) return 'никогда';
    if (m < 1) return 'только что';
    if (m < 60) return `${m} мин`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} ч`;
    return `${Math.floor(h / 24)} дн`;
}

const API_BASE = '';

const NUMERIC_FILTER_KEYS = [
    'sales_30d_min', 'sales_30d_max',
    'stocks_fbo_min', 'stocks_fbo_max',
    'stocks_fbs_min', 'stocks_fbs_max',
    'cost_price_min', 'cost_price_max',
    'price_min', 'price_max',
] as const;

function parseNumericFiltersFromUrl(searchParams: URLSearchParams): NumericFilterValues {
    const result: NumericFilterValues = {};
    for (const key of NUMERIC_FILTER_KEYS) {
        const raw = searchParams.get(key);
        if (raw === null || raw === '') continue;
        const n = Number(raw);
        if (!Number.isNaN(n)) result[key] = n;
    }
    return result;
}

// Helper: compute tab counts from full product array (includes archived)
function computeCounts(products: OzonProduct[]): FilterCounts {
    let all = 0;
    let on_sale = 0;
    let ready = 0;
    let removed = 0;
    let errors = 0;
    let needs_work = 0;
    let archived = 0;
    let can_improve = 0;
    let has_fbo = 0;
    let has_fbs = 0;

    for (const p of products) {
        if (p.is_archived === 1) { archived++; continue; }
        all++;
        // Stocks chips — non-exclusive (subset of active)
        if ((p.stocks_fbo ?? 0) > 0) has_fbo++;
        if ((p.stocks_fbs ?? 0) > 0) has_fbs++;
        if (!p.visibility) continue;
        // can_improve is non-exclusive (subset of active)
        if (p.moderate_status === 'can_improve') can_improve++;
        if (p.is_quarantine === 1) { errors++; continue; }
        if (p.visibility === 'VISIBLE') { on_sale++; continue; }
        // INVISIBLE, not archived, not quarantine
        const isCreated = p.ozon_is_created !== 0;
        if (!isCreated) { needs_work++; continue; }
        if (p.has_stock === 0) { ready++; continue; }
        removed++;
    }

    return { all, on_sale, ready, removed, errors, needs_work, archived, can_improve, has_fbo, has_fbs };
}

export default function ProductTablePage() {
    const { id: storeIdParam } = useParams<{ id: string }>();
    const [searchParams, setSearchParams] = useSearchParams();
    const { stores, activeStoreId, setActiveStore } = useStores();
    const { showError, showSuccess } = useToast();
    const [repricerRunning, setRepricerRunning] = useState(false);

    const storeId = storeIdParam || null;
    const platform = stores.find(s => s.id === storeId)?.platform || 'ozon';

    // Sync URL storeId with StoreContext
    useEffect(() => {
        if (storeId && storeId !== activeStoreId) {
            setActiveStore(storeId);
        }
    }, [storeId, activeStoreId, setActiveStore]);

    // --- Server-side state ---
    const [products, setProducts] = useState<OzonProduct[]>([]);
    const [total, setTotal] = useState(0);
    const [isLoading, setIsLoading] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // For quick counters: fetched once when store changes (no filter)
    const [allProducts, setAllProducts] = useState<OzonProduct[]>([]);

    // Repricer health summary
    const [storeHealth, setStoreHealth] = useState<DashboardSummary['stores'][number] | null>(null);

    const fetchHealth = useCallback(async () => {
        try {
            const res = await fetch('/api/dashboard/summary');
            if (!res.ok) return;
            const data: DashboardSummary = await res.json();
            const found = data.stores.find(s => s.id === storeId);
            setStoreHealth(found ?? null);
        } catch { /* silent */ }
    }, [storeId]);

    useEffect(() => {
        fetchHealth();
        const iv = setInterval(fetchHealth, 60_000);
        return () => clearInterval(iv);
    }, [fetchHealth]);

    // --- URL-driven pagination/sort/search/filters ---
    const [currentPage, setCurrentPage] = useState(() => {
        const p = searchParams.get('page');
        return p ? Math.max(1, Number(p)) : 1;
    });
    const [pageSize, setPageSize] = useState(20);
    const [sortConfig, setSortConfig] = useState<SortConfig>({ key: null, direction: 'asc' });
    const [searchQuery, setSearchQuery] = useState(searchParams.get('search') || '');
    const [activeFilter, setActiveFilter] = useState<ActiveFilter>(() => {
        const raw = searchParams.get('filter');
        return (raw as ActiveFilter) || 'all';
    });
    const [numericFilters, setNumericFilters] = useState<NumericFilterValues>(() =>
        parseNumericFiltersFromUrl(searchParams)
    );

    // Sync URL params
    useEffect(() => {
        const params: Record<string, string> = {};
        if (currentPage > 1) params.page = String(currentPage);
        if (searchQuery) params.search = searchQuery;
        if (activeFilter !== 'all') params.filter = activeFilter;
        for (const key of NUMERIC_FILTER_KEYS) {
            const v = numericFilters[key];
            if (v !== undefined) params[key] = String(v);
        }
        setSearchParams(params, { replace: true });
    }, [currentPage, searchQuery, activeFilter, numericFilters]);

    // Build query string for server
    const buildQuery = useCallback(
        (page: number, size: number, sort: SortConfig, search: string, filter: ActiveFilter, filters: NumericFilterValues) => {
            const params = new URLSearchParams();
            params.set('page', String(page));
            params.set('pageSize', String(size));
            if (sort.key) params.set('sort', `${sort.key}:${sort.direction}`);
            if (search) params.set('search', search);
            if (filter !== 'all') params.set('filter', filter);
            for (const key of NUMERIC_FILTER_KEYS) {
                const v = filters[key];
                if (v !== undefined) params.set(key, String(v));
            }
            return params.toString();
        },
        []
    );

    // Fetch paginated products from server
    const fetchProducts = useCallback(
        async (id: string, page: number, size: number, sort: SortConfig, search: string, filter: ActiveFilter, filters: NumericFilterValues) => {
            setIsLoading(true);
            setError(null);
            try {
                const qs = buildQuery(page, size, sort, search, filter, filters);
                const res = await fetch(`${API_BASE}/api/stores/${id}/products?${qs}`);
                if (!res.ok) throw new Error('Не удалось загрузить товары');
                // Роут отвечает страницей, только если пришли параметры пагинации/фильтров,
                // иначе — плоским массивом (см. routes/stores.cjs GET /:id/products).
                const data: ProductsResponse = await res.json();

                // Support both paginated response and plain array (backward compat)
                if (Array.isArray(data)) {
                    setProducts(data);
                    setTotal(data.length);
                } else {
                    setProducts(data.items ?? []);
                    setTotal(data.total ?? 0);
                }
            } catch (err) {
                console.error(err);
                setError(errorMessage(err));
                showError('Ошибка загрузки товаров: ' + errorMessage(err));
            } finally {
                setIsLoading(false);
            }
        },
        [buildQuery, showError]
    );

    // Fetch all products (no pagination, no filter — includes archived) for counters
    const fetchAllForCounters = useCallback(async (id: string) => {
        try {
            const res = await fetch(`${API_BASE}/api/stores/${id}/products`);
            if (!res.ok) return;
            const data: ProductsResponse = await res.json();
            setAllProducts(Array.isArray(data) ? data : (data.items ?? []));
        } catch {
            // Silent — counters are optional
        }
    }, []);

    // On store change: reset state and load both
    useEffect(() => {
        if (!storeId) return;
        setCurrentPage(1);
        setSearchQuery('');
        setActiveFilter('all');
        setNumericFilters({});
        setSortConfig({ key: null, direction: 'asc' });
        fetchAllForCounters(storeId);
    }, [storeId]);

    // Load products when any search param changes
    useEffect(() => {
        if (!storeId) return;
        fetchProducts(storeId, currentPage, pageSize, sortConfig, searchQuery, activeFilter, numericFilters);
    }, [storeId, currentPage, pageSize, sortConfig, searchQuery, activeFilter, numericFilters]);

    // Filter counts from allProducts (counters bar)
    const filterCounts = useMemo(() => computeCounts(allProducts), [allProducts]);

    // --- Handlers ---
    const handleSort = (key: keyof OzonProduct) => {
        let direction: 'asc' | 'desc' = 'asc';
        if (sortConfig.key === key && sortConfig.direction === 'asc') {
            direction = 'desc';
        }
        setSortConfig({ key, direction });
        setCurrentPage(1);
    };

    const handleSearchChange = (query: string) => {
        setSearchQuery(query);
        setCurrentPage(1);
    };

    const handleSelectFilter = (filter: ActiveFilter) => {
        setActiveFilter(filter);
        setCurrentPage(1);
    };

    const handleApplyNumericFilters = (v: NumericFilterValues) => {
        setNumericFilters(v);
        setCurrentPage(1);
    };

    const handlePageSizeChange = (size: number) => {
        setPageSize(size);
        setCurrentPage(1);
    };

    // Export: use allProducts for full data, or fetch without pagination
    const handleExportExcel = async () => {
        if (allProducts.length === 0 && products.length === 0) return;
        setIsExporting(true);
        try {
            let exportData = allProducts.length > 0 ? allProducts : products;

            // If we have server-side filters/search active, export from server without pagination
            if (storeId && (searchQuery || activeFilter !== 'all' || Object.keys(numericFilters).length > 0)) {
                try {
                    const qs = buildQuery(1, 10000, sortConfig, searchQuery, activeFilter, numericFilters);
                    const res = await fetch(`${API_BASE}/api/stores/${storeId}/products?${qs}`);
                    if (res.ok) {
                        const data: ProductsResponse = await res.json();
                        exportData = Array.isArray(data) ? data : (data.items ?? exportData);
                    }
                } catch {
            // Counters are advisory: a failed refresh leaves the previous values.
        }
            }

            const wsData = exportData.map((p) => ({
                'ID': p.product_id,
                'Артикул': p.offer_id,
                'Название': p.name,
                'Цена продажи': parseFloat(String(p.price || '0')),
                'Маркетинговая цена': parseFloat(String(p.marketing_price || '0')),
                'Мин. цена': parseFloat(String(p.min_price || '0')),
                'Старая цена': parseFloat(String(p.old_price || '0')),
                'Себестоимость': p.cost_price ?? '',
                'Валюта': p.currency_code,
            }));
            const ws = XLSX.utils.json_to_sheet(wsData);
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'Товары Ozon');

            const storeName = stores.find((s) => s.id === storeId)?.name || `Store_${storeId}`;
            const dateStr = new Date().toISOString().split('T')[0];
            const filename = `ozon_products_${storeName.replace(/\s+/g, '_')}_${dateStr}.xlsx`;

            XLSX.writeFile(wb, filename);
            showSuccess('Excel файл успешно сохранён');
        } catch {
            showError('Ошибка при экспорте в Excel');
        } finally {
            setIsExporting(false);
        }
    };

    const handleUpdatePrice = async (
        _productId: number,
        offerId: string,
        newPrice: number,
        oldPrice: number,
        minPrice: number
    ) => {
        if (!storeId) throw new Error('Не выбран магазин');

        const response = await fetch(`${API_BASE}/api/stores/${storeId}/update-prices`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                priceUpdates: [{
                    offer_id: offerId,
                    price: newPrice.toString(),
                    old_price: oldPrice > 0 ? oldPrice.toString() : '',
                    currency_code: 'RUB',
                    min_price: minPrice > 0 ? minPrice.toString() : newPrice.toString(),
                    auto_action_enabled: 'DISABLED',
                    price_strategy_enabled: 'DISABLED',
                }],
            }),
        });

        if (!response.ok) {
            const errorData: ApiErrorBody = await response.json();
            throw new Error(errorData.error || 'Ошибка обновления цены');
        }

        const result: PriceUpdateResponse = await response.json();
        if (!result.success) throw new Error('Не удалось обновить цену');

        // Проверить per-item ошибки от Ozon
        if (result.item_errors && result.item_errors.length > 0) {
            const errMsg = result.item_errors.map(
                (e) => `${e.offer_id}: ${e.errors.map((err) => err.message || err.code).join(', ')}`
            ).join('; ');
            throw new Error(`Ozon отклонил: ${errMsg}`);
        }

        // Optimistic update
        setProducts((prev) =>
            prev.map((p) => {
                if (p.offer_id === offerId) {
                    return {
                        ...p,
                        ref_price: newPrice.toString(),
                        ref_min_price: minPrice > 0 ? minPrice.toString() : p.ref_min_price,
                    };
                }
                return p;
            })
        );

        return result;
    };

    // --- Render guards ---
    if (!storeId) {
        return (
            <div style={{ padding: '40px', color: 'var(--text-primary)' }}>
                <p style={{ color: 'var(--text-secondary)' }}>Магазин не выбран</p>
            </div>
        );
    }

    if (error && products.length === 0) {
        return (
            <div className="error-container">
                <p className="error-text">Ошибка: {error}</p>
                <button
                    className="secondary-btn"
                    onClick={() => fetchProducts(storeId, currentPage, pageSize, sortConfig, searchQuery, activeFilter, numericFilters)}
                >
                    Повторить
                </button>
            </div>
        );
    }

    if (isLoading && products.length === 0) {
        return (
            <div className="loading-screen" style={{ height: '80vh', display: 'flex' }}>
                <div className="loader"></div>
                <p>Загрузка данных из БД...</p>
            </div>
        );
    }

    return (
        <SelectionProvider>
            <div className={styles.page}>
                {/* Repricer health bar */}
                {storeHealth?.repricer_enabled ? (() => {
                    const h = storeHealth;
                    const syncAge = ageMin(h.last_sync);
                    const syncFresh = syncAge < 10;
                    const syncOld = syncAge >= 60;
                    const noRef = (h.ref_price_count ?? 0) === 0;
                    const failCount = h.verified_fail_count ?? 0;
                    const belowOther = h.below_ref_other_count ?? 0;
                    const belowPromo = h.below_ref_promo_count ?? 0;
                    const promoCount = h.promo_count ?? 0;
                    return (
                        <div className={styles.repricerBar}>
                            <span className={styles.repricerLabel}>Репрайсер</span>

                            {/* Data freshness */}
                            <span
                                className={`${styles.repricerChip} ${syncFresh ? styles.repricerChipOk : syncOld ? styles.repricerChipDanger : styles.repricerChipWarn}`}
                                title="Время с момента последней синхронизации цен и статусов с Ozon"
                            >
                                <span className={`${styles.repricerDot} ${syncFresh ? styles.dotGreen : syncOld ? styles.dotRed : styles.dotYellow}`} />
                                Данные: {timeAgoShort(h.last_sync)} назад
                            </span>

                            {/* Ref price coverage */}
                            <span
                                className={`${styles.repricerChip} ${noRef ? styles.repricerChipDanger : styles.repricerChipInfo}`}
                                title="Количество товаров с заданным эталоном / всего товаров. Эталон — целевая цена из Excel, репрайсер поддерживает цену на этом уровне"
                            >
                                Эталонов: {noRef ? '⚠ не задано' : `${h.ref_price_count} / ${h.product_count}`}
                            </span>

                            {/* Promo — clickable filter */}
                            {promoCount > 0 && (
                                <span
                                    className={`${styles.repricerChip} ${styles.repricerChipInfo} ${styles.repricerChipClickable} ${activeFilter === 'promo' ? styles.repricerChipActive : ''}`}
                                    onClick={() => handleSelectFilter(activeFilter === 'promo' ? 'all' : 'promo')}
                                    title="Товары в активных акциях Ozon — ценой управляет Ozon, репрайсер не вмешивается. Кликните чтобы отфильтровать"
                                >
                                    Промо Озон: {promoCount}
                                </span>
                            )}

                            {/* Prices below ref — clickable filter */}
                            <span
                                className={`${styles.repricerChip} ${belowOther > 0 ? styles.repricerChipDanger : belowPromo > 0 ? styles.repricerChipWarn : styles.repricerChipOk} ${(belowOther > 0 || belowPromo > 0) ? styles.repricerChipClickable : ''} ${(activeFilter === 'below_ref' || (belowPromo > 0 && belowOther === 0 && activeFilter === 'promo')) ? styles.repricerChipActive : ''}`}
                                onClick={
                                    belowOther > 0
                                        ? () => handleSelectFilter(activeFilter === 'below_ref' ? 'all' : 'below_ref')
                                        : belowPromo > 0
                                            ? () => handleSelectFilter(activeFilter === 'promo' ? 'all' : 'promo')
                                            : undefined
                                }
                                title={
                                    belowOther > 0
                                        ? 'Товары, у которых цена продажи ниже эталона и они не в промо. Кликните чтобы отфильтровать'
                                        : belowPromo > 0
                                            ? 'Товары ниже эталона находятся в промо — ценой управляет Ozon. Кликните чтобы показать промо-товары'
                                            : 'Все цены на уровне эталона или выше'
                                }
                            >
                                Ниже эталона:{' '}
                                {belowOther > 0
                                    ? `${belowOther} ❌ не промо`
                                    : belowPromo > 0
                                        ? `${belowPromo} (промо)`
                                        : '0 ✓'}
                            </span>

                            {/* Verification failures — clickable filter */}
                            <span
                                className={`${styles.repricerChip} ${failCount > 0 ? styles.repricerChipDanger : styles.repricerChipOk} ${failCount > 0 ? styles.repricerChipClickable : ''} ${activeFilter === 'price_rejected' ? styles.repricerChipActive : ''}`}
                                onClick={failCount > 0 ? () => handleSelectFilter(activeFilter === 'price_rejected' ? 'all' : 'price_rejected') : undefined}
                                title={failCount > 0 ? 'Товары, для которых цена не применилась в Ozon. Кликните чтобы отфильтровать' : 'Все цены успешно применены'}
                            >
                                Не применилось: {failCount > 0 ? `${failCount} ❌` : '0 ✓'}
                            </span>

                            {/* Manual run button */}
                            <button
                                className={styles.repricerRunBtn}
                                disabled={repricerRunning}
                                title={repricerRunning ? 'Выполняется...' : platform === 'yandex' ? 'Синхронизировать товары с Яндекс Маркет' : 'Синхронизировать статусы и запустить репрайсер'}
                                onClick={async () => {
                                    if (!storeId) return;
                                    setRepricerRunning(true);
                                    try {
                                        await runMonitorNow(storeId);
                                        if (platform !== 'yandex') {
                                            await runRepricerNow(storeId);
                                        }
                                        showSuccess(platform === 'yandex' ? 'Синхронизация выполнена' : 'Синхронизация и репрайсер выполнены');
                                        fetchHealth();
                                        fetchAllForCounters(storeId);
                                        fetchProducts(storeId, currentPage, pageSize, sortConfig, searchQuery, activeFilter, numericFilters);
                                    } catch {
                                        showError('Ошибка при выполнении');
                                    } finally {
                                        setRepricerRunning(false);
                                    }
                                }}
                            >
                                {repricerRunning ? '⏳' : '▶ Запустить'}
                            </button>
                        </div>
                    );
                })() : null}

                {/* Unified search + filter bar */}
                <div className={styles.filtersWrapper}>
                    <ProductFilters
                        searchQuery={searchQuery}
                        onSearchChange={handleSearchChange}
                        activeFilter={activeFilter}
                        onSelectFilter={handleSelectFilter}
                        counts={filterCounts}
                        platform={platform}
                    />
                </div>

                {isLoading && (
                    <div className={styles.loadingOverlay}>
                        <div className="loader" style={{ width: '24px', height: '24px' }}></div>
                        <span>Загрузка...</span>
                    </div>
                )}

                <ProductTable
                    products={products}
                    storeId={storeId}
                    currentPage={currentPage}
                    pageSize={pageSize}
                    totalItems={total}
                    sortConfig={sortConfig}
                    isExporting={isExporting}
                    onSort={handleSort}
                    onPageChange={setCurrentPage}
                    onPageSizeChange={handlePageSizeChange}
                    onExportExcel={handleExportExcel}
                    onPriceUpdate={handleUpdatePrice}
                    numericFilters={numericFilters}
                    onApplyNumericFilters={handleApplyNumericFilters}
                />
            </div>
        </SelectionProvider>
    );
}
