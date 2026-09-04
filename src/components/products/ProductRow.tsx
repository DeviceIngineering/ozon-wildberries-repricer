import React, { useRef } from 'react';
import type { OzonProduct } from '../../services/ozonApi';
import StatusBadge, { getProductStatus } from './StatusBadge';
import type { ColumnKey } from './ColumnSelector';
import CrossStorePopup from './CrossStorePopup';
import Tooltip from '../ui/Tooltip';
import styles from './ProductRow.module.css';

interface ProductRowProps {
    product: OzonProduct;
    index: number;
    currentPage: number;
    pageSize: number;
    onEditPrice: (product: OzonProduct) => void;
    onShowHistory: (product: OzonProduct) => void;
    visibleColumns: Set<ColumnKey>;
    columnOrder: ColumnKey[];
    // Selection
    isSelected: boolean;
    onToggle: (id: string, index: number) => void;
    onRangeSelect: (id: string, index: number) => void;
}

function computeMargin(product: OzonProduct): number | null {
    if (!product.cost_price) return null;
    const raw =
        product.marketing_price && product.marketing_price !== '0' && product.marketing_price !== '0.00'
            ? product.marketing_price
            : product.price;
    const price = parseFloat(raw || '0');
    if (!price) return null;
    return ((price - product.cost_price) / price) * 100;
}

function marginColor(margin: number): string {
    if (margin >= 30) return 'var(--value-ok)';
    if (margin >= 10) return 'var(--value-warn)';
    return 'var(--value-bad)';
}

// SVG icon components (Lucide-style, 16x16)
const EditIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
        <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
);

const ChartIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
);

const StoreIcon = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        <polyline points="9 22 9 12 15 12 15 22" />
    </svg>
);

// Миниатюра товара с fallback на «—», если картинка не загрузилась
// (битые/истёкшие CDN-ссылки: Ozon multimedia-tmp item-pic-* отдают 403,
//  мёртвые ссылки продавцов у YM-товаров из offer.pictures)
const Thumbnail: React.FC<{ src: string; alt?: string }> = ({ src, alt }) => {
    const [errored, setErrored] = React.useState(false);
    if (errored) {
        return <div className="no-img">—</div>;
    }
    return (
        <>
            <img src={src} alt={alt} onError={() => setErrored(true)} />
            <img src={src} alt="" className="img-preview" />
        </>
    );
};

