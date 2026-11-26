import { test } from "node:test";
import assert from "node:assert/strict";
import { listPage, pageCount, parsePagination } from "../src/index.js";

const numbers = (n) => Array.from({ length: n }, (_, i) => i + 1);

test("a partial last page counts as a page", () => {
    assert.equal(pageCount(25, 10), 3);
    assert.equal(pageCount(20, 10), 2);
    assert.equal(pageCount(1, 10), 1);
});

test("the last partial page is reachable", () => {
    const result = listPage(numbers(25), { page: "3", size: "10" });
    assert.deepEqual(result.items, [21, 22, 23, 24, 25]);
    assert.equal(result.hasNext, false);
    assert.equal(result.hasPrev, true);
    assert.equal(listPage(numbers(25), { page: "2", size: "10" }).hasNext, true);
});

test("the page size is capped at the maximum", () => {
    assert.equal(parsePagination({ size: "1000" }).size, 100);
    assert.equal(listPage(numbers(500), { size: "1000" }).items.length, 100);
    assert.equal(parsePagination({ size: "100" }).size, 100);
});

test("a page past the end returns the last page", () => {
    const result = listPage(numbers(25), { page: "99", size: "10" });
    assert.equal(result.page, 3);
    assert.deepEqual(result.items, [21, 22, 23, 24, 25]);
});

test("an empty list has one empty page", () => {
    const result = listPage([], { page: "4" });
    assert.equal(result.pageCount, 1);
    assert.equal(result.page, 1);
    assert.deepEqual(result.items, []);
    assert.equal(result.hasNext, false);
});

test("a bad size falls back to the default", () => {
    assert.equal(parsePagination({ size: "0" }).size, 10);
    assert.equal(parsePagination({ size: "x" }).size, 10);
});
