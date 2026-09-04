const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const xlsx = require('xlsx');
const db = require('../db.cjs');
const ozonFetcher = require('../ozonFetcher.cjs');
const yandexFetcher = require('../yandexFetcher.cjs');
const { parseExcelPrices } = require('../lib/excelParser.cjs');
const { validateId } = require('../middleware/validate.cjs');
const { computeOldPrice } = require('../lib/priceHelpers.cjs');
const wrap = require('../middleware/asyncHandler.cjs');

// Multer config — temp storage for preview
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR);

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + file.originalname.replace(/[^a-z0-9.]/gi, '_'));
    }
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });

// GET /stores/:id/price-import/template — generate Excel template with current products
router.get('/stores/:id/price-import/template', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const store = await db.getStoreById(storeId);
    if (!store) return res.status(404).json({ error: 'Магазин не найден' });

    const products = await db.getStoreProducts(storeId);

    // Row 1: headers, Row 2: instructions, Row 3+: data
    const HEADERS = ['Артикул', 'Название', 'Цена сейчас', 'Цена', 'Старая цена', 'Мин. цена', 'Себестоимость'];
    const INSTRUCTIONS = [
        '#ИНСТРУКЦИЯ: не изменять артикул',
        'НЕ ИЗМЕНЯТЬ',
        'Справка: текущая цена на площадке. НЕ редактировать — не импортируется',
        '*** ОБЯЗАТЕЛЬНО *** Эталонная цена. Репрайсер восстановит до этого значения если цена упадёт',
        'Необязательно. Зачёркнутая цена (старая цена)',
        'Необязательно. Минимальная допустимая цена',
        'Необязательно. Себестоимость — репрайсер не установит цену ниже',
    ];

    // Дедуп по артикулу: у товара может быть несколько карточек (nmID на WB) с одним vendorCode —
    // в шаблоне он должен быть ОДНОЙ строкой, иначе при импорте конфликт значений по артикулу.
    const seenOffers = new Set();
    const dataRows = [];
    for (const p of products) {
        const offer = p.offer_id || '';
        if (offer && seenOffers.has(offer)) continue;
        if (offer) seenOffers.add(offer);
        dataRows.push([
            offer,
            p.name || '',
            p.marketing_price || p.price || '',
            p.ref_price || p.marketing_price || p.price || '',
            p.old_price || '',
            p.min_price || '',
            p.cost_price || '',
        ]);
    }

    const ws = xlsx.utils.aoa_to_sheet([HEADERS, INSTRUCTIONS, ...dataRows]);

    // Column widths
    ws['!cols'] = [
        { wch: 22 },  // Артикул
        { wch: 45 },  // Название
        { wch: 22 },  // Цена Ozon сейчас
        { wch: 22 },  // Цена
        { wch: 16 },  // Старая цена
        { wch: 14 },  // Мин. цена
        { wch: 18 },  // Себестоимость
    ];

    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Цены');

    const storeName = (store.name || 'store').replace(/[^a-zA-Zа-яА-Я0-9_-]/g, '_');
    const filename = `template_prices_${storeName}.xlsx`;

    const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
}));

