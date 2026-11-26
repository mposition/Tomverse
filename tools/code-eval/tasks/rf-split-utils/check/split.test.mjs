import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as array from "../src/array.js";
import * as object from "../src/object.js";
import * as string from "../src/string.js";
import * as utils from "../src/utils.js";
import { publicProfile, teamSummary } from "../src/index.js";

test("each module exports exactly its own helpers", () => {
    assert.deepEqual(Object.keys(string).sort(), ["capitalize", "kebabCase", "truncate"]);
    assert.deepEqual(Object.keys(array).sort(), ["chunk", "groupBy", "sortBy", "unique"]);
    assert.deepEqual(Object.keys(object).sort(), ["deepGet", "mapValues", "omit", "pick"]);
});

test("utils re-exports the very same functions", () => {
    assert.deepEqual(Object.keys(utils).sort(), [...Object.keys(string), ...Object.keys(array), ...Object.keys(object)].sort());
    for (const group of [string, array, object]) {
        for (const [name, fn] of Object.entries(group)) assert.equal(utils[name], fn, name);
    }
});

test("report.js imports the focused modules", () => {
    const source = readFileSync(new URL("../src/report.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /utils\.js/);
    assert.match(source, /string\.js/);
    assert.match(source, /array\.js/);
    assert.match(source, /object\.js/);
});

test("utils.js is thin", () => {
    const source = readFileSync(new URL("../src/utils.js", import.meta.url), "utf8");
    assert.doesNotMatch(source, /function /);
});

test("behaviour is unchanged", () => {
    assert.equal(string.capitalize(""), "");
    assert.equal(string.capitalize("hello"), "Hello");
    assert.equal(string.truncate("short", 10), "short");
    assert.equal(string.truncate("abcdefghij", 6), "abc...");
    assert.equal(string.truncate("abcdefghij", 2), "...");
    assert.equal(string.kebabCase("someThing here_now"), "some-thing-here-now");
    assert.deepEqual(array.chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(array.unique([3, 1, 3, 2, 1]), [3, 1, 2]);
    assert.deepEqual(array.groupBy(["a", "bb", "cc"], (s) => s.length), { 1: ["a"], 2: ["bb", "cc"] });
    const input = [{ n: 3 }, { n: 1 }, { n: 2 }];
    assert.deepEqual(array.sortBy(input, (x) => x.n).map((x) => x.n), [1, 2, 3]);
    assert.deepEqual(input.map((x) => x.n), [3, 1, 2]);
    assert.deepEqual(object.pick({ a: 1, b: 2 }, ["b", "z"]), { b: 2 });
    assert.deepEqual(object.omit({ a: 1, b: 2, c: 3 }, ["a", "c"]), { b: 2 });
    assert.deepEqual(object.mapValues({ a: 1, b: 2 }, (v, k) => k + v * 2), { a: "a2", b: "b4" });
    assert.equal(object.deepGet({ a: { b: { c: 0 } } }, "a.b.c", 9), 0);
    assert.equal(object.deepGet({ a: [1] }, "a.0", "none"), "none");
    assert.equal(object.deepGet({}, "x.y"), undefined);
});

test("report output is unchanged", () => {
    const people = [{ name: "zoe", team: "ops" }, { name: "alexander the great", team: "dev" }, { name: "bob", team: "dev" }];
    assert.equal(teamSummary(people), "Dev (2): Alexa..., Bob\nOps (1): Zoe");
    assert.deepEqual(publicProfile({ name: "x", team: "y", secret: 1 }), { name: "x", team: "y" });
});
