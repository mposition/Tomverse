import { LruCache } from "./lru.js";

// Caches fn results by JSON-serialised arguments.
export function memoize(fn, { max = 100 } = {}) {
    const cache = new LruCache(max);
    return (...args) => {
        const key = JSON.stringify(args);
        const cached = cache.get(key);
        if (cached) return cached;
        const value = fn(...args);
        cache.set(key, value);
        return value;
    };
}
