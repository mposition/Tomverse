// Prices a basket for a customer. All amounts are integer cents.

export function subtotalOf(basket) {
    return basket.reduce((sum, line) => sum + line.unitCents * line.qty, 0);
}

export function priceFor(customer, basket) {
    const subtotal = subtotalOf(basket);
    let discount = 0;
    let shipping = 500;
    switch (customer.tier) {
        case "standard":
            if (subtotal >= 10000) shipping = 0;
            break;
        case "silver":
            discount = Math.round(subtotal * 0.05);
            if (subtotal >= 8000) shipping = 0;
            break;
        case "gold":
            discount = Math.round(subtotal * 0.1);
            if (subtotal >= 20000) discount += 500;
            shipping = 0;
            break;
        case "staff":
            discount = Math.min(Math.round(subtotal * 0.3), 5000);
            shipping = 0;
            break;
        default:
            throw new Error(`unknown tier: ${customer.tier}`);
    }
    return { subtotal, discount, shipping, total: subtotal - discount + shipping };
}
