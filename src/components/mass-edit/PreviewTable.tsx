import { useState, useMemo } from 'react';
import type { FormulaResult } from './FormulaBar';
import styles from './PreviewTable.module.css';

interface PreviewTableProps {
  results: FormulaResult[];
  onExcludedChange: (excludedIds: Set<string>) => void;
}

function formatPrice(value: number): string {
  return value.toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ₽';
}

export default function PreviewTable({ results, onExcludedChange }: PreviewTableProps) {
  const [excluded, setExcluded] = useState<Set<string>>(new Set());

  const toggleExclude = (offerId: string) => {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(offerId)) {
        next.delete(offerId);
      } else {
        next.add(offerId);
      }
      onExcludedChange(next);
      return next;
    });
  };

  const toggleAll = () => {
    if (excluded.size === results.length) {
      const next = new Set<string>();
      setExcluded(next);
      onExcludedChange(next);
    } else {
      const next = new Set(results.map((r) => r.offerId));
      setExcluded(next);
      onExcludedChange(next);
    }
  };

  const includedCount = results.length - excluded.size;

  const validResults = useMemo(
    () => results.filter((r) => r.newValue >= 0),
    [results]
  );

  if (validResults.length === 0) {
    return (
      <div className={styles.empty}>
        <p>Нажмите «Рассчитать» для предпросмотра изменений</p>
      </div>
    );
  }

  return (
    <div className={styles.wrapper}>
      <div className={styles.tableWrapper}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={styles.thCheck}>
                <input
                  type="checkbox"
                  checked={excluded.size === validResults.length && validResults.length > 0}
                  onChange={toggleAll}
                  title="Исключить все"
                />
              </th>
              <th className={styles.th}>Артикул</th>
              <th className={styles.th}>Название</th>
              <th className={styles.th}>Было</th>
              <th className={styles.th}>Стало</th>
              <th className={styles.th}>Маржа</th>
            </tr>
          </thead>
          <tbody>
            {validResults.map((r) => {
              const diff = r.newValue - r.oldValue;
              const isIncrease = diff > 0;
              const isDecrease = diff < 0;
              const costPrice = r.product.cost_price ?? null;
              const marginWarning = costPrice !== null && r.newValue < costPrice;
              const isExcluded = excluded.has(r.offerId);

              return (
                <tr
                  key={r.offerId}
                  className={`${styles.row} ${isExcluded ? styles.rowExcluded : ''}`}
                >
                  <td className={styles.tdCheck}>
                    <input
                      type="checkbox"
                      checked={isExcluded}
                      onChange={() => toggleExclude(r.offerId)}
                      title="Исключить"
                    />
                  </td>
                  <td className={styles.td}>
                    <span className={styles.offerId}>{r.offerId}</span>
                  </td>
                  <td className={styles.td}>
                    <span className={styles.name} title={r.product.name}>
                      {r.product.name || '—'}
                    </span>
                  </td>
                  <td className={styles.td}>
                    <span className={styles.oldValue}>{formatPrice(r.oldValue)}</span>
                  </td>
                  <td className={styles.td}>
                    <span
                      className={`${styles.newValue} ${isIncrease ? styles.increase : ''} ${isDecrease ? styles.decrease : ''}`}
                    >
                      {formatPrice(r.newValue)}
                      {isIncrease && <span className={styles.delta}> (+{formatPrice(diff)})</span>}
                      {isDecrease && <span className={styles.delta}> ({formatPrice(diff)})</span>}
                    </span>
                  </td>
                  <td className={styles.td}>
                    {costPrice !== null ? (
                      <span className={`${styles.margin} ${marginWarning ? styles.marginWarn : ''}`}>
                        {marginWarning ? `⚠ ниже себест.` : `${formatPrice(r.newValue - costPrice)}`}
                      </span>
                    ) : (
                      <span className={styles.marginEmpty}>—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className={styles.summary}>
        Будет обновлено: <strong>{includedCount}</strong> из <strong>{validResults.length}</strong> товаров
        {excluded.size > 0 && (
          <span className={styles.excludedNote}> ({excluded.size} исключено)</span>
        )}
      </div>
    </div>
  );
}