// POST /stores/:id/price-import/preview — parse Excel, validate, return preview
router.post('/stores/:id/price-import/preview', validateId('id'), upload.single('file'), wrap(async (req, res) => {
    const storeId = req.params.id;
    if (!req.file) return res.status(400).json({ error: 'Файл не загружен' });

    let filePath = req.file.path;
    try {
        // Parse Excel
        const { updates, errors, totalRows } = parseExcelPrices(filePath);

        if (updates.length === 0) {
            // Невалидный файл — удаляем сразу
            try { fs.unlinkSync(filePath); } catch (e) {}
            filePath = null;
            return res.status(400).json({
                error: 'Не найдены валидные строки. Проверьте формат файла (колонки: Артикул, Цена)',
                parseErrors: errors
            });
        }

        // Файл НЕ удаляем — нужен для server-side сохранения (фронт пришлёт только выбор + importId).
        // Регистрируем импорт, чтобы save мог перечитать файл по id. cleanupOldFiles ротирует старые.
        const importId = await db.createPriceImport(storeId, req.file.originalname, filePath);
        filePath = null; // файл зарегистрирован — не удалять в catch

        // Get all products from catalog
        const products = await db.getStoreProducts(storeId);
        const catalogMap = new Map();
        products.forEach(p => {
            catalogMap.set(p.offer_id, {
                name: p.name,
                currentPrice: parseFloat(p.price || p.marketing_price || 0),
                refPrice: p.ref_price ? parseFloat(p.ref_price) : null,
            });
        });

        // Build preview items
        const items = [];
        const unknownOfferIds = [];
        const seenOfferIds = new Set();

        for (const update of updates) {
            const offerId = update.offerId || update.offer_id;
            if (!offerId || seenOfferIds.has(offerId)) continue;
            seenOfferIds.add(offerId);

            const catalogItem = catalogMap.get(offerId);
            if (!catalogItem) {
                unknownOfferIds.push(offerId);
                continue;
            }

            const newPrice = parseFloat(update.price);
            const currentPrice = catalogItem.currentPrice;
            const deviationPercent = currentPrice > 0 ? ((newPrice - currentPrice) / currentPrice) * 100 : 0;
            const deviationFromRef = catalogItem.refPrice ? ((newPrice - catalogItem.refPrice) / catalogItem.refPrice) * 100 : null;
            const blocked = Math.abs(deviationPercent) > 20;

            items.push({
                offer_id: offerId,
                name: catalogItem.name,
                currentPrice,
                newPrice,
                oldPrice: update.oldPrice ? parseFloat(update.oldPrice) : null,
                minPrice: update.minPrice ? parseFloat(update.minPrice) : null,
                costPrice: update.costPrice ? parseFloat(update.costPrice) : null,
                refPrice: catalogItem.refPrice,
                deviationPercent: Math.round(deviationPercent * 10) / 10,
                deviationFromRef: deviationFromRef !== null ? Math.round(deviationFromRef * 10) / 10 : null,
                blocked,
                unlocked: false,
            });
        }

        // Missing products (in catalog but not in file)
        const fileOfferIds = new Set(updates.map(u => u.offerId || u.offer_id));
        const missingProducts = products
            .filter(p => p.offer_id && !fileOfferIds.has(p.offer_id))
            .map(p => ({ offer_id: p.offer_id, name: p.name }));

        res.json({
            totalInFile: totalRows,
            totalInCatalog: products.length,
            matchedCount: items.length,
            missingInFile: missingProducts.length,
            notFoundInCatalog: unknownOfferIds.length,
            blockedCount: items.filter(i => i.blocked).length,
            items,
            missingProducts,
            unknownOfferIds,
            parseErrors: errors,
            originalFilename: req.file.originalname,
            importId,
        });
    } catch (err) {
        // Cleanup temp file on error before rethrowing
        if (filePath) try { fs.unlinkSync(filePath); } catch (e) {}
        throw err;
    }
}));

// POST /stores/:id/price-import/ref-only — save ref prices without sending to Ozon
router.post('/stores/:id/price-import/ref-only', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const { items, originalFilename } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Нет позиций для сохранения' });
    }

    const store = await db.getStoreById(storeId);
    if (!store) return res.status(404).json({ error: 'Магазин не найден' });

    for (const item of items) {
        await db.updateProductRefPrice(storeId, item.offer_id, item.newPrice, item.minPrice);
        if (item.costPrice) {
            await db.updateProductCostPrice(storeId, item.offer_id, item.costPrice);
        }
    }

    // Create import record for history
    const importId = await db.createPriceImport(storeId, originalFilename || 'ref-import.xlsx', null);
    await db.updatePriceImport(importId, 'COMPLETED', JSON.stringify({
        total_items: items.length,
        mode: 'ref-only',
    }));

    res.json({ success: true, saved_count: items.length });
}));

