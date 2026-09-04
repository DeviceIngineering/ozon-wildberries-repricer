/**
 * Ценовая математика Wildberries (юнит-тестируемая, без сети).
 *
 * Стратегия (см. project_wb_repricer): держим РРЦ — целевая discountedPrice = max(РРЦ, floor),
 * базовая (зачёркнутая) цена остаётся «якорем», регулируем скидку продавца.
 * Floor считаем от discountedPrice (выручка продавца); СПП — соинвест WB, в floor не входит.
 */

/**
 * Минимальная безубыточная discountedPrice (выручка продавца) для WB.
 * Проценты (комиссия+эквайринг) и абсолют (логистика прямая + обратная×доля невыкупа) + налог с выручки.
 * В отличие от Ozon-формулы — работает и при налоге 0 (tax=0 трактуется как 0%, а не «выключено»),
 * чтобы безубыточная защита действовала даже когда продавец не указал ставку.
 */
function computeWbFloor({ costPrice, commissionPercent, acquiringPercent = 1.5, logisticsAmount, returnLogisticsAmount = 0, taxRate = 0, marginPercent = 0 }) {
    if (!costPrice || costPrice <= 0) return null;
    const commission = (commissionPercent || 0) + (acquiringPercent || 0);
    if (commission <= 0 || commission >= 100) return null;
    const tax = (taxRate > 0 && taxRate < 100) ? taxRate : 0;
    const netNeeded = costPrice * (1 + (marginPercent || 0) / 100);
    const beforeTax = netNeeded / (1 - tax / 100);
    const floor = (beforeTax + (logisticsAmount || 0) + (returnLogisticsAmount || 0)) / (1 - commission / 100);
    return Math.ceil(floor);
}

/**
 * Логистика прямого потока (короб) по объёму: база за первый литр + доп. литры.
 * @param {number} volumeLiters объём упаковки
 * @param {{base:number, liter:number}} tariff тариф склада
 */
function computeBoxLogistics(volumeLiters, tariff) {
    const v = volumeLiters > 0 ? volumeLiters : 1;
    const base = tariff?.base || 0;
    const liter = tariff?.liter || 0;
    const extraLiters = Math.max(0, Math.ceil(v) - 1);
    return base + extraLiters * liter;
}

/**
 * Пара {price, discount} под целевую discountedPrice.
 *
 * Стратегия: СОХРАНЯЕМ скидку продавца (глубина-якорь и сигнал под повышенную СПП),
 * двигаем базовую (зачёркнутую) цену: base = ceil(target / (1 - discount/100)).
 * Целочисленная скидка на сильно завышенной базе слишком груба, чтобы точно держать РРЦ,
 * поэтому регулируем именно базу. Округляем base ВВЕРХ → discountedPrice не ниже target (и floor).
 * Если валидной скидки-якоря нет (0 или вне 1..99) — держим цену напрямую (discount=0).
 *
 * @param {number} targetDiscountedPrice целевая цена продавца (max(РРЦ, floor))
 * @param {number} currentDiscount текущая скидка продавца, % (сохраняется)
 */
function computeWbPricePair(targetDiscountedPrice, currentDiscount) {
    const target = Math.ceil(targetDiscountedPrice);
    const discount = Math.round(currentDiscount || 0);
    if (!(discount >= 1 && discount <= 99)) {
        return { price: target, discount: 0 };
    }
    const base = Math.ceil(target / (1 - discount / 100));
    return { price: base, discount };
}

/** Фактическая discountedPrice из пары (для проверки floor перед отправкой). */
function discountedFromPair(price, discount) {
    return price * (1 - (discount || 0) / 100);
}

module.exports = { computeWbFloor, computeBoxLogistics, computeWbPricePair, discountedFromPair };
