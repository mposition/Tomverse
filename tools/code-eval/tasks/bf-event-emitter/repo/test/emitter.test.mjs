import { test } from "node:test";
import assert from "node:assert/strict";
import { Emitter, scope } from "../src/index.js";

test("calls handlers in registration order", () => {
    const bus = new Emitter();
    const seen = [];
    bus.on("x", () => seen.push(1));
    bus.on("x", () => seen.push(2));
    bus.emit("x");
    assert.deepEqual(seen, [1, 2]);
});

test("scope prefixes events", () => {
    const bus = new Emitter();
    const seen = [];
    bus.on("ui:click", (v) => seen.push(v));
    scope(bus, "ui").emit("click", 7);
    assert.deepEqual(seen, [7]);
});