// POST /stores/:id/price-import/ref-only-server — server-side сохранение эталона.
// Фронт шлёт только importId + выбранные артикулы + autoMinPercent (крошечное тело, без лимита).
// Сервер перечитывает уже загруженный файл и берёт цены/себестоимость из него.
router.post('/stores/:id/price-import/ref-only-server', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const { importId, offerIds, autoMinPercent } = req.body;

    if (!importId) return res.status(400).json({ error: 'Нет importId (перезагрузите файл)' });
    if (!Array.isArray(offerIds) || offerIds.length === 0) {
        return res.status(400).json({ error: 'Нет выбранных позиций' });
    }

    const store = await db.getStoreById(storeId);
    if (!store) return res.status(404).json({ error: 'Магазин не найден' });

    const imp = await db.getPriceImportById(importId);
    if (!imp || String(imp.store_id) !== String(storeId) || !imp.file_path) {
        return res.status(400).json({ error: 'Файл импорта не найден — перезагрузите' });
    }
    if (!fs.existsSync(imp.file_path)) {
        return res.status(400).json({ error: 'Файл импорта удалён — перезагрузите' });
    }

    // Перечитываем файл и строим карту по артикулу.
    // ПЕРВОЕ вхождение (как в preview) — при дублях строк одного артикула в файле
    // (товар с несколькими карточками nmID) save и preview должны выбирать одну и ту же строку.
    const { updates } = parseExcelPrices(imp.file_path);
    const byOffer = new Map();
    for (const u of updates) if (!byOffer.has(u.offerId)) byOffer.set(u.offerId, u);
    const pct = Number(autoMinPercent) || 0;

    let saved = 0;
    const sel = new Set(offerIds.map(String));
    for (const offerId of sel) {
        const u = byOffer.get(offerId);
        if (!u) continue;
        const newPrice = parseFloat(u.price);
        if (!(newPrice > 0)) continue;
        let minPrice = (u.minPrice && u.minPrice > 0) ? u.minPrice : (pct > 0 ? Math.ceil(newPrice * pct / 100) : null);
        await db.updateProductRefPrice(storeId, offerId, newPrice, minPrice);
        if (u.costPrice) await db.updateProductCostPrice(storeId, offerId, u.costPrice);
        saved++;
    }

    await db.updatePriceImport(importId, 'COMPLETED', JSON.stringify({ total_items: saved, mode: 'ref-only-server' }));
    // Последний загруженный файл СОХРАНЯЕМ (для аудита/повторной сверки), ротация — храним 2 на магазин
    try {
        const old = await db.getOldPriceImports(storeId, 2);
        for (const o of old) { if (o.file_path && fs.existsSync(o.file_path)) { try { fs.unlinkSync(o.file_path); } catch {} } await db.deletePriceImport(o.id); }
    } catch (e) {}

    res.json({ success: true, saved_count: saved });
}));

