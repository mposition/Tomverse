import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/index.js";

test("parses flat keys and skips comments", () => {
    const text = "; comment\n# another\nname = Ann\n\nmode=fast\n";
    assert.deepEqual(parse(text), { name: "Ann", mode: "fast" });
});

test("a later duplicate wins", () => {
    assert.deepEqual(parse("a = 1\na = 2"), { a: "2" });
});
