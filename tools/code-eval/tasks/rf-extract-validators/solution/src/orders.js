import { validateAddress, validateItem, validateOrderInput } from "./validate.js";

let counter = 0;

export function createOrder(input) {
    const { email, address, items } = validateOrderInput(input);
    counter += 1;
    return { id: `order-${counter}`, email, address, items, status: "new" };
}

export function updateShipping(order, rawAddress = {}) {
    return { ...order, address: validateAddress(rawAddress) };
}

export function addItem(order, item) {
    return { ...order, items: [...order.items, validateItem(item, order.items.length)] };
}

export function orderTotal(order) {
    return order.items.reduce((sum, line) => sum + line.qty * line.priceCents, 0);
}
