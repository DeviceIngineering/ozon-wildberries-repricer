/**
 * Вычисляет old_price по правилам Ozon:
 * - old_price > price
 * - old_price >= 2 × min_price (если min_price задана)
 */
function computeOldPrice(price, minPrice) {
    const base = Math.round(price * 1.25);
    const minRequired = minPrice ? Math.round(minPrice * 2) : 0;
    return Math.max(base, minRequired, Math.round(price + 1));
}

module.exports = { computeOldPrice };
