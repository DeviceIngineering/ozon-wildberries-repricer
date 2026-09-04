import { useState, useCallback } from 'react';
import { parseFormula, applyFormula, type Formula } from '../../utils/formulaParser';
import type { OzonProduct } from '../../services/ozonApi';
import { errorMessage } from '../../services/apiError';
import styles from './FormulaBar.module.css';

export type FieldType = 'price' | 'min_price' | 'old_price';

export interface FormulaResult {
  offerId: string;
  product: OzonProduct;
  field: FieldType;
  oldValue: number;
  newValue: number;
}

interface FormulaBarProps {
  products: OzonProduct[];
  onCalculate: (results: FormulaResult[]) => void;
}

function getFieldLabel(field: FieldType): string {
  switch (field) {
    case 'price': return 'Цена';
    case 'min_price': return 'Мин. цена';
    case 'old_price': return 'Старая цена';
  }
}

function getProductField(product: OzonProduct, field: FieldType): number {
  switch (field) {
    case 'price': return parseFloat(String(product.price || '0'));
    case 'min_price': return parseFloat(String(product.min_price || '0'));
    case 'old_price': return parseFloat(String(product.old_price || '0'));
  }
}

export default function FormulaBar({ products, onCalculate }: FormulaBarProps) {
  const [field, setField] = useState<FieldType>('price');
  const [formulaInput, setFormulaInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const validate = useCallback((input: string): Formula | null => {
    if (!input.trim()) {
      setError(null);
      return null;
    }
    try {
      const formula = parseFormula(input);
      setError(null);
      return formula;
    } catch (e) {
      setError(errorMessage(e));
      return null;
    }
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setFormulaInput(value);
    validate(value);
  };

  const handleCalculate = () => {
    const formula = validate(formulaInput);
    if (!formula) return;

    const results: FormulaResult[] = [];
    for (const product of products) {
      const oldValue = getProductField(product, field);
      if (oldValue <= 0) continue;
      try {
        const newValue = applyFormula(formula, oldValue);
        results.push({
          offerId: product.offer_id,
          product,
          field,
          oldValue,
          newValue,
        });
      } catch {
        // skip products where formula fails (e.g. negative result)
      }
    }
    onCalculate(results);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleCalculate();
  };

  return (
    <div className={styles.bar}>
      <div className={styles.fieldGroup}>
        <label className={styles.label}>Поле:</label>
        <select
          className={styles.select}
          value={field}
          onChange={(e) => setField(e.target.value as FieldType)}
        >
          <option value="price">Цена</option>
          <option value="min_price">Мин. цена</option>
          <option value="old_price">Старая цена</option>
        </select>
      </div>

      <div className={styles.inputGroup}>
        <label className={styles.label}>Формула:</label>
        <div className={styles.inputWrapper}>
          <input
            type="text"
            className={`${styles.input} ${error ? styles.inputError : ''}`}
            value={formulaInput}
            onChange={handleInputChange}
            onKeyDown={handleKeyDown}
            placeholder="+30%, -15%, =500, *1.5, /2"
          />
          {error && <span className={styles.errorMsg}>{error}</span>}
        </div>
      </div>

      <button
        className={styles.calcBtn}
        onClick={handleCalculate}
        disabled={!formulaInput.trim() || !!error}
      >
        Рассчитать
      </button>

      <div className={styles.hint}>
        <span className={styles.hintText}>
          Применить к <strong>{getFieldLabel(field)}</strong> для {products.length} товаров
        </span>
      </div>
    </div>
  );
}
