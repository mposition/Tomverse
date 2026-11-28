import { computeTotal } from "./totals.js";

const money = (cents) => (cents / 100).toFixed(2);

export function renderInvoice(items, options = {}) {
    const lines = items.map((item) => `${item.qty} x ${item.name}: ${money(item.priceCents * item.qty)}`);
    return ["Invoice", ...lines, `Total: ${money(computeTotal(items, options))}`].join("\n");
}
