import React from 'react';
import type { OzonProduct, PriceUpdateResponse } from '../../services/ozonApi';
import { useSelection } from '../../contexts/SelectionContext';
import ProductRow from './ProductRow';
import PriceEditModal from './PriceEditModal';
import PriceHistoryModal from './PriceHistoryModal';
import SelectionToolbar from './SelectionToolbar';
import ColumnSelector, {
    loadVisibleColumns,
    loadColumnOrder,
    loadColumnWidths,
    saveColumnWidths,
    DEFAULT_COLUMN_WIDTHS,
    MIN_COLUMN_WIDTH,
    type ColumnKey,
} from './ColumnSelector';
import NumericFilters, { type NumericFilterValues } from './NumericFilters';
import SnapshotHistory from './SnapshotHistory';
import Tooltip from '../ui/Tooltip';
import styles from './ProductTable.module.css';

export interface SortConfig {
    key: keyof OzonProduct | null;
    direction: 'asc' | 'desc';
}

interface ProductTableProps {
    products: OzonProduct[];
    storeId: string | null;
    currentPage: number;
    pageSize: number;
    totalItems: number;
    sortConfig: SortConfig;
    isExporting: boolean;
    onSort: (key: keyof OzonProduct) => void;
    onPageChange: (page: number) => void;
    onPageSizeChange: (size: number) => void;
    onExportExcel: () => void;
    onPriceUpdate: (productId: number, offerId: string, newPrice: number, oldPrice: number, minPrice: number) => Promise<PriceUpdateResponse>;
    numericFilters: NumericFilterValues;
    onApplyNumericFilters: (v: NumericFilterValues) => void;
}

