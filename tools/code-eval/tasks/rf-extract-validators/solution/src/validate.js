import { ValidationError } from "./errors.js";

const EMAIL = /^[^@\s]+@[^@\s][^.@\s]*\.[^@\s]+$/;

export function validateEmail(value) {
    const email = String(value ?? "").trim().toLowerCase();
    if (!EMAIL.test(email)) throw new ValidationError("email", "email is not valid");
    return email;
}

export function validateAddress(rawAddress, prefix = "address") {
    const source = rawAddress ?? {};
    const address = {};
    for (const field of ["street", "city", "postalCode"]) {
        const value = String(source[field] ?? "").trim();
        if (!value) throw new ValidationError(`${prefix}.${field}`, `${field} is required`);
        address[field] = value;
    }
    if (!/^\d{4}$/.test(address.postalCode)) throw new ValidationError(`${prefix}.postalCode`, "postalCode must be 4 digits");
    return address;
}

export function validateItem(item, index) {
    const sku = String(item?.sku ?? "").trim();
    if (!sku) throw new ValidationError(`items.${index}.sku`, "sku is required");
    if (!Number.isInteger(item.qty) || item.qty < 1) throw new ValidationError(`items.${index}.qty`, "qty must be a positive integer");
    if (!Number.isInteger(item.priceCents) || item.priceCents < 0) {
        throw new ValidationError(`items.${index}.priceCents`, "priceCents must be a non-negative integer");
    }
    return { sku, qty: item.qty, priceCents: item.priceCents };
}

export function validateOrderInput(input) {
    const email = validateEmail(input?.email);
    const address = validateAddress(input.address);
    if (!Array.isArray(input.items) || input.items.length === 0) throw new ValidationError("items", "at least one item is required");
    const items = input.items.map((item, index) => validateItem(item, index));
    return { email, address, items };
}
