import { test } from "node:test";
import assert from "node:assert/strict";
import { cartTotals, formatCents } from "../src/index.js";

test("a plain cart without discount or tax", () => {
    const totals = cartTotals([{ sku: "a", priceCents: 1000, qty: 2 }]);
    assert.deepEqual(totals, { subtotal: 2000, discount: 0, taxable: 2000, tax: 0, shipping: 599, total: 2599 });
});

test("formats cents", () => {
    assert.equal(formatCents(1999), "$19.99");
    assert.equal(formatCents(5), "$0.05");
});