const ProductTable: React.FC<ProductTableProps> = ({
    products,
    storeId,
    currentPage,
    pageSize,
    totalItems,
    sortConfig,
    isExporting,
    onSort,
    onPageChange,
    onPageSizeChange,
    onExportExcel,
    onPriceUpdate,
    numericFilters,
    onApplyNumericFilters,
}) => {
    const { selectedIds, selectedCount, isSelected, toggle, toggleAll, clear, selectRange } = useSelection();

    const totalPages = Math.ceil(totalItems / pageSize);
    const startRecord = totalItems > 0 ? (currentPage - 1) * pageSize + 1 : 0;
    const endRecord = Math.min(currentPage * pageSize, totalItems);

    const [jumpPage, setJumpPage] = React.useState('');
    const [editingProduct, setEditingProduct] = React.useState<OzonProduct | null>(null);
    const [historyProduct, setHistoryProduct] = React.useState<OzonProduct | null>(null);
    const [visibleColumns, setVisibleColumns] = React.useState<Set<ColumnKey>>(() => loadVisibleColumns());
    const [columnOrder, setColumnOrder] = React.useState<ColumnKey[]>(() => loadColumnOrder());
    const [columnWidths, setColumnWidths] = React.useState<Record<ColumnKey, number>>(() => loadColumnWidths());
    const [snapshotOpen, setSnapshotOpen] = React.useState(false);

    const startResize = (e: React.MouseEvent, col: ColumnKey) => {
        e.preventDefault();
        e.stopPropagation();
        const startX = e.clientX;
        const startWidth = columnWidths[col] ?? DEFAULT_COLUMN_WIDTHS[col];
        const onMove = (ev: MouseEvent) => {
            const next = Math.max(MIN_COLUMN_WIDTH, startWidth + (ev.clientX - startX));
            setColumnWidths((prev) => ({ ...prev, [col]: next }));
        };
        const onUp = () => {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            setColumnWidths((prev) => {
                saveColumnWidths(prev);
                return prev;
            });
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    };

    type ThProps = { className?: string; children?: React.ReactNode };
    const withResizeHandle = (col: ColumnKey, th: React.ReactElement): React.ReactElement => {
        const el = th as React.ReactElement<ThProps>;
        return React.cloneElement(
            el,
            { className: `${el.props.className || ''} ${styles.resizableTh}`.trim() },
            el.props.children,
            <span
                key="resize-handle"
                className={styles.resizeHandle}
                onMouseDown={(e: React.MouseEvent) => startResize(e, col)}
                onClick={(e: React.MouseEvent) => e.stopPropagation()}
            />
        );
    };

    const handleJump = () => {
        const p = parseInt(jumpPage, 10);
        if (!isNaN(p) && p >= 1 && p <= totalPages) {
            onPageChange(p);
            setJumpPage('');
        }
    };

    const renderPageNumbers = () => {
        const pages: (number | string)[] = [];
        if (totalPages <= 7) {
            for (let i = 1; i <= totalPages; i++) pages.push(i);
        } else {
            if (currentPage <= 4) {
                for (let i = 1; i <= 5; i++) pages.push(i);
                pages.push('...');
                pages.push(totalPages);
            } else if (currentPage >= totalPages - 3) {
                pages.push(1);
                pages.push('...');
                for (let i = totalPages - 4; i <= totalPages; i++) pages.push(i);
            } else {
                pages.push(1);
                pages.push('...');
                for (let i = currentPage - 1; i <= currentPage + 1; i++) pages.push(i);
                pages.push('...');
                pages.push(totalPages);
            }
        }
        return pages.map((p, idx) => (
            <button
                key={idx}
                className={`page-num-btn ${p === currentPage ? 'active' : ''} ${p === '...' ? 'dots' : ''}`}
                onClick={() => typeof p === 'number' ? onPageChange(p) : undefined}
                disabled={p === '...'}
            >
                {p}
            </button>
        ));
    };

    // Sorting lives on <th onClick>, which is unreachable by keyboard and says
    // nothing to a screen reader. These props add both without restructuring
    // the header cells.
    const sortableProps = (key: keyof OzonProduct) => ({
        className: styles.sortableTh,
        onClick: () => onSort(key),
        onKeyDown: (e: React.KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onSort(key);
            }
        },
        tabIndex: 0,
        role: 'columnheader' as const,
        'aria-sort': (sortConfig.key === key
            ? (sortConfig.direction === 'asc' ? 'ascending' : 'descending')
            : 'none') as React.AriaAttributes['aria-sort'],
    });

    const renderSortArrow = (key: keyof OzonProduct) => {
        if (sortConfig.key === key) {
            return sortConfig.direction === 'asc' ? ' ▲' : ' ▼';
        }
        return <span style={{ opacity: 0.3 }}> ⇅</span>;
    };

    const HEADER_MAP: Partial<Record<ColumnKey, React.ReactNode>> = {
        status: <th key="status"><Tooltip text="Видимость, карантин, промо" position="bottom">Статус</Tooltip></th>,
        photo: <th key="photo"></th>,
        name: (
            <th key="name" {...sortableProps('name')}>
                <Tooltip text="Название товара (Артикул)" position="bottom">Товар</Tooltip> {renderSortArrow('name')}
            </th>
        ),
        price: (
            <th key="price" {...sortableProps('price')}>
                <Tooltip text="Цена для покупателя на карточке товара (с учётом скидок Ozon)" position="bottom">Цена</Tooltip> {renderSortArrow('price')}
            </th>
        ),
        marketing_price: (
            <th key="marketing_price" {...sortableProps('marketing_price')}>
                <Tooltip text="Цена продавца — может отличаться от «Цена» если Ozon применяет свои скидки" position="bottom">Маркетинговая</Tooltip> {renderSortArrow('marketing_price')}
            </th>
        ),
        min_price: (
            <th key="min_price" {...sortableProps('min_price')}>
                <Tooltip text="Минимальная цена для автоакций Ozon. Ozon не снизит цену ниже этого значения в своих промоакциях. Задаётся в Ozon, покупатель не видит" position="bottom">Минимальная</Tooltip> {renderSortArrow('min_price')}
            </th>
        ),
        promo_price: <th key="promo_price"><Tooltip text="Цена товара в текущей акции Ozon" position="bottom">Акция</Tooltip></th>,
        ref_price: (
            <th key="ref_price" {...sortableProps('ref_price')}>
                <Tooltip text="Эталон из Excel — целевая цена для репрайсера. Не существует в Ozon" position="bottom">Эталон</Tooltip> {renderSortArrow('ref_price')}
            </th>
        ),
        old_price: (
            <th key="old_price" {...sortableProps('old_price')}>
                <Tooltip text="Зачёркнутая цена на карточке — показывает покупателю размер скидки" position="bottom">Старая</Tooltip> {renderSortArrow('old_price')}
            </th>
        ),
        cost_price: (
            <th key="cost_price" {...sortableProps('cost_price')}>
                <Tooltip text="Себестоимость из Excel — не существует в Ozon, для расчёта маржи" position="bottom">Себест.</Tooltip> {renderSortArrow('cost_price')}
            </th>
        ),
        floor_min_price: (
            <th key="floor_min_price" {...sortableProps('floor_min_price')}>
                <Tooltip text="Ценовой пол — ваш внутренний лимит из Excel или настроек. Репрайсер не снизит цену ниже этого значения. В отличие от МИН — задаётся вами, Ozon его не видит" position="bottom">Пол цены</Tooltip> {renderSortArrow('floor_min_price')}
            </th>
        ),
        margin: <th key="margin"><Tooltip text="Маржинальность: (Цена продавца − Себестоимость) / Цена продавца × 100%" position="bottom">Маржа %</Tooltip></th>,
        stocks_fbo: (
            <th key="stocks_fbo" {...sortableProps('stocks_fbo')}>
                <Tooltip text="Остатки на складах Ozon (FBO), доступно = present − reserved" position="bottom">Остатки FBO</Tooltip> {renderSortArrow('stocks_fbo')}
            </th>
        ),
        stocks_fbs: (
            <th key="stocks_fbs" {...sortableProps('stocks_fbs')}>
                <Tooltip text="Остатки на вашем складе (FBS), доступно = present − reserved" position="bottom">Остатки FBS</Tooltip> {renderSortArrow('stocks_fbs')}
            </th>
        ),
        sales_30d: (
            <th key="sales_30d" {...sortableProps('sales_30d' as keyof OzonProduct)}>
                <Tooltip text="Сумма проданных штук за последние 30 дней (все дни, включая акции и стокауты)" position="bottom">Продажи 30д</Tooltip> {renderSortArrow('sales_30d' as keyof OzonProduct)}
            </th>
        ),
        risk: (
            <th key="risk" {...sortableProps('risk' as keyof OzonProduct)}>
                <Tooltip text="Красный: маркет. цена ниже себестоимости (убыточно). Жёлтый: ниже эталона на 10%+. Серый: нет данных. Сортировка: убыточные сверху" position="bottom">Риск</Tooltip> {renderSortArrow('risk' as keyof OzonProduct)}
            </th>
        ),
    };

    // All IDs on current page for toggleAll
    const pageIds = products.map((p) => p.product_id.toString());
    const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selectedIds.has(id));
    const somePageSelected = pageIds.some((id) => selectedIds.has(id));

    // Count of visible columns to set correct colSpan for empty message
    const visibleColCount =
        1 + // checkbox
        columnOrder.filter((col) => visibleColumns.has(col)).length +
        1; // actions

    return (
        <div className={styles.container}>
            {/* Compact single-line toolbar */}
            <div className={styles.toolbar}>
                <span className={styles.pgSummary}>
                    {totalItems > 0 ? `${startRecord}–${endRecord} из ${totalItems}` : 'Нет данных'}
                </span>

                <button
                    onClick={onExportExcel}
                    className="export-btn"
                    disabled={isExporting || totalItems === 0}
                    style={{ padding: '4px 12px', fontSize: '0.78rem' }}
                >
                    {isExporting ? '...' : 'Excel'}
                </button>

                {storeId && (
                    <button
                        onClick={() => setSnapshotOpen(true)}
                        className="secondary-btn"
                        style={{ padding: '4px 10px', fontSize: '0.78rem' }}
                        title="История операций с ценами"
                    >
                        История
                    </button>
                )}

                <div className={styles.spacer} />

                {/* Pagination */}
                <button
                    className="nav-arrow"
                    onClick={() => onPageChange(currentPage - 1)}
                    disabled={currentPage === 1}
                >
                    &lt;
                </button>
                <div className="pg-numbers">
                    {renderPageNumbers()}
                </div>
                <button
                    className="nav-arrow"
                    onClick={() => onPageChange(currentPage + 1)}
                    disabled={currentPage === totalPages || totalPages === 0}
                >
                    &gt;
                </button>

                <select
                    value={pageSize}
                    onChange={(e) => onPageSizeChange(Number(e.target.value))}
                    className="size-select"
                    style={{ padding: '3px 8px', fontSize: '0.78rem' }}
                >
                    <option value={20}>20</option>
                    <option value={50}>50</option>
                    <option value={100}>100</option>
                </select>

                <input
                    type="text"
                    className="jump-input"
                    value={jumpPage}
                    onChange={(e) => setJumpPage(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleJump()}
                    placeholder="#"
                    style={{ width: '40px', padding: '3px 6px', fontSize: '0.78rem' }}
                />

                <NumericFilters
                    value={numericFilters}
                    onApply={onApplyNumericFilters}
                />

                <ColumnSelector
                    visibleColumns={visibleColumns}
                    onChange={setVisibleColumns}
                    columnOrder={columnOrder}
                    onReorderChange={setColumnOrder}
                />
            </div>

            {/* Table */}
            <div className={styles.tableWrapper}>
                <table className={styles.productsTable}>
                    <colgroup>
                        <col style={{ width: 26 }} />
                        {columnOrder.map((col) => visibleColumns.has(col) ? (
                            <col key={col} style={{ width: columnWidths[col] ?? DEFAULT_COLUMN_WIDTHS[col] }} />
                        ) : null)}
                        <col style={{ width: 76 }} />
                    </colgroup>
                    <thead>
                        <tr>
                            {/* Checkbox header */}
                            <th style={{ textAlign: 'center' }}>
                                <input
                                    type="checkbox"
                                    checked={allPageSelected}
                                    ref={(el) => {
                                        if (el) el.indeterminate = somePageSelected && !allPageSelected;
                                    }}
                                    onChange={() => toggleAll(pageIds)}
                                    style={{ width: '13px', height: '13px', accentColor: 'var(--accent-color)', cursor: 'pointer' }}
                                />
                            </th>

                            {columnOrder.map((col) => visibleColumns.has(col) && HEADER_MAP[col] ? withResizeHandle(col, HEADER_MAP[col] as React.ReactElement) : null)}
                            <th className={styles.stickyActions}></th>
                        </tr>
                    </thead>
                    <tbody>
                        {products.map((product, index) => (
                            <ProductRow
                                key={product.product_id}
                                product={product}
                                index={index}
                                currentPage={currentPage}
                                pageSize={pageSize}
                                onEditPrice={setEditingProduct}
                                onShowHistory={setHistoryProduct}
                                visibleColumns={visibleColumns}
                                columnOrder={columnOrder}
                                isSelected={isSelected(product.product_id.toString())}
                                onToggle={toggle}
                                onRangeSelect={(_id, idx) => selectRange(pageIds, idx)}
                            />
                        ))}
                        {products.length === 0 && (
                            <tr>
                                <td colSpan={visibleColCount} className={styles.emptyMessage}>
                                    Нет данных. Синхронизируйте магазин в настройках.
                                </td>
                            </tr>
                        )}
                    </tbody>
                </table>
            </div>

            {/* Modals */}
            <PriceEditModal
                product={editingProduct}
                storeId={storeId}
                onClose={() => setEditingProduct(null)}
                onPriceUpdate={onPriceUpdate}
            />
            <PriceHistoryModal
                product={historyProduct}
                onClose={() => setHistoryProduct(null)}
            />

            {/* Selection toolbar */}
            <SelectionToolbar
                selectedCount={selectedCount}
                storeId={storeId}
                onClear={clear}
            />

            {/* Snapshot history modal */}
            {storeId && (
                <SnapshotHistory
                    isOpen={snapshotOpen}
                    storeId={storeId}
                    onClose={() => setSnapshotOpen(false)}
                />
            )}
        </div>
    );
};

export default ProductTable;
