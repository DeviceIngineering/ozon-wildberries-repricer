import { describe, it, expect } from 'vitest';
import { parseFormula, applyFormula } from '../formulaParser';

describe('parseFormula', () => {
  it('parses +30%', () => {
    expect(parseFormula('+30%')).toEqual({ operator: '+', value: 30, isPercent: true });
  });
  it('parses -15%', () => {
    expect(parseFormula('-15%')).toEqual({ operator: '-', value: 15, isPercent: true });
  });
  it('parses =500', () => {
    expect(parseFormula('=500')).toEqual({ operator: '=', value: 500, isPercent: false });
  });
  it('parses +100', () => {
    expect(parseFormula('+100')).toEqual({ operator: '+', value: 100, isPercent: false });
  });
  it('parses *1.5', () => {
    expect(parseFormula('*1.5')).toEqual({ operator: '*', value: 1.5, isPercent: false });
  });
  it('parses /2', () => {
    expect(parseFormula('/2')).toEqual({ operator: '/', value: 2, isPercent: false });
  });
  it('throws on empty', () => {
    expect(() => parseFormula('')).toThrow('Введите формулу');
  });
  it('throws on invalid format', () => {
    expect(() => parseFormula('abc')).toThrow();
  });
});

describe('applyFormula', () => {
  it('+30% of 1000 = 1300', () => {
    expect(applyFormula({ operator: '+', value: 30, isPercent: true }, 1000)).toBe(1300);
  });
  it('-15% of 1000 = 850', () => {
    expect(applyFormula({ operator: '-', value: 15, isPercent: true }, 1000)).toBe(850);
  });
  it('=500 of anything = 500', () => {
    expect(applyFormula({ operator: '=', value: 500, isPercent: false }, 1000)).toBe(500);
  });
  it('+100 of 1000 = 1100', () => {
    expect(applyFormula({ operator: '+', value: 100, isPercent: false }, 1000)).toBe(1100);
  });
  it('*1.5 of 1000 = 1500', () => {
    expect(applyFormula({ operator: '*', value: 1.5, isPercent: false }, 1000)).toBe(1500);
  });
  it('/2 of 1000 = 500', () => {
    expect(applyFormula({ operator: '/', value: 2, isPercent: false }, 1000)).toBe(500);
  });
  it('/0 throws', () => {
    expect(() => applyFormula({ operator: '/', value: 0, isPercent: false }, 1000)).toThrow('Деление на ноль');
  });
  it('negative result throws', () => {
    expect(() => applyFormula({ operator: '-', value: 2000, isPercent: false }, 1000)).toThrow('не может быть отрицательной');
  });
});
