/**
 * Общая логика парсинга Excel-файлов с ценами.
 * Используется в priceImporter и repricer (Ozon/WB).
 */
const xlsx = require('xlsx');

/**
 * Парсит число из ячейки Excel с учётом форматирования:
 *  - пробел/неразрывный/тонкий пробел как разделитель тысяч ("1 300" → 1300)
 *  - запятая как десятичный разделитель ("1 300,50" → 1300.50)
 * Без очистки parseFloat("1 300") вернул бы 1 (обрезает на первом пробеле).
 * \s в JS покрывает все юникод-пробелы: обычный, NBSP, тонкий, узкий.
 */
function parseNumber(v) {
    if (v == null || v === '') return NaN;
    if (typeof v === 'number') return v;
    const cleaned = String(v).replace(/\s/g, '').replace(',', '.');
    return parseFloat(cleaned);
}

/**
 * Ищет ключ (имя колонки) в объекте строки по массиву regex-паттернов.
 * @param {Object} row - строка из xlsx.utils.sheet_to_json
 * @param {RegExp[]} patterns - массив регулярных выражений для поиска
 * @returns {string|undefined} - найденный ключ или undefined
 */
function findColumnKey(row, patterns) {
    const keys = Object.keys(row);
    for (const pattern of patterns) {
        const found = keys.find(k => pattern.test(k.trim()));
        if (found) return found;
    }
    return undefined;
}

/** Стандартные паттерны колонок для файлов с ценами */
const COLUMN_PATTERNS = {
    offerId: [/артикул/i, /offer_?id/i],
    price: [/^цена$/i, /^price$/i, /цена продажи/i, /маркетинговая цена/i, /marketing/i],
    oldPrice: [/старая цена/i, /old_?price/i],
    minPrice: [/мин.*цена/i, /^мин\./i, /min_?price/i],
    costPrice: [/себестоимость/i, /cost/i, /cost_price/i],
};

/**
 * Парсит Excel-файл с ценами и возвращает структурированные данные.
 * @param {string} filePath - путь к файлу
 * @returns {{ updates: Array, errors: Array, totalRows: number }}
 */
function parseExcelPrices(filePath) {
    const workbook = xlsx.readFile(filePath);
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const data = xlsx.utils.sheet_to_json(sheet);

    const updates = [];
    const errors = [];

    for (const row of data) {
        const offerIdKey = findColumnKey(row, COLUMN_PATTERNS.offerId);
        const priceKey = findColumnKey(row, COLUMN_PATTERNS.price);
        const oldPriceKey = findColumnKey(row, COLUMN_PATTERNS.oldPrice);
        const minPriceKey = findColumnKey(row, COLUMN_PATTERNS.minPrice);
        const costPriceKey = findColumnKey(row, COLUMN_PATTERNS.costPrice);

        if (!offerIdKey || !priceKey) {
            errors.push({ row, error: 'Missing Articul or Price column' });
            continue;
        }

        const offerId = String(row[offerIdKey]).trim();
        const price = parseNumber(row[priceKey]);
        const oldPrice = oldPriceKey ? parseNumber(row[oldPriceKey]) : 0;
        const minPrice = minPriceKey ? parseNumber(row[minPriceKey]) : 0;

        // Skip instruction rows (marked with leading #)
        if (offerId.startsWith('#')) continue;

        if (!offerId || isNaN(price)) {
            errors.push({ offerId, error: 'Invalid data' });
            continue;
        }

        const update = { offerId, price, oldPrice, minPrice };

        // If costPrice column found, include it
        if (costPriceKey) {
            update.costPrice = parseNumber(row[costPriceKey]) || null;
        }

        updates.push(update);
    }

    return { updates, errors, totalRows: data.length };
}

/**
 * Строит Map<offerId, { price }> из Excel-файла (для repricer).
 * @param {string} filePath
 * @returns {Map<string, { price: number }>}
 */
function buildRefPriceMap(filePath) {
    const { updates } = parseExcelPrices(filePath);
    const map = new Map();
    for (const u of updates) {
        map.set(u.offerId, { price: u.price });
    }
    return map;
}

module.exports = { findColumnKey, parseExcelPrices, buildRefPriceMap, parseNumber, COLUMN_PATTERNS };
