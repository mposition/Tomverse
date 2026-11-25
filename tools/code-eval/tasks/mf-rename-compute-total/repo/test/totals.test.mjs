import { test } from "node:test";
import assert from "node:assert/strict";
import { calcTotal, calculators, checkout, dailyReport, renderInvoice } from "../src/index.js";

const items = [{ name: "Pen", priceCents: 250, qty: 4 }, { name: "Pad", priceCents: 500, qty: 1 }];

test("calcTotal", () => {
    assert.equal(calcTotal(items), 1500);
    assert.equal(calcTotal(items, { taxPercent: 10 }), 1650);
    assert.equal(calcTotal(items, { discountCents: 2000 }), 0);
    assert.throws(() => calcTotal("x"), /items must be an array/);
});

test("consumers", () => {
    assert.equal(renderInvoice(items), "Invoice\n4 x Pen: 10.00\n1 x Pad: 5.00\nTotal: 15.00");
    assert.deepEqual(dailyReport([{ date: "d1", items }, { date: "d1", items }, { date: "d2", items: [] }]), { d1: 3000, d2: 0 });
    assert.deepEqual(checkout({ items }, { balanceCents: 2000 }), { ok: true, amount: 1500, remaining: 500 });
    assert.equal(checkout({ items }, { balanceCents: 100 }).ok, false);
    assert.equal(calculators.default, calculators.calcTotal);
});
