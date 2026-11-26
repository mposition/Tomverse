import { test } from "node:test";
import assert from "node:assert/strict";
import { priceFor, renderInvoice } from "../src/index.js";

const basket = [{ name: "Lamp", unitCents: 2500, qty: 2 }, { name: "Bulb", unitCents: 1000, qty: 3 }];

test("standard pays shipping below the threshold", () => {
    assert.deepEqual(priceFor({ tier: "standard" }, basket), { subtotal: 8000, discount: 0, shipping: 500, total: 8500 });
});

test("gold gets ten percent and free shipping", () => {
    assert.deepEqual(priceFor({ tier: "gold" }, basket), { subtotal: 8000, discount: 800, shipping: 0, total: 7200 });
});

test("unknown tiers are rejected", () => {
    assert.throws(() => priceFor({ tier: "platinum" }, basket), /unknown tier: platinum/);
});

test("invoice text", () => {
    assert.equal(renderInvoice({ tier: "silver" }, basket), "2 x Lamp @ 25.00\n3 x Bulb @ 10.00\nSubtotal 80.00\nDiscount -4.00\nShipping 0.00\nTotal 76.00");
});
