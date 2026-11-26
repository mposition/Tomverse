import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalize, chunk, deepGet, groupBy, kebabCase, mapValues, omit, pick, publicProfile, sortBy, teamSummary, truncate, unique } from "../src/index.js";

test("string helpers", () => {
    assert.equal(capitalize("hello"), "Hello");
    assert.equal(truncate("abcdefghij", 6), "abc...");
    assert.equal(kebabCase("someThing here_now"), "some-thing-here-now");
});

test("array helpers", () => {
    assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(unique([1, 1, 2]), [1, 2]);
    assert.deepEqual(groupBy([1, 2, 3], (n) => (n % 2 ? "odd" : "even")), { odd: [1, 3], even: [2] });
    assert.deepEqual(sortBy([{ n: 2 }, { n: 1 }], (x) => x.n), [{ n: 1 }, { n: 2 }]);
});

test("object helpers", () => {
    assert.deepEqual(pick({ a: 1, b: 2 }, ["a", "z"]), { a: 1 });
    assert.deepEqual(omit({ a: 1, b: 2 }, ["a"]), { b: 2 });
    assert.deepEqual(mapValues({ a: 1 }, (v, k) => `${k}${v}`), { a: "a1" });
    assert.equal(deepGet({ a: { b: 3 } }, "a.b"), 3);
    assert.equal(deepGet({ a: 1 }, "a.b", "none"), "none");
});

test("report", () => {
    const people = [{ name: "zoe", team: "ops" }, { name: "alexander the great", team: "dev" }, { name: "bob", team: "dev" }];
    assert.equal(teamSummary(people), "Dev (2): Alexa..., Bob\nOps (1): Zoe");
    assert.deepEqual(publicProfile({ name: "x", team: "y", secret: 1 }), { name: "x", team: "y" });
});