const ProductRow: React.FC<ProductRowProps> = ({
    product,
    index,
    onEditPrice,
    onShowHistory,
    visibleColumns,
    columnOrder,
    isSelected,
    onToggle,
    onRangeSelect,
}) => {
    const productIdStr = product.product_id.toString();
    const [crossStoreOpen, setCrossStoreOpen] = React.useState(false);
    const crossBtnRef = useRef<HTMLButtonElement>(null);

    const status = getProductStatus(product);
    const isProblem = status.level === 'quarantine' || status.level === 'price_rejected';
    const isWarning = status.level === 'promo_below_cost';

    const margin = computeMargin(product);

    const handleCheckboxChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        if (e.nativeEvent instanceof MouseEvent && (e.nativeEvent as MouseEvent).shiftKey) {
            onRangeSelect(productIdStr, index);
        } else {
            onToggle(productIdStr, index);
        }
    };

    const renderRefPrice = () => {
        if (!product.ref_price) {
            return <span style={{ color: 'var(--text-muted)' }}>-</span>;
        }

        const curr = parseFloat(
            product.marketing_price && product.marketing_price !== '0' && product.marketing_price !== '0.00'
                ? product.marketing_price
                : product.price || '0'
        );

        if (curr > 0) {
            const refPrice = parseFloat(String(product.ref_price));
            const diff = refPrice - curr;
            const pct = (diff / refPrice) * 100;

            let color = 'var(--value-ok)';
            if (pct > 5) color = 'var(--value-bad)';
            else if (pct > 0) color = 'var(--value-warn)';

            return (
                <div>
                    <div>{product.ref_price}</div>
                    <div className={styles.refPctBadge} style={{ color }}>
                        {pct > 0 ? '▼' : '▲'} {Math.abs(pct).toFixed(1)}%
                    </div>
                </div>
            );
        }

        return <div>{product.ref_price}</div>;
    };

    const rowClass = [
        isSelected ? styles.selectedRow : '',
        isProblem ? styles.problemRow : '',
        isWarning ? styles.warningRow : '',
    ].filter(Boolean).join(' ');

    const CELL_MAP: Partial<Record<ColumnKey, React.ReactNode>> = {
        status: (
            <td key="status" className={styles.statusCell}>
                <StatusBadge product={product} />
            </td>
        ),
        photo: (
            <td key="photo" className="img-cell">
                {product.primary_image ? (
                    <Thumbnail key={product.primary_image} src={product.primary_image} alt={product.name} />
                ) : (
                    <div className="no-img">—</div>
                )}
            </td>
        ),
        name: (
            <td key="name" className={styles.nameCell}>
                <div className="product-name">{product.name}</div>
                <div className="product-meta">{product.product_id} · {product.offer_id}</div>
            </td>
        ),
        price: (
            <td key="price" className="price-cell">
                {product.price}
            </td>
        ),
        marketing_price: (
            <td key="marketing_price" className="marketing-price-cell">
                {product.marketing_price && product.marketing_price !== '0' && product.marketing_price !== '0.00' ? (
                    <span className="marketing-tag">{product.marketing_price}</span>
                ) : '-'}
            </td>
        ),
        min_price: (
            <td key="min_price" className="min-price-cell">
                {product.min_price && product.min_price !== '0' ? (
                    <span>{product.min_price}</span>
                ) : '-'}
            </td>
        ),
        promo_price: (
            <td key="promo_price" className={styles.numericCell}>
                {product.in_promo && product.promo_price ? (() => {
                    const pp = product.promo_price;
                    const threshold = product.floor_min_price || product.cost_price || null;
                    let color = 'var(--value-ok)'; // green
                    if (threshold && pp < threshold) color = 'var(--value-bad)'; // red - below cost/floor
                    else if (product.ref_price && pp < Number(product.ref_price)) color = 'var(--value-warn)'; // yellow - below ref
                    return <span style={{ color, fontWeight: 600 }}>{pp.toLocaleString('ru-RU')} ₽</span>;
                })() : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                )}
            </td>
        ),
        ref_price: <td key="ref_price">{renderRefPrice()}</td>,
        old_price: (
            <td key="old_price" className="old-price-cell">
                {product.old_price && product.old_price !== '0' && product.old_price !== '0.00' ? (
                    <s>{product.old_price}</s>
                ) : '-'}
            </td>
        ),
        cost_price: (
            <td key="cost_price" className={styles.numericCell}>
                {product.cost_price != null ? (
                    <span>{product.cost_price.toLocaleString('ru-RU')} ₽</span>
                ) : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                )}
            </td>
        ),
        floor_min_price: (
            <td key="floor_min_price" className={styles.numericCell}>
                {product.floor_min_price != null ? (
                    <span style={{
                        color: parseFloat(product.min_price || '0') < product.floor_min_price ? 'var(--value-bad)' : '#22c55e',
                        fontWeight: 500
                    }}>
                        {product.floor_min_price.toLocaleString('ru-RU')} ₽
                    </span>
                ) : (
                    <span style={{ color: 'var(--text-muted)' }}>—</span>
                )}
            </td>
        ),
        margin: (
            <td key="margin" className={styles.numericCell}>
                {margin !== null ? (
                    <span style={{ color: marginColor(margin), fontWeight: 600 }}>
                        {margin.toFixed(1)}%
                    </span>
                ) : (
                    <span style={{ color: 'var(--text-muted)' }}>-</span>
                )}
            </td>
        ),
        stocks_fbo: (
            <td key="stocks_fbo" className={styles.numericCell}>
                {product.stocks_updated_at ? (
                    <Tooltip text={`Доступно на складах Ozon (present − reserved). Обновлено: ${new Date(product.stocks_updated_at).toLocaleString('ru-RU')}`} position="top">
                        <span style={{ color: (product.stocks_fbo ?? 0) > 0 ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: 600 }}>
                            {(product.stocks_fbo ?? 0).toLocaleString('ru-RU')}
                        </span>
                    </Tooltip>
                ) : (
                    <Tooltip text="Остатки ещё не синхронизированы. Запусти синхронизацию магазина." position="top">
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                    </Tooltip>
                )}
            </td>
        ),
        stocks_fbs: (
            <td key="stocks_fbs" className={styles.numericCell}>
                {product.stocks_updated_at ? (
                    <Tooltip text={`Доступно на складе продавца (present − reserved). Обновлено: ${new Date(product.stocks_updated_at).toLocaleString('ru-RU')}`} position="top">
                        <span style={{ color: (product.stocks_fbs ?? 0) > 0 ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: 600 }}>
                            {(product.stocks_fbs ?? 0).toLocaleString('ru-RU')}
                        </span>
                    </Tooltip>
                ) : (
                    <Tooltip text="Остатки ещё не синхронизированы. Запусти синхронизацию магазина." position="top">
                        <span style={{ color: 'var(--text-muted)' }}>—</span>
                    </Tooltip>
                )}
            </td>
        ),
        sales_30d: (
            <td key="sales_30d" className={styles.numericCell}>
                <span style={{ color: (product.sales_30d ?? 0) > 0 ? 'var(--text-primary)' : 'var(--text-muted)', fontWeight: 600 }}>
                    {(product.sales_30d ?? 0).toLocaleString('ru-RU')}
                </span>
            </td>
        ),
        risk: (
            <td key="risk" className={styles.numericCell}>
                {(() => {
                    const effective = parseFloat(
                        product.marketing_price && product.marketing_price !== '0' && product.marketing_price !== '0.00'
                            ? product.marketing_price
                            : product.price || '0'
                    );
                    if (!effective) return <Tooltip text="Нет цены — невозможно оценить риск" position="top"><span style={{ color: 'var(--text-muted)' }}>—</span></Tooltip>;
                    const cost = product.cost_price;
                    const ref = product.ref_price ? parseFloat(String(product.ref_price)) : null;
                    if (cost && effective < cost) {
                        const loss = ((cost - effective) / cost) * 100;
                        const lossRub = (cost - effective).toFixed(0);
                        return (
                            <Tooltip text={`Убыток: цена ${effective} ниже себестоимости ${cost} на ${lossRub} ₽ (${loss.toFixed(1)}%). Защити min_price!`} position="top">
                                <span style={{ color: 'var(--value-bad)', fontWeight: 700 }}>🔴 −{loss.toFixed(0)}%</span>
                            </Tooltip>
                        );
                    }
                    if (ref && ref > 0 && effective < ref * 0.9) {
                        const drop = ((ref - effective) / ref) * 100;
                        return (
                            <Tooltip text={`Провал: цена ${effective} ниже эталона ${ref} на ${drop.toFixed(1)}%. Проверь не в промо ли`} position="top">
                                <span style={{ color: '#f59e0b', fontWeight: 600 }}>🟡 −{drop.toFixed(0)}%</span>
                            </Tooltip>
                        );
                    }
                    if (!cost && !ref) return <Tooltip text="Нет cost_price и ref_price — невозможно оценить риск. Загрузи Excel с себестоимостью." position="top"><span style={{ color: 'var(--text-muted)' }}>—</span></Tooltip>;
                    return <Tooltip text="Цена не ниже себестоимости и не сильно отклоняется от эталона" position="top"><span style={{ color: 'var(--value-ok)' }}>✓</span></Tooltip>;
                })()}
            </td>
        ),
    };

    return (
        <tr className={rowClass || undefined}>
            {/* Checkbox */}
            <td className={styles.checkboxCell}>
                <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={handleCheckboxChange}
                    className={styles.checkbox}
                    onClick={(e) => e.stopPropagation()}
                />
            </td>

            {columnOrder.map((col) => visibleColumns.has(col) ? CELL_MAP[col] : null)}

            {/* Actions — sticky right, SVG icons with tooltips */}
            <td className={styles.actionsCell}>
                <div className={styles.actionButtons}>
                    <button
                        onClick={() => onEditPrice(product)}
                        className={styles.iconBtn}
                        title="Изменить цену"
                    >
                        <EditIcon />
                    </button>
                    <button
                        onClick={() => onShowHistory(product)}
                        className={styles.iconBtn}
                        title="История цен"
                    >
                        <ChartIcon />
                    </button>
                    <button
                        ref={crossBtnRef}
                        onClick={() => setCrossStoreOpen((v) => !v)}
                        className={styles.iconBtn}
                        title="Сравнение по магазинам"
                    >
                        <StoreIcon />
                    </button>
                </div>
                {crossStoreOpen && (
                    <CrossStorePopup
                        offerId={product.offer_id}
                        triggerRef={crossBtnRef}
                        onClose={() => setCrossStoreOpen(false)}
                    />
                )}
            </td>
        </tr>
    );
};

export default ProductRow;
