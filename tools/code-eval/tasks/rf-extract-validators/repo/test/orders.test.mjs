import { test } from "node:test";
import assert from "node:assert/strict";
import { ValidationError, addItem, createOrder, orderTotal, updateShipping } from "../src/index.js";

const input = () => ({
    email: "  Ann@Example.COM ",
    address: { street: " 1 Main St ", city: "Town", postalCode: "1234" },
    items: [{ sku: " A1 ", qty: 2, priceCents: 500 }],
});

test("creates a normalised order", () => {
    const order = createOrder(input());
    assert.equal(order.email, "ann@example.com");
    assert.deepEqual(order.address, { street: "1 Main St", city: "Town", postalCode: "1234" });
    assert.deepEqual(order.items, [{ sku: "A1", qty: 2, priceCents: 500 }]);
    assert.equal(order.status, "new");
    assert.equal(orderTotal(order), 1000);
});

test("reports the first problem with its field", () => {
    assert.throws(() => createOrder({ ...input(), email: "nope" }), (e) => e instanceof ValidationError && e.field === "email");
});

test("updateShipping and addItem validate too", () => {
    const order = createOrder(input());
    assert.throws(() => updateShipping(order, { street: "x", city: "y", postalCode: "12" }), /4 digits/);
    assert.equal(addItem(order, { sku: "B", qty: 1, priceCents: 0 }).items.length, 2);
});
