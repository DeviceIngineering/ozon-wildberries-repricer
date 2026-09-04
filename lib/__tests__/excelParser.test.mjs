import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { parseNumber } = require('../excelParser.cjs');

describe('parseNumber (форматы Excel)', () => {
    it('пробел как разделитель тысяч ("1 300" → 1300, а не 1)', () => {
        expect(parseNumber('1 300')).toBe(1300);          // обычный пробел
        expect(parseNumber('1 300')).toBe(1300);     // неразрывный
        expect(parseNumber('1 300')).toBe(1300);     // тонкий
        expect(parseNumber('1 300')).toBe(1300);     // узкий неразрывный
        expect(parseNumber('1 234 567')).toBe(1234567);
    });
    it('запятая как десятичный разделитель', () => {
        expect(parseNumber('1 300,50')).toBe(1300.5);
        expect(parseNumber('99,9')).toBe(99.9);
    });
    it('обычные числа и числовой тип', () => {
        expect(parseNumber('300')).toBe(300);
        expect(parseNumber(300)).toBe(300);
    });
    it('пустые/некорректные → NaN', () => {
        expect(parseNumber('')).toBeNaN();
        expect(parseNumber(null)).toBeNaN();
        expect(parseNumber('abc')).toBeNaN();
    });
});
