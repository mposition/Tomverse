import { test } from "node:test";
import assert from "node:assert/strict";
import { listPage, parsePagination } from "../src/index.js";

const numbers = (n) => Array.from({ length: n }, (_, i) => i + 1);

test("first page of an exact multiple", () => {
    const result = listPage(numbers(20), { page: "1" });
    assert.deepEqual(result.items, numbers(10));
    assert.equal(result.pageCount, 2);
    assert.equal(result.hasNext, true);
    assert.equal(result.hasPrev, false);
});

test("invalid page numbers fall back to the default", () => {
    assert.deepEqual(parsePagination({ page: "abc" }), { page: 1, size: 10 });
    assert.deepEqual(parsePagination({ page: "0" }), { page: 1, size: 10 });
});
