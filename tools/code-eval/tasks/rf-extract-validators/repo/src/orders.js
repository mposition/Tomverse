import { ValidationError } from "./errors.js";

let counter = 0;
const EMAIL = /^[^@\s]+@[^@\s][^.@\s]*\.[^@\s]+$/;

export function createOrder(input) {
    const email = String(input?.email ?? "").trim().toLowerCase();
    if (!EMAIL.test(email)) throw new ValidationError("email", "email is not valid");

    const rawAddress = input.address ?? {};
    const address = {};
    for (const field of ["street", "city", "postalCode"]) {
        const value = String(rawAddress[field] ?? "").trim();
        if (!value) throw new ValidationError(`address.${field}`, `${field} is required`);
        address[field] = value;
    }
    if (!/^\d{4}$/.test(address.postalCode)) throw new ValidationError("address.postalCode", "postalCode must be 4 digits");

    if (!Array.isArray(input.items) || input.items.length === 0) throw new ValidationError("items", "at least one item is required");
    const items = input.items.map((item, index) => {
        const sku = String(item?.sku ?? "").trim();
        if (!sku) throw new ValidationError(`items.${index}.sku`, "sku is required");
        if (!Number.isInteger(item.qty) || item.qty < 1) throw new ValidationError(`items.${index}.qty`, "qty must be a positive integer");
        if (!Number.isInteger(item.priceCents) || item.priceCents < 0) {
            throw new ValidationError(`items.${index}.priceCents`, "priceCents must be a non-negative integer");
        }
        return { sku, qty: item.qty, priceCents: item.priceCents };
    });

    counter += 1;
    return { id: `order-${counter}`, email, address, items, status: "new" };
}

export function updateShipping(order, rawAddress = {}) {
    const address = {};
    for (const field of ["street", "city", "postalCode"]) {
        const value = String(rawAddress?.[field] ?? "").trim();
        if (!value) throw new ValidationError(`address.${field}`, `${field} is required`);
        address[field] = value;
    }
    if (!/^\d{4}$/.test(address.postalCode)) throw new ValidationError("address.postalCode", "postalCode must be 4 digits");
    return { ...order, address };
}

export function addItem(order, item) {
    const index = order.items.length;
    const sku = String(item?.sku ?? "").trim();
    if (!sku) throw new ValidationError(`items.${index}.sku`, "sku is required");
    if (!Number.isInteger(item.qty) || item.qty < 1) throw new ValidationError(`items.${index}.qty`, "qty must be a positive integer");
    if (!Number.isInteger(item.priceCents) || item.priceCents < 0) {
        throw new ValidationError(`items.${index}.priceCents`, "priceCents must be a non-negative integer");
    }
    return { ...order, items: [...order.items, { sku, qty: item.qty, priceCents: item.priceCents }] };
}

export function orderTotal(order) {
    return order.items.reduce((sum, item) => sum + item.qty * item.priceCents, 0);
}
