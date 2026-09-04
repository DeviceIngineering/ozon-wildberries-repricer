import { useState, useRef, useCallback } from 'react';
import type { OzonProduct } from '../../services/ozonApi';
import styles from './InlineEditTable.module.css';

export type PriceField = 'price' | 'min_price' | 'old_price';

export interface InlineChange {
  price?: number;
  minPrice?: number;
  oldPrice?: number;
}

interface InlineEditTableProps {
  products: OzonProduct[];
  onChange: (changes: Map<string, InlineChange>) => void;
}

interface EditCell {
  offerId: string;
  field: PriceField;
}

// Ozon отдаёт цену строкой, WB — числом; String() повторяет то приведение,
// которое parseFloat и так делал бы сам.
function parsePrice(val: string | number | null | undefined): number {
  return parseFloat(String(val || '0')) || 0;
}

function formatPrice(value: number): string {
  if (value === 0) return '—';
  return value.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

const FIELDS: { key: PriceField; label: string }[] = [
  { key: 'price', label: 'Цена' },
  { key: 'min_price', label: 'Мин. цена' },
  { key: 'old_price', label: 'Старая цена' },
];

export default function InlineEditTable({ products, onChange }: InlineEditTableProps) {
  const [changes, setChanges] = useState<Map<string, InlineChange>>(new Map());
  const [activeCell, setActiveCell] = useState<EditCell | null>(null);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const getCellValue = useCallback(
    (product: OzonProduct, field: PriceField): number => {
      const ch = changes.get(product.offer_id);
      if (ch) {
        if (field === 'price' && ch.price !== undefined) return ch.price;
        if (field === 'min_price' && ch.minPrice !== undefined) return ch.minPrice;
        if (field === 'old_price' && ch.oldPrice !== undefined) return ch.oldPrice;
      }
      return parsePrice(product[field]);
    },
    [changes]
  );

  const isChanged = useCallback(
    (offerId: string, field: PriceField): boolean => {
      const ch = changes.get(offerId);
      if (!ch) return false;
      if (field === 'price') return ch.price !== undefined;
      if (field === 'min_price') return ch.minPrice !== undefined;
      if (field === 'old_price') return ch.oldPrice !== undefined;
      return false;
    },
    [changes]
  );

  const startEdit = (product: OzonProduct, field: PriceField) => {
    const val = getCellValue(product, field);
    setActiveCell({ offerId: product.offer_id, field });
    setEditValue(val === 0 ? '' : String(val));
    setTimeout(() => {
      inputRef.current?.select();
    }, 0);
  };

  const commitEdit = useCallback(
    (offerId: string, field: PriceField, raw: string) => {
      const num = parseFloat(raw.replace(',', '.'));
      if (!isNaN(num) && num >= 0) {
        setChanges((prev) => {
          const next = new Map(prev);
          const existing = next.get(offerId) || {};
          if (field === 'price') next.set(offerId, { ...existing, price: num });
          else if (field === 'min_price') next.set(offerId, { ...existing, minPrice: num });
          else if (field === 'old_price') next.set(offerId, { ...existing, oldPrice: num });
          onChange(next);
          return next;
        });
      }
      setActiveCell(null);
      setEditValue('');
    },
    [onChange]
  );

  const cancelEdit = () => {
    setActiveCell(null);
    setEditValue('');
  };

  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLInputElement>,
    product: OzonProduct,
    field: PriceField,
    rowIndex: number,
    fieldIndex: number
  ) => {
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      commitEdit(product.offer_id, field, editValue);

      // Move to next cell
      let nextFieldIndex = fieldIndex + 1;
      let nextRowIndex = rowIndex;
      if (nextFieldIndex >= FIELDS.length) {
        nextFieldIndex = 0;
        nextRowIndex = rowIndex + 1;
      }
      if (nextRowIndex < products.length) {
        const nextProduct = products[nextRowIndex];
        const nextField = FIELDS[nextFieldIndex].key;
        setTimeout(() => startEdit(nextProduct, nextField), 10);
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cancelEdit();
    }
  };

  const changedCount = changes.size;

  if (products.length === 0) {
    return (
      <div className={styles.empty}>
        <p>Нет товаров для редактирования</p>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.th}>Артикул</th>
              <th className={styles.th}>Название</th>
              {FIELDS.map((f) => (
                <th key={f.key} className={styles.th}>{f.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {products.map((product, rowIndex) => (
              <tr key={product.offer_id} className={styles.row}>
                <td className={styles.td}>
                  <span className={styles.offerId}>{product.offer_id}</span>
                </td>
                <td className={styles.td}>
                  <span className={styles.name} title={product.name}>
                    {product.name || '—'}
                  </span>
                </td>
                {FIELDS.map((f, fieldIndex) => {
                  const isActive =
                    activeCell?.offerId === product.offer_id && activeCell?.field === f.key;
                  const changed = isChanged(product.offer_id, f.key);
                  const displayVal = getCellValue(product, f.key);

                  return (
                    <td
                      key={f.key}
                      className={`${styles.td} ${styles.priceCell} ${changed ? styles.cellChanged : ''}`}
                      onClick={() => !isActive && startEdit(product, f.key)}
                    >
                      {isActive ? (
                        <input
                          ref={inputRef}
                          type="number"
                          className={styles.cellInput}
                          value={editValue}
                          onChange={(e) => setEditValue(e.target.value)}
                          onKeyDown={(e) => handleKeyDown(e, product, f.key, rowIndex, fieldIndex)}
                          onBlur={() => commitEdit(product.offer_id, f.key, editValue)}
                          min={0}
                          step={0.01}
                          autoFocus
                        />
                      ) : (
                        <span className={styles.cellValue}>
                          {formatPrice(displayVal)}
                        </span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {changedCount > 0 && (
        <div className={styles.summary}>
          Изменено: <strong>{changedCount}</strong> товаров
        </div>
      )}
    </div>
  );
}
