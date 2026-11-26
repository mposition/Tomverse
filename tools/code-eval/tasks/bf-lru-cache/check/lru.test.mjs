import { test } from "node:test";
import assert from "node:assert/strict";
import { LruCache, memoize, withStats } from "../src/index.js";

test("reading an entry makes it the newest", () => {
    const cache = new LruCache(2);
    cache.set("a", 1).set("b", 2);
    assert.equal(cache.get("a"), 1);
    cache.set("c", 3);
    assert.deepEqual(cache.keys(), ["a", "c"]);
});

test("overwriting a cached key keeps the other entries", () => {
    const cache = new LruCache(2);
    cache.set("a", 1).set("b", 2);
    cache.set("a", 10);
    assert.equal(cache.size, 2);
    assert.deepEqual(cache.keys(), ["b", "a"]);
    assert.equal(cache.get("a"), 10);
    assert.equal(cache.get("b"), 2);
});

test("overwriting refreshes recency", () => {
    const cache = new LruCache(3);
    cache.set("a", 1).set("b", 2).set("c", 3);
    cache.set("a", 9);
    cache.set("d", 4);
    assert.deepEqual(cache.keys(), ["c", "a", "d"]);
});

test("memoize reuses falsy results", () => {
    for (const falsy of [0, "", false, null]) {
        let calls = 0;
        const f = memoize(() => (calls++, falsy));
        assert.equal(f("x"), falsy);
        assert.equal(f("x"), falsy);
        assert.equal(calls, 1, `recomputed ${JSON.stringify(falsy)}`);
    }
});

test("hit rate is 0 before any lookup", () => {
    const cache = withStats(new LruCache(2));
    assert.deepEqual(cache.stats(), { hits: 0, misses: 0, hitRate: 0 });
    cache.get("nope");
    assert.equal(cache.stats().hitRate, 0);
});

test("a stored undefined value still counts as a hit", () => {
    const cache = withStats(new LruCache(2));
    cache.set("u", undefined);
    cache.get("u");
    assert.equal(cache.stats().hits, 1);
});
