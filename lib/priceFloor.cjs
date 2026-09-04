/**
 * Calculates the minimum price that still breaks even, for Ozon.
 *
 * floor = ceil((cost * (1 + margin%) / (1 - tax%) + logistics + acquiring) / (1 - commission%))
 *
 * Tax is nested on net revenue here. Yandex Market taxes gross revenue instead,
 * and Wildberries has its own commission and logistics model — see lib/ymFloor.cjs
 * and lib/wbPricing.cjs. The three are deliberately separate.
 *
 * @param {object}  p
 * @param {number}  p.costPrice        Cost of goods, required, > 0
 * @param {number}  p.commissionRate   Marketplace commission, percent, 0 < r < 100
 * @param {number} [p.logisticsAmount] Absolute logistics fee per unit
 * @param {number} [p.acquiringAmount] Absolute acquiring fee per unit
 * @param {number}  p.taxRate          Tax rate, percent, 0 <= r < 100
 * @param {number} [p.marginPercent]   Target margin on top of cost, percent
 * @returns {number|null} Floor price, or null when the inputs cannot support one
 */
function computeFloorMinPrice({ costPrice, commissionRate, logisticsAmount, acquiringAmount, taxRate, marginPercent = 0 }) {
    if (!costPrice || costPrice <= 0) return null;

    // A zero tax rate is a real rate (patent, self-employed, VAT-exempt), not a
    // missing value. Treating it as "unset" used to disable the floor guard
    // entirely for those sellers, while WB and Yandex kept protecting them.
    const tax = Number(taxRate) || 0;
    if (tax < 0 || tax >= 100) return null;

    if (!commissionRate || commissionRate <= 0 || commissionRate >= 100) return null;

    const netNeeded = costPrice * (1 + marginPercent / 100);
    const beforeTax = netNeeded / (1 - tax / 100);
    const floor = (beforeTax + (logisticsAmount || 0) + (acquiringAmount || 0)) / (1 - commissionRate / 100);
    return Math.ceil(floor);
}

module.exports = { computeFloorMinPrice };
