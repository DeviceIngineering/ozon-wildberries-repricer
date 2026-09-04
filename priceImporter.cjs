const fs = require('fs');
const db = require('./db.cjs');
const fetcher = require('./ozonFetcher.cjs');
const { parseExcelPrices } = require('./lib/excelParser.cjs');

async function processImport(importId) {
    const priceImport = await db.getPriceImportById(importId);

    if (!priceImport) throw new Error(`Import ${importId} not found`);

    try {
        const { updates, errors, totalRows } = parseExcelPrices(priceImport.file_path);

        if (updates.length === 0) {
            throw new Error("No valid price updates found in file");
        }

        // Save reference prices to DB (for Repricer/UI). Для WB offer_id = vendorCode.
        for (const u of updates) {
            await db.updateProductRefPrice(priceImport.store_id, u.offerId, u.price, u.minPrice);
            // Save cost price if present
            if (u.costPrice != null) {
                await db.updateProductCostPrice(priceImport.store_id, u.offerId, u.costPrice);
            }
        }

        const store = await db.getStoreById(priceImport.store_id);

        let apiResponse = null;
        if (store.platform === 'wildberries') {
            // WB: импорт только задаёт эталон (себестоимость + РРЦ).
            // Цены на площадку применяет репрайсер (держит РРЦ через discount, floor по юнит-экономике),
            // прямой пуш из импорта НЕ делаем — иначе сломаем стратегию price+discount и можем уронить в карантин.
            apiResponse = { skipped: 'WB: reference saved, prices applied by repricer' };
        } else {
            // Ozon: эталон + немедленная отправка цен на площадку
            const ozonUpdates = updates.map(u => ({
                offer_id: u.offerId,
                price: String(u.price),
                old_price: u.oldPrice ? String(u.oldPrice) : "0",
                min_price: u.minPrice ? String(u.minPrice) : "0",
                currency_code: "RUB"
            }));
            apiResponse = await fetcher.updateProductPrices(store.client_id, store.api_key, ozonUpdates, priceImport.store_id, 'price-import');
        }

        const resultSummary = {
            total_rows: totalRows,
            valid_updates: updates.length,
            api_response: apiResponse,
            errors
        };

        await db.updatePriceImport(importId, 'COMPLETED', JSON.stringify(resultSummary));
        await cleanupOldFiles(priceImport.store_id);

        return resultSummary;

    } catch (err) {
        console.error("Import failed:", err);
        await db.updatePriceImport(importId, 'FAILED', JSON.stringify({ error: err.message }));
        throw err;
    }
}

async function cleanupOldFiles(storeId) {
    try {
        const filesToDelete = await db.getOldPriceImports(storeId, 3);
        for (const fileRecord of filesToDelete) {
            if (fileRecord.file_path && fs.existsSync(fileRecord.file_path)) {
                fs.unlinkSync(fileRecord.file_path);
            }
            await db.deletePriceImport(fileRecord.id);
        }
    } catch (e) {
        console.error("Cleanup failed:", e);
    }
}

module.exports = { processImport };
