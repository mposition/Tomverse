import { LruCache } from "./lru.js";

// Caches fn results by JSON-serialised arguments.
export function memoize(fn, { max = 100 } = {}) {
    const cache = new LruCache(max);
    return (...args) => {
        const key = JSON.stringify(args);
        if (cache.has(key)) return cache.get(key);
        const value = fn(...args);
        cache.set(key, value);
        return value;
    };
}
