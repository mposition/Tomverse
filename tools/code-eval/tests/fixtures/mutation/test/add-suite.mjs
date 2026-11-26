import { test } from "node:test";
import assert from "node:assert/strict";
import { add } from "../src/add.js";
test("adds", () => { assert.equal(add(2, 3), 5); });
test("adds zero", () => { assert.equal(add(0, 0), 0); });
test("adds negatives", () => { assert.equal(add(-2, -3), -5); });
test("adds mixed", () => { assert.equal(add(10, -4), 6); });
