import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';

// apiKeyAuth transitively requires db/connection.cjs, which opens DB_PATH on
// import. Without this the suite creates a stray database in the repo root.
process.env.DB_PATH = path.join(os.tmpdir(), `apikey-test-${process.pid}-${Date.now()}.db`);

const require = createRequire(import.meta.url);
const { safeEqual, extractKey } = require('../../middleware/apiKeyAuth.cjs');

describe('safeEqual (timing-safe)', () => {
    it('равные строки → true', () => {
        expect(safeEqual('abc123', 'abc123')).toBe(true);
    });
    it('разные строки → false', () => {
        expect(safeEqual('abc123', 'abc124')).toBe(false);
    });
    it('разная длина → false без исключения', () => {
        expect(safeEqual('abc', 'abcdef')).toBe(false);
    });
    it('пустые → true только если оба пустые', () => {
        expect(safeEqual('', '')).toBe(true);
        expect(safeEqual('x', '')).toBe(false);
    });
});

describe('extractKey', () => {
    it('Bearer-заголовок', () => {
        expect(extractKey({ headers: { authorization: 'Bearer my-secret' } })).toBe('my-secret');
    });
    it('X-API-Key заголовок', () => {
        expect(extractKey({ headers: { 'x-api-key': 'k2' } })).toBe('k2');
    });
    it('нет заголовков → пустая строка', () => {
        expect(extractKey({ headers: {} })).toBe('');
    });
    it('Bearer имеет приоритет над X-API-Key', () => {
        expect(extractKey({ headers: { authorization: 'Bearer a', 'x-api-key': 'b' } })).toBe('a');
    });
});
