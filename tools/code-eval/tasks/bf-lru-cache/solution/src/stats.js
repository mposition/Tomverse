// Adds hit/miss counting to a cache instance.
export function withStats(cache) {
    const counts = { hits: 0, misses: 0 };
    const read = cache.get.bind(cache);
    cache.get = (key) => {
        if (cache.has(key)) counts.hits += 1;
        else counts.misses += 1;
        return read(key);
    };
    cache.stats = () => {
        const lookups = counts.hits + counts.misses;
        return {
            hits: counts.hits,
            misses: counts.misses,
            hitRate: lookups === 0 ? 0 : counts.hits / lookups,
        };
    };
    return cache;
}
