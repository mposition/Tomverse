import { test } from "node:test";
import assert from "node:assert/strict";
import { cartTotals } from "../src/index.js";

test("percent discount rounds half up and tax follows the discounted amount", () => {
    // 3 x 19.99 = 5997; 15% = 899.55 -> 900; taxable 5097; 10% tax = 509.7 -> 510
    const totals = cartTotals([{ sku: "a", priceCents: 1999, qty: 3, discount: { type: "percent", value: 15 } }], { taxRatePercent: 10 });
    assert.deepEqual(totals, { subtotal: 5997, discount: 900, taxable: 5097, tax: 510, shipping: 0, total: 5607 });
});

test("free shipping is decided on the amount after discounts", () => {
    const totals = cartTotals([{ sku: "a", priceCents: 2600, qty: 2, discount: { type: "fixed", value: 300 } }]);
    assert.equal(totals.taxable, 4900);
    assert.equal(totals.shipping, 599);
    assert.equal(totals.total, 5499);
});

test("a fixed discount never exceeds the line subtotal", () => {
    const totals = cartTotals(
        [
            { sku: "a", priceCents: 500, qty: 1, discount: { type: "fixed", value: 800 } },
            { sku: "b", priceCents: 1000, qty: 1 },
        ],
        { taxRatePercent: 8 },
    );
    assert.deepEqual(totals, { subtotal: 1500, discount: 500, taxable: 1000, tax: 80, shipping: 599, total: 1679 });
});

test("tax is rounded half up once per cart", () => {
    // 210 at 5% is 10.5 -> 11; per line it would be 5.25 -> 5 twice (10)
    const totals = cartTotals(
        [
            { sku: "a", priceCents: 105, qty: 1 },
            { sku: "b", priceCents: 105, qty: 1 },
        ],
        { taxRatePercent: 5 },
    );
    assert.equal(totals.tax, 11);
});

test("an empty cart costs nothing", () => {
    assert.deepEqual(cartTotals([], { taxRatePercent: 10 }), { subtotal: 0, discount: 0, taxable: 0, tax: 0, shipping: 0, total: 0 });
});

test("a threshold hit exactly ships free", () => {
    const totals = cartTotals([{ sku: "a", priceCents: 5000, qty: 1 }]);
    assert.equal(totals.shipping, 0);
});
