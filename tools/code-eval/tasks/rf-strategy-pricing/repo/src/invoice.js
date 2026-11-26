import { priceFor } from "./pricing.js";

const dollars = (cents) => (cents / 100).toFixed(2);

// A short plain-text invoice for one customer and basket.
export function renderInvoice(customer, basket) {
    const price = priceFor(customer, basket);
    const lines = basket.map((line) => `${line.qty} x ${line.name} @ ${dollars(line.unitCents)}`);
    lines.push(`Subtotal ${dollars(price.subtotal)}`);
    if (price.discount) lines.push(`Discount -${dollars(price.discount)}`);
    lines.push(`Shipping ${dollars(price.shipping)}`);
    lines.push(`Total ${dollars(price.total)}`);
    return lines.join("\n");
}
