import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCsv, toCsv, toObjects } from "../src/index.js";

test("doubled quotes inside a quoted field become one quote", () => {
    assert.deepEqual(parseCsv('"say ""hi""",x'), [['say "hi"', "x"]]);
    assert.deepEqual(parseCsv('""""'), [['"']]);
});

test("a quoted field may contain newlines and delimiters", () => {
    assert.deepEqual(parseCsv('"a\nb","c,d"\n'), [["a\nb", "c,d"]]);
});

test("a trailing newline does not add a row", () => {
    assert.deepEqual(parseCsv("a,b\n1,2\n"), [["a", "b"], ["1", "2"]]);
    assert.deepEqual(parseCsv("a,b\r\n1,2\r\n"), [["a", "b"], ["1", "2"]]);
    assert.deepEqual(parseCsv(""), []);
});

test("an empty last cell is kept", () => {
    assert.deepEqual(parseCsv("a,\n"), [["a", ""]]);
    assert.deepEqual(parseCsv("a,b,"), [["a", "b", ""]]);
});

test("custom delimiter", () => {
    assert.deepEqual(parseCsv("a;b\n1;2", { delimiter: ";" }), [["a", "b"], ["1", "2"]]);
});

test("short rows give empty strings", () => {
    assert.deepEqual(toObjects([["a", "b", "c"], ["1"], ["1", "2", "3"]]), [
        { a: "1", b: "", c: "" },
        { a: "1", b: "2", c: "3" },
    ]);
});

test("toCsv escapes quotes and quotes fields with the delimiter", () => {
    assert.equal(toCsv([['say "hi"', "a,b", "plain"]]), '"say ""hi""","a,b",plain');
    assert.equal(toCsv([["a;b", "c,d"]], { delimiter: ";" }), '"a;b";c,d');
    assert.equal(toCsv([["line\nbreak"]]), '"line\nbreak"');
});

test("round trips awkward values", () => {
    const rows = [['he said "no"', "a,b", "multi\nline", ""], ["x", "y", "z", "w"]];
    assert.deepEqual(parseCsv(toCsv(rows)), rows);
});
