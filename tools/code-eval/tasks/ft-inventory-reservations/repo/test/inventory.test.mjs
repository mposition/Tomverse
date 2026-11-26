import { test } from "node:test";
import assert from "node:assert/strict";
import { InsufficientStockError, Inventory } from "../src/index.js";

test("add, remove and onHand", () => {
    const inv = new Inventory();
    inv.add("a", 5);
    inv.remove("a", 2);
    assert.equal(inv.onHand("a"), 3);
    assert.equal(inv.onHand("unknown"), 0);
});

test("removing too much throws", () => {
    const inv = new Inventory();
    inv.add("a", 1);
    assert.throws(() => inv.remove("a", 2), InsufficientStockError);
});
