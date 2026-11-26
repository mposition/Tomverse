import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, maxSatisfying, parse, satisfies, sortVersions } from "../src/index.js";

test("parses a full version", () => {
    assert.deepEqual(parse("1.2.3-beta.1+b7"), { major: 1, minor: 2, patch: 3, prerelease: ["beta", "1"], build: "b7" });
});

test("orders by numbers", () => {
    assert.deepEqual(sortVersions(["1.10.0", "1.2.0", "0.9.9"]), ["0.9.9", "1.2.0", "1.10.0"]);
    assert.equal(compare("2.0.0", "2.0.0"), 0);
});

test("caret and tilde ranges", () => {
    assert.equal(satisfies("1.4.0", "^1.2.3"), true);
    assert.equal(satisfies("2.0.0", "^1.2.3"), false);
    assert.equal(satisfies("1.2.9", "~1.2.3"), true);
    assert.equal(maxSatisfying(["1.0.0", "1.5.0", "2.0.0"], "^1.0.0"), "1.5.0");
});
