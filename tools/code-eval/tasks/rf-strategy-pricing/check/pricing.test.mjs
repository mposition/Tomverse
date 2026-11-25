import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getStrategy, listTiers, priceFor, registerStrategy, renderInvoice } from "../src/index.js";

const basketOf = (subtotal) => [{ name: "Thing", unitCents: subtotal, qty: 1 }];
const price = (tier, subtotal) => priceFor({ tier }, basketOf(subtotal));

test("pricing.js has no tier names left", () => {
    const source = readFileSync(new URL("../src/pricing.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /standard|silver|gold|staff|switch/);
    assert.match(source, /getStrategy/);
});

test("results are unchanged for every tier and threshold", () => {
    assert.deepEqual(price("standard", 9999), { subtotal: 9999, discount: 0, shipping: 500, total: 10499 });
    assert.deepEqual(price("standard", 10000), { subtotal: 10000, discount: 0, shipping: 0, total: 10000 });
    assert.deepEqual(price("silver", 7999), { subtotal: 7999, discount: 400, shipping: 500, total: 8099 });
    assert.deepEqual(price("silver", 8000), { subtotal: 8000, discount: 400, shipping: 0, total: 7600 });
    assert.deepEqual(price("gold", 19999), { subtotal: 19999, discount: 2000, shipping: 0, total: 17999 });
    assert.deepEqual(price("gold", 20000), { subtotal: 20000, discount: 2500, shipping: 0, total: 17500 });
    assert.deepEqual(price("staff", 10000), { subtotal: 10000, discount: 3000, shipping: 0, total: 7000 });
    assert.deepEqual(price("staff", 30000), { subtotal: 30000, discount: 5000, shipping: 0, total: 25000 });
    assert.deepEqual(price("standard", 0), { subtotal: 0, discount: 0, shipping: 500, total: 500 });
});

test("multi-line baskets and invoices still work", () => {
    const basket = [{ name: "Lamp", unitCents: 2500, qty: 2 }, { name: "Bulb", unitCents: 1000, qty: 3 }];
    assert.deepEqual(priceFor({ tier: "gold" }, basket), { subtotal: 8000, discount: 800, shipping: 0, total: 7200 });
    assert.equal(renderInvoice({ tier: "silver" }, basket), "2 x Lamp @ 25.00\n3 x Bulb @ 10.00\nSubtotal 80.00\nDiscount -4.00\nShipping 0.00\nTotal 76.00");
});

test("unknown tiers", () => {
    assert.throws(() => priceFor({ tier: "platinum" }, basketOf(100)), /^Error: unknown tier: platinum$/);
    assert.throws(() => getStrategy("nope"), /unknown tier: nope/);
});

test("registry", () => {
    assert.deepEqual(listTiers().slice(0, 4), ["standard", "silver", "gold", "staff"]);
    assert.equal(typeof getStrategy("gold"), "function");
    assert.deepEqual(getStrategy("silver")(8000), { discount: 400, shipping: 0 });
    registerStrategy("vip", (subtotal) => ({ discount: Math.floor(subtotal / 2), shipping: 0 }));
    assert.deepEqual(price("vip", 1001), { subtotal: 1001, discount: 500, shipping: 0, total: 501 });
    assert.equal(listTiers().at(-1), "vip");
    assert.throws(() => registerStrategy("vip", () => ({ discount: 0, shipping: 0 })), /^Error: tier already registered: vip$/);
    assert.throws(() => registerStrategy("gold", () => ({ discount: 0, shipping: 0 })), /tier already registered: gold/);
    assert.deepEqual(price("gold", 20000).discount, 2500);
});
