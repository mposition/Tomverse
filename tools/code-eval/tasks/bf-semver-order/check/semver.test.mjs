import { test } from "node:test";
import assert from "node:assert/strict";
import { compare, maxSatisfying, satisfies, sortVersions } from "../src/index.js";

test("a pre-release is lower than its release", () => {
    assert.equal(compare("1.0.0-alpha", "1.0.0"), -1);
    assert.equal(compare("1.0.0", "1.0.0-rc.1"), 1);
});

test("numeric identifiers compare as numbers", () => {
    assert.equal(compare("1.0.0-alpha.2", "1.0.0-alpha.10"), -1);
    assert.equal(compare("1.0.0-alpha.10", "1.0.0-alpha.2"), 1);
});

test("numeric identifiers are lower than alphanumeric ones", () => {
    assert.equal(compare("1.0.0-1", "1.0.0-alpha"), -1);
    assert.equal(compare("1.0.0-alpha", "1.0.0-beta"), -1);
});

test("a longer pre-release is higher than its prefix", () => {
    assert.equal(compare("1.0.0-alpha", "1.0.0-alpha.1"), -1);
    assert.equal(compare("1.0.0-alpha.1", "1.0.0-alpha.beta"), -1);
});

test("the spec's example ordering", () => {
    const ordered = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0"];
    const shuffled = [ordered[5], ordered[0], ordered[7], ordered[2], ordered[6], ordered[1], ordered[4], ordered[3]];
    assert.deepEqual(sortVersions(shuffled), ordered);
});

test("build metadata is ignored", () => {
    assert.equal(compare("1.0.0+a", "1.0.0+b"), 0);
});

test("caret on 0.x stays in the leftmost non-zero part", () => {
    assert.equal(satisfies("0.2.9", "^0.2.3"), true);
    assert.equal(satisfies("0.3.0", "^0.2.3"), false);
    assert.equal(satisfies("0.0.3", "^0.0.3"), true);
    assert.equal(satisfies("0.0.4", "^0.0.3"), false);
    assert.equal(satisfies("1.9.9", "^1.2.3"), true);
    assert.equal(satisfies("2.0.0", "^1.2.3"), false);
});

test("maxSatisfying uses the corrected order", () => {
    assert.equal(maxSatisfying(["0.2.3", "0.2.10", "0.2.9", "0.3.0"], "^0.2.3"), "0.2.10");
});
