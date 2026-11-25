import { test } from "node:test";
import assert from "node:assert/strict";
import { InsufficientStockError, Inventory, ReservationError, manualClock } from "../src/index.js";

const setup = () => {
    const clock = manualClock(1000);
    const inv = new Inventory({ clock });
    inv.add("a", 10);
    return { clock, inv };
};

test("reserving holds stock without removing it", () => {
    const { inv } = setup();
    const id = inv.reserve("a", 4);
    assert.equal(typeof id, "string");
    assert.equal(inv.onHand("a"), 10);
    assert.equal(inv.reservedQty("a"), 4);
    assert.equal(inv.available("a"), 6);
});

test("reserve cannot exceed what is available", () => {
    const { inv } = setup();
    inv.reserve("a", 8);
    assert.throws(() => inv.reserve("a", 3), (e) => e instanceof InsufficientStockError && e.available === 2);
    assert.doesNotThrow(() => inv.reserve("a", 2));
    assert.throws(() => inv.reserve("none", 1), InsufficientStockError);
});

test("ids are unique", () => {
    const { inv } = setup();
    const ids = new Set([inv.reserve("a", 1), inv.reserve("a", 1), inv.reserve("a", 1)]);
    assert.equal(ids.size, 3);
});

test("remove only takes available units", () => {
    const { inv } = setup();
    inv.reserve("a", 7);
    assert.throws(() => inv.remove("a", 4), InsufficientStockError);
    inv.remove("a", 3);
    assert.equal(inv.onHand("a"), 7);
    assert.equal(inv.available("a"), 0);
});

test("reservations expire exactly at createdAt + ttlMs", () => {
    const { inv, clock } = setup();
    inv.reserve("a", 5, { ttlMs: 1000 });
    clock.advance(999);
    assert.equal(inv.available("a"), 5);
    clock.advance(1);
    assert.equal(inv.available("a"), 10);
    assert.equal(inv.reservedQty("a"), 0);
});

test("the default ttl is fifteen minutes", () => {
    const { inv, clock } = setup();
    inv.reserve("a", 5);
    clock.advance(900000 - 1);
    assert.equal(inv.reservedQty("a"), 5);
    clock.advance(1);
    assert.equal(inv.reservedQty("a"), 0);
});

test("release", () => {
    const { inv } = setup();
    const id = inv.reserve("a", 5);
    assert.equal(inv.release(id), true);
    assert.equal(inv.release(id), false);
    assert.equal(inv.release("nope"), false);
    assert.equal(inv.available("a"), 10);
});

test("releasing an expired reservation returns false", () => {
    const { inv, clock } = setup();
    const id = inv.reserve("a", 5, { ttlMs: 10 });
    clock.advance(10);
    assert.equal(inv.release(id), false);
});

test("commit takes the units out of stock and ends the reservation", () => {
    const { inv } = setup();
    const id = inv.reserve("a", 4);
    inv.commit(id);
    assert.equal(inv.onHand("a"), 6);
    assert.equal(inv.reservedQty("a"), 0);
    assert.equal(inv.available("a"), 6);
    assert.throws(() => inv.commit(id), (e) => e instanceof ReservationError && e.code === "unknown");
});

test("commit of an expired or unknown reservation fails with a code", () => {
    const { inv, clock } = setup();
    const id = inv.reserve("a", 4, { ttlMs: 5 });
    clock.advance(5);
    assert.throws(() => inv.commit(id), (e) => e instanceof ReservationError && e.code === "expired");
    assert.equal(inv.onHand("a"), 10);
    assert.throws(() => inv.commit("zzz"), (e) => e instanceof ReservationError && e.code === "unknown");
});

test("quantities must be positive integers", () => {
    const { inv } = setup();
    for (const bad of [0, -1, 1.5, "2"]) {
        assert.throws(() => inv.add("a", bad), RangeError);
        assert.throws(() => inv.remove("a", bad), RangeError);
        assert.throws(() => inv.reserve("a", bad), RangeError);
    }
});

test("stock of other skus is independent", () => {
    const { inv } = setup();
    inv.add("b", 3);
    inv.reserve("a", 10);
    assert.equal(inv.available("b"), 3);
});
