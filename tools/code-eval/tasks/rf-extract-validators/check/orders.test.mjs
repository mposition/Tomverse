import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ValidationError, addItem, createOrder, orderTotal, updateShipping } from "../src/index.js";
import { validateAddress, validateEmail, validateItem, validateOrderInput } from "../src/validate.js";

const input = () => ({
    email: "  Ann@Example.COM ",
    address: { street: " 1 Main St ", city: "Town", postalCode: "1234" },
    items: [{ sku: " A1 ", qty: 2, priceCents: 500 }],
});
const fails = (fn, field, message) =>
    assert.throws(fn, (e) => e instanceof ValidationError && e.field === field && e.message === message, `${field}: ${message}`);

test("orders.js uses validate.js and no longer builds errors itself", () => {
    const source = readFileSync(new URL("../src/orders.js", import.meta.url), "utf8");
    assert.match(source, /from "\.\/validate\.js"/);
    assert.doesNotMatch(source, /new ValidationError/);
    assert.doesNotMatch(source, /EMAIL|postalCode/);
});

test("createOrder keeps its behaviour", () => {
    const order = createOrder(input());
    assert.equal(order.email, "ann@example.com");
    assert.deepEqual(order.address, { street: "1 Main St", city: "Town", postalCode: "1234" });
    assert.deepEqual(order.items, [{ sku: "A1", qty: 2, priceCents: 500 }]);
    assert.match(order.id, /^order-\d+$/);
    assert.equal(orderTotal(order), 1000);
});

test("createOrder errors are unchanged", () => {
    fails(() => createOrder({ ...input(), email: "nope" }), "email", "email is not valid");
    fails(() => createOrder({ ...input(), address: { ...input().address, city: " " } }), "address.city", "city is required");
    fails(() => createOrder({ ...input(), address: undefined }), "address.street", "street is required");
    fails(() => createOrder({ ...input(), address: { ...input().address, postalCode: "12a4" } }), "address.postalCode", "postalCode must be 4 digits");
    fails(() => createOrder({ ...input(), items: [] }), "items", "at least one item is required");
    fails(() => createOrder({ ...input(), items: "x" }), "items", "at least one item is required");
    fails(() => createOrder({ ...input(), items: [{ sku: "a", qty: 1, priceCents: 1 }, { sku: " ", qty: 1, priceCents: 1 }] }), "items.1.sku", "sku is required");
    fails(() => createOrder({ ...input(), items: [{ sku: "a", qty: 0, priceCents: 1 }] }), "items.0.qty", "qty must be a positive integer");
    fails(() => createOrder({ ...input(), items: [{ sku: "a", qty: 1, priceCents: -1 }] }), "items.0.priceCents", "priceCents must be a non-negative integer");
    fails(() => createOrder(undefined), "email", "email is not valid");
});

test("updateShipping and addItem", () => {
    const order = createOrder(input());
    const moved = updateShipping(order, { street: " 2 Side St", city: "B", postalCode: "9999" });
    assert.deepEqual(moved.address, { street: "2 Side St", city: "B", postalCode: "9999" });
    assert.equal(order.address.street, "1 Main St");
    fails(() => updateShipping(order, { street: "x", city: "y", postalCode: "12" }), "address.postalCode", "postalCode must be 4 digits");
    fails(() => updateShipping(order), "address.street", "street is required");
    const more = addItem(order, { sku: " B ", qty: 3, priceCents: 10 });
    assert.deepEqual(more.items[1], { sku: "B", qty: 3, priceCents: 10 });
    fails(() => addItem(order, { sku: "", qty: 1, priceCents: 1 }), "items.1.sku", "sku is required");
});

test("validate.js functions", () => {
    assert.equal(validateEmail(" A@B.CO "), "a@b.co");
    fails(() => validateEmail("a@b"), "email", "email is not valid");
    fails(() => validateEmail(undefined), "email", "email is not valid");
    assert.deepEqual(validateAddress({ street: "s", city: "c", postalCode: " 1000 " }), { street: "s", city: "c", postalCode: "1000" });
    fails(() => validateAddress({ street: "s", city: "", postalCode: "1000" }, "shipTo"), "shipTo.city", "city is required");
    fails(() => validateAddress({ street: "s", city: "c", postalCode: "10" }, "shipTo"), "shipTo.postalCode", "postalCode must be 4 digits");
    assert.deepEqual(validateItem({ sku: " k ", qty: 2, priceCents: 0 }, 5), { sku: "k", qty: 2, priceCents: 0 });
    fails(() => validateItem({ sku: "k", qty: 1.5, priceCents: 0 }, 5), "items.5.qty", "qty must be a positive integer");
    const normalised = validateOrderInput(input());
    assert.deepEqual(Object.keys(normalised).sort(), ["address", "email", "items"]);
    assert.equal(normalised.email, "ann@example.com");
});
