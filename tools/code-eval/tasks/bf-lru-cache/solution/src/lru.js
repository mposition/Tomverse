// Least-recently-used cache. keys() lists the oldest entry first.
export class LruCache {
    #max;
    #map = new Map();

    constructor(max) {
        if (!Number.isInteger(max) || max < 1) throw new RangeError("max must be a positive integer");
        this.#max = max;
    }

    get size() {
        return this.#map.size;
    }

    has(key) {
        return this.#map.has(key);
    }

    get(key) {
        if (!this.#map.has(key)) return undefined;
        const value = this.#map.get(key);
        this.#map.delete(key);
        this.#map.set(key, value);
        return value;
    }

    set(key, value) {
        if (this.#map.has(key)) this.#map.delete(key);
        else if (this.#map.size >= this.#max) {
            const oldest = this.#map.keys().next().value;
            this.#map.delete(oldest);
        }
        this.#map.set(key, value);
        return this;
    }

    delete(key) {
        return this.#map.delete(key);
    }

    keys() {
        return [...this.#map.keys()];
    }
}
