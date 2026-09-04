/**
 * Ценовая математика Яндекс.Маркета (юнит-тестируемая, без сети).
 *
 * Floor = минимальная безубыточная цена продажи с учётом ВСЕХ удержаний Маркета:
 *   - процентные удержания из tariffs/calculate (комиссия категории, приём/перевод
 *     платежа, доставка покупателю и т.п.) → pctFees;
 *   - фиксированные удержания (средняя миля, сортировка) → absFees;
 *   - налог С ВЫРУЧКИ (УСН «Доходы») → taxPercent, считается от валовой цены продажи,
 *     а НЕ от нетто-после-комиссий (это и был баг старой формулы);
 *   - буст продаж (продвижение ставками) → boostPercent, % от цены продажи поверх
 *     комиссий. Не возвращается tariffs/calculate, берётся из факта (stats/orders).
 *
 * Все проценты, пропорциональные цене продажи (комиссии + налог + буст), собираются
 * в один знаменатель — тогда floor гарантирует нужную выручку продавца на руки.
 *
 *   floor = ⌈ (cost·(1+margin%) + absFees) / (1 − (pctFees% + tax% + boost%)/100) ⌉
 *
 * Отличие от Ozon/WB floor намеренное (там налог нестингом от нетто) — здесь налог
 * с валовой выручки, как требует УСН «Доходы».
 */

// Сумма пропорциональных удержаний, при которой floor не считаем (категория/данные битые)
const ANOMALY_PERCENT = 95;

/**
 * Минимальная безубыточная цена продажи для YM.
 * @param {object} p
 * @param {number} p.costPrice       себестоимость (₽)
 * @param {number} p.pctFees         сумма процентных удержаний Маркета (%), из tariffs/calculate
 * @param {number} p.absFees         сумма фиксированных удержаний (₽)
 * @param {number} p.taxPercent      налог с выручки (%), УСН «Доходы»
 * @param {number} [p.boostPercent]  ставка буста продаж (%), прогноз из факта продаж
 * @param {number} [p.marginPercent] желаемая мин. маржа (%)
 * @returns {number|null} floor (₽, округление вверх) либо null при некорректных данных/аномалии
 */
function computeYmFloor({ costPrice, pctFees, absFees = 0, taxPercent = 0, boostPercent = 0, marginPercent = 0 }) {
    if (!costPrice || costPrice <= 0) return null;
    const pct = (parseFloat(pctFees) || 0)
        + (parseFloat(taxPercent) || 0)
        + (parseFloat(boostPercent) || 0);
    // Знаменатель должен оставаться положительным с запасом — иначе цена улетает в бесконечность
    if (pct >= ANOMALY_PERCENT) return null;
    const netNeeded = costPrice * (1 + (parseFloat(marginPercent) || 0) / 100);
    const floor = (netNeeded + (parseFloat(absFees) || 0)) / (1 - pct / 100);
    return Math.ceil(floor);
}

/**
 * Фактическая выплата продавца «на руки» по конкретной продаже — для контроля
 * реальной убыточности (метрика YM_SOLD_BELOW_FLOOR). Комиссии вычитаются ЯВНО:
 *   payout = sellerPrice − sellerPrice·(pctFees+tax)/100 − absFees − boostAmount
 * где boostAmount — фактически списанный буст (₽) по заказу (bidFee из stats/orders).
 * @returns {number} выплата продавца (₽), может быть отрицательной
 */
function computeYmSellerPayout({ sellerPrice, pctFees = 0, absFees = 0, taxPercent = 0, boostAmount = 0 }) {
    const price = parseFloat(sellerPrice) || 0;
    const propPct = (parseFloat(pctFees) || 0) + (parseFloat(taxPercent) || 0);
    return price * (1 - propPct / 100) - (parseFloat(absFees) || 0) - (parseFloat(boostAmount) || 0);
}

module.exports = { computeYmFloor, computeYmSellerPayout, ANOMALY_PERCENT };