// POST /stores/:id/price-import — send validated items to Ozon
router.post('/stores/:id/price-import', validateId('id'), wrap(async (req, res) => {
    const storeId = req.params.id;
    const { items, originalFilename } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ error: 'Нет позиций для отправки' });
    }

    const store = await db.getStoreById(storeId);
    if (!store) return res.status(404).json({ error: 'Магазин не найден' });

    // Save ref prices to products
    for (const item of items) {
        await db.updateProductRefPrice(storeId, item.offer_id, item.newPrice, item.minPrice);
        if (item.costPrice) {
            await db.updateProductCostPrice(storeId, item.offer_id, item.costPrice);
        }
    }

    // Create snapshot before sending to Ozon
    const snapshotData = items.map(i => ({
        offer_id: i.offer_id,
        price: i.currentPrice,
        old_price: i.oldPrice,
        min_price: i.minPrice,
    }));
    await db.createSnapshot(storeId, 'price-import', items.length, JSON.stringify(snapshotData), 'manual', `Excel: ${originalFilename || 'import'}`);

    // Send prices to marketplace
    let apiResponse;
    if (store.platform === 'yandex') {
        const ymUpdates = items.map(i => ({
            offerId: i.offer_id,
            price: { value: i.newPrice, currencyId: 'RUR' },
        }));
        apiResponse = await yandexFetcher.updatePrices(store.ym_campaign_id, store.ym_api_key, ymUpdates, storeId, 'price-import');
    } else {
        const ozonUpdates = items.map(i => {
            const effectiveMinPrice = i.minPrice || i.newPrice;
            return {
                offer_id: i.offer_id,
                price: String(i.newPrice),
                old_price: i.oldPrice ? String(i.oldPrice) : String(computeOldPrice(i.newPrice, effectiveMinPrice)),
                min_price: String(effectiveMinPrice),
                currency_code: 'RUB',
            };
        });
        apiResponse = await ozonFetcher.updateProductPrices(store.client_id, store.api_key, ozonUpdates, storeId, 'price-import');
    }

    // Update local data_json prices so dashboard widget reflects new prices immediately
    for (const item of items) {
        const effectiveMin = item.minPrice || item.newPrice;
        const effectiveOld = item.oldPrice || computeOldPrice(item.newPrice, effectiveMin);
        await db.updateProductLocalPrice(storeId, item.offer_id, item.newPrice, effectiveMin, effectiveOld);
    }

    // Create import record for history
    const importId = await db.createPriceImport(storeId, originalFilename || 'import.xlsx', null);
    await db.updatePriceImport(importId, 'COMPLETED', JSON.stringify({
        total_items: items.length,
        ozon_response: apiResponse,
    }));

    // Create pending verification records
    const verifyAfter = new Date(Date.now() + 3 * 60 * 1000).toISOString();
    const allProducts = await db.getStoreProducts(storeId);
    const productByOfferId = new Map(allProducts.map(p => [p.offer_id, p]));

    for (const item of items) {
        const product = productByOfferId.get(item.offer_id);
        if (product && product.id) {
            await db.createPendingUpdate({
                store_id: storeId,
                product_id: product.id, // PK products.id (FK), не Ozon product_id
                offer_id: item.offer_id,
                sent_price: item.newPrice,
                sent_min_price: item.minPrice || null,
                sent_old_price: item.oldPrice || null,
                verify_after: verifyAfter,
            });
        }
    }

    res.json({
        success: true,
        sent_count: items.length,
        ozon_response: apiResponse,
        item_errors: apiResponse?._itemErrors || [],
    });
}));

// Get price import history
router.get('/stores/:id/price-imports', validateId('id'), wrap(async (req, res) => {
    const history = await db.getRecentPriceImports(req.params.id, 3);
    res.json(history);
}));

// Download imported file
router.get('/stores/:id/price-imports/:importId/download', validateId('id'), validateId('importId'), wrap(async (req, res) => {
    const importRec = await db.getPriceImportById(req.params.importId);
    if (!importRec) {
        return res.status(404).json({ error: 'File record not found' });
    }

    if (String(importRec.store_id) !== String(req.params.id)) {
        return res.status(403).json({ error: 'Access denied to this file' });
    }

    if (!importRec.file_path) {
        return res.status(404).json({ error: 'File not stored on disk' });
    }

    const resolved = path.resolve(importRec.file_path);
    if (!resolved.startsWith(path.resolve(UPLOAD_DIR))) {
        return res.status(403).json({ error: 'Invalid file path' });
    }

    if (!fs.existsSync(resolved)) {
        return res.status(404).json({ error: 'File not found on disk' });
    }

    res.download(resolved, importRec.filename);
}));

// Product price history
router.get('/products/:productId/history', validateId('productId'), wrap(async (req, res) => {
    const history = await db.getProductPriceHistory(req.params.productId);
    res.json(history);
}));

module.exports = router;
