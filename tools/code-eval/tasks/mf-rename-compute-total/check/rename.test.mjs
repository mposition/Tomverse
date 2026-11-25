import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { calcTotal, calculators, checkout, computeTotal, dailyReport, renderInvoice } from "../src/index.js";
import * as totals from "../src/totals.js";

const items = [{ name: "Pen", priceCents: 250, qty: 4 }, { name: "Pad", priceCents: 500, qty: 1 }];
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("only src/index.js still mentions the old name", () => {
    const files = readdirSync(new URL("../src/", import.meta.url)).map((name) => `src/${name}`).concat("README.md");
    const mentioning = files.filter((file) => read(file).includes("calcTotal")).sort();
    assert.deepEqual(mentioning, ["src/index.js"]);
    assert.ok(read("README.md").includes("computeTotal"));
});

test("totals.js exports computeTotal and no longer calcTotal", () => {
    assert.equal(typeof totals.computeTotal, "function");
    assert.equal("calcTotal" in totals, false);
    assert.equal(computeTotal, totals.computeTotal);
});

test("behaviour is unchanged and the error names the new function", () => {
    assert.equal(computeTotal(items), 1500);
    assert.equal(computeTotal(items, { taxPercent: 10 }), 1650);
    assert.equal(computeTotal(items, { taxPercent: 7.5, discountCents: 100 }), 1400 + 105);
    assert.equal(computeTotal(items, { discountCents: 99999 }), 0);
    assert.throws(() => computeTotal(null), (e) => e instanceof TypeError && e.message === "computeTotal: items must be an array");
});

test("consumers use the renamed function", () => {
    assert.equal(renderInvoice(items, { taxPercent: 10 }), "Invoice\n4 x Pen: 10.00\n1 x Pad: 5.00\nTotal: 16.50");
    assert.deepEqual(dailyReport([{ date: "d1", items, options: { discountCents: 500 } }, { date: "d1", items }]), { d1: 2500 });
    assert.deepEqual(checkout({ items, options: { taxPercent: 10 } }, { balanceCents: 2000 }), { ok: true, amount: 1650, remaining: 350 });
    assert.deepEqual(checkout({ items }, { balanceCents: 100 }), { ok: false, amount: 1500, reason: "insufficient funds" });
});

test("the registry uses the new name", () => {
    assert.equal(calculators.computeTotal, computeTotal);
    assert.equal(calculators.default, computeTotal);
    assert.equal("calcTotal" in calculators, false);
});

test("calcTotal is a deprecated wrapper that warns once", (t) => {
    const warn = t.mock.method(console, "warn", () => {});
    assert.equal(calcTotal(items), 1500);
    assert.equal(calcTotal(items, { taxPercent: 10 }), 1650);
    assert.equal(warn.mock.callCount(), 1);
    assert.deepEqual(warn.mock.calls[0].arguments, ["calcTotal is deprecated; use computeTotal"]);
    assert.throws(() => calcTotal("x"), /computeTotal: items must be an array/);
    assert.equal(warn.mock.callCount(), 1);
});
