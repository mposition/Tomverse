import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, toCsv, toObjects } from "../src/index.js";

test("parses simple rows and quoted commas", () => {
    assert.deepEqual(parseCsv('a,b\n"1,5",2'), [
        ["a", "b"],
        ["1,5", "2"],
    ]);
});

test("round trips plain data", () => {
    const rows = [["x", "y"], ["1", "2"]];
    assert.deepEqual(parseCsv(toCsv(rows)), rows);
});

test("maps rows to objects", () => {
    assert.deepEqual(toObjects([["n"], ["1"]]), [{ n: "1" }]);
});
