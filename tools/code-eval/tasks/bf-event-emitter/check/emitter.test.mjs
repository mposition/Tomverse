import { test } from "node:test";
import assert from "node:assert/strict";
import { Emitter, scope } from "../src/index.js";

test("a once handler does not make the next handler skip", () => {
    const bus = new Emitter();
    const seen = [];
    bus.once("x", () => seen.push("a"));
    bus.on("x", () => seen.push("b"));
    bus.once("x", () => seen.push("c"));
    bus.emit("x");
    assert.deepEqual(seen, ["a", "b", "c"]);
    bus.emit("x");
    assert.deepEqual(seen, ["a", "b", "c", "b"]);
    assert.equal(bus.listenerCount("x"), 1);
});

test("every handler runs even if one throws; the first error is rethrown", () => {
    const bus = new Emitter();
    const seen = [];
    bus.on("x", () => {
        throw new Error("first");
    });
    bus.on("x", () => seen.push("b"));
    bus.on("x", () => {
        throw new Error("second");
    });
    bus.on("x", () => seen.push("d"));
    assert.throws(() => bus.emit("x"), /first/);
    assert.deepEqual(seen, ["b", "d"]);
});

test("emit tells whether any handler ran, once handlers included", () => {
    const bus = new Emitter();
    assert.equal(bus.emit("nothing"), false);
    bus.once("x", () => {});
    assert.equal(bus.emit("x"), true);
    assert.equal(bus.emit("x"), false);
});

test("a handler may remove itself while emitting", () => {
    const bus = new Emitter();
    const seen = [];
    const first = () => {
        seen.push("first");
        bus.off("x", first);
    };
    bus.on("x", first);
    bus.on("x", () => seen.push("second"));
    bus.emit("x");
    assert.deepEqual(seen, ["first", "second"]);
    bus.emit("x");
    assert.deepEqual(seen, ["first", "second", "second"]);
});

test("scope.clear removes once handlers too", () => {
    const bus = new Emitter();
    const ui = scope(bus, "ui");
    ui.on("a", () => {});
    ui.once("b", () => {});
    assert.equal(bus.listenerCount("ui:a") + bus.listenerCount("ui:b"), 2);
    ui.clear();
    assert.equal(bus.listenerCount("ui:a") + bus.listenerCount("ui:b"), 0);
});

test("scope.once handlers fire once", () => {
    const bus = new Emitter();
    const ui = scope(bus, "ui");
    let calls = 0;
    ui.once("go", () => calls++);
    ui.emit("go");
    ui.emit("go");
    assert.equal(calls, 1);
});
