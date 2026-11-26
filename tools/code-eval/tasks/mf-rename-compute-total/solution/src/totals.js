/**
 * computeTotal: sums the line items (priceCents * qty), subtracts discountCents
 * (never going below zero) and adds taxPercent of the result, rounded.
 */
export function computeTotal(items, { taxPercent = 0, discountCents = 0 } = {}) {
    if (!Array.isArray(items)) throw new TypeError("computeTotal: items must be an array");
    const subtotal = items.reduce((sum, item) => sum + item.priceCents * item.qty, 0);
    const taxable = Math.max(0, subtotal - discountCents);
    return taxable + Math.round((taxable * taxPercent) / 100);
}
