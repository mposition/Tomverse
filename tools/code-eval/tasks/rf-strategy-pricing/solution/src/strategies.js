// Pricing strategies by customer tier. A strategy takes the subtotal in cents
// and returns { discount, shipping } in cents.

const strategies = new Map();

export function registerStrategy(tier, fn) {
    if (strategies.has(tier)) throw new Error(`tier already registered: ${tier}`);
    strategies.set(tier, fn);
}

export function getStrategy(tier) {
    const strategy = strategies.get(tier);
    if (!strategy) throw new Error(`unknown tier: ${tier}`);
    return strategy;
}

export function listTiers() {
    return [...strategies.keys()];
}

registerStrategy("standard", (subtotal) => ({ discount: 0, shipping: subtotal >= 10000 ? 0 : 500 }));

registerStrategy("silver", (subtotal) => ({ discount: Math.round(subtotal * 0.05), shipping: subtotal >= 8000 ? 0 : 500 }));

registerStrategy("gold", (subtotal) => {
    let discount = Math.round(subtotal * 0.1);
    if (subtotal >= 20000) discount += 500;
    return { discount, shipping: 0 };
});

registerStrategy("staff", (subtotal) => ({ discount: Math.min(Math.round(subtotal * 0.3), 5000), shipping: 0 }));
