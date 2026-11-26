import { lineDiscount } from "./discounts.js";
import { sum } from "./money.js";
import { taxFor } from "./tax.js";

export function cartTotals(lines, { taxRatePercent = 0, freeShippingFromCents = 5000, shippingCents = 599 } = {}) {
    const subtotals = lines.map((line) => line.priceCents * line.qty);
    const discounts = lines.map((line, i) => lineDiscount(subtotals[i], line.discount));
    const subtotal = sum(subtotals);
    const discount = sum(discounts);
    const taxable = subtotal - discount;
    const tax = taxFor(taxable, taxRatePercent);
    const shipping = lines.length === 0 ? 0 : taxable >= freeShippingFromCents ? 0 : shippingCents;
    return { subtotal, discount, taxable, tax, shipping, total: taxable + tax + shipping };
}
