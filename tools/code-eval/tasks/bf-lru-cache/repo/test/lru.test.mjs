import { test } from "node:test";
import assert from "node:assert/strict";
import { LruCache, memoize, withStats } from "../src/index.js";

test("evicts the oldest entry when full", () => {
    const cache = new LruCache(2);
    cache.set("a", 1).set("b", 2).set("c", 3);
    assert.deepEqual(cache.keys(), ["b", "c"]);
});

test("memoize caches truthy results", () => {
    let calls = 0;
    const double = memoize((n) => (calls++, n * 2));
    assert.equal(double(2), 4);
    assert.equal(double(2), 4);
    assert.equal(calls, 1);
});

test("stats count hits and misses", () => {
    const cache = withStats(new LruCache(2));
    cache.set("a", 1);
    cache.get("a");
    cache.get("zzz");
    assert.deepEqual(cache.stats(), { hits: 1, misses: 1, hitRate: 0.5 });
});
