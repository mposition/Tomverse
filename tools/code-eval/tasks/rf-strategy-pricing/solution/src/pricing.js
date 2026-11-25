// Prices a basket for a customer. All amounts are integer cents.
import { getStrategy } from "./strategies.js";

export function subtotalOf(basket) {
    return basket.reduce((sum, line) => sum + line.unitCents * line.qty, 0);
}

export function priceFor(customer, basket) {
    const strategy = getStrategy(customer.tier);
    const subtotal = subtotalOf(basket);
    const { discount, shipping } = strategy(subtotal);
    return { subtotal, discount, shipping, total: subtotal - discount + shipping };
}
