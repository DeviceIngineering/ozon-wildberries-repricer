export interface Formula {
  operator: '+' | '-' | '*' | '/' | '=';
  value: number;
  isPercent: boolean;
}

export function parseFormula(input: string): Formula {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Введите формулу');

  const match = trimmed.match(/^([+\-*/=])(\d+(?:\.\d+)?)(%)?\s*$/);
  if (!match) throw new Error('Неверный формат формулы');

  const operator = match[1] as Formula['operator'];
  const value = parseFloat(match[2]);
  const isPercent = match[3] === '%';

  // % only allowed for + and -
  if (isPercent && operator !== '+' && operator !== '-') {
    throw new Error('% допустим только для + и -');
  }

  return { operator, value, isPercent };
}

export function applyFormula(formula: Formula, currentPrice: number): number {
  let result: number;
  switch (formula.operator) {
    case '=':
      result = formula.value;
      break;
    case '+':
      result = formula.isPercent
        ? currentPrice * (1 + formula.value / 100)
        : currentPrice + formula.value;
      break;
    case '-':
      result = formula.isPercent
        ? currentPrice * (1 - formula.value / 100)
        : currentPrice - formula.value;
      break;
    case '*':
      result = currentPrice * formula.value;
      break;
    case '/':
      if (formula.value === 0) throw new Error('Деление на ноль');
      result = currentPrice / formula.value;
      break;
    default:
      throw new Error('Неизвестный оператор');
  }
  result = Math.round(result * 100) / 100; // round to 2 decimals
  if (result < 0) throw new Error('Цена не может быть отрицательной');
  return result;
}
