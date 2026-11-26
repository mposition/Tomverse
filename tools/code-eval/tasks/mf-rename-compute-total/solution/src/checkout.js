import * as totals from "./totals.js";

export function checkout(cart, payment) {
    const amount = totals.computeTotal(cart.items, cart.options);
    if (payment.balanceCents < amount) return { ok: false, amount, reason: "insufficient funds" };
    return { ok: true, amount, remaining: payment.balanceCents - amount };
}
