import { systemClock } from "./clock.js";

const positiveInt = (value) => Number.isInteger(value) && value > 0;

export class SlidingWindowLimiter {
    #log = new Map();

    constructor({ limit, windowMs, clock = systemClock } = {}) {
        if (!positiveInt(limit)) throw new RangeError("limit must be a positive integer");
        if (!positiveInt(windowMs)) throw new RangeError("windowMs must be a positive integer");
        this.limit = limit;
        this.windowMs = windowMs;
        this.clock = clock;
    }

    #live(key) {
        const now = this.clock.now();
        const entries = (this.#log.get(key) ?? []).filter((t) => now < t + this.windowMs);
        if (entries.length) this.#log.set(key, entries);
        else this.#log.delete(key);
        return entries;
    }

    tryAcquire(key = "default") {
        const entries = this.#live(key);
        const now = this.clock.now();
        if (entries.length >= this.limit) {
            return { allowed: false, remaining: 0, retryAfterMs: entries[0] + this.windowMs - now };
        }
        entries.push(now);
        this.#log.set(key, entries);
        return { allowed: true, remaining: this.limit - entries.length, retryAfterMs: 0 };
    }

    remaining(key = "default") {
        return this.limit - this.#live(key).length;
    }

    reset(key) {
        if (key === undefined) this.#log.clear();
        else this.#log.delete(key);
    }

    size() {
        for (const key of [...this.#log.keys()]) this.#live(key);
        return this.#log.size;
    }
}
