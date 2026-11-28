import { systemClock } from "./clock.js";

export class TokenBucket {
    #tokens;
    #updatedAt;

    constructor({ capacity, refillPerSecond, clock = systemClock }) {
        this.capacity = capacity;
        this.refillPerSecond = refillPerSecond;
        this.clock = clock;
        this.#tokens = capacity;
        this.#updatedAt = clock.now();
    }

    #refill() {
        const now = this.clock.now();
        const added = ((now - this.#updatedAt) / 1000) * this.refillPerSecond;
        this.#tokens = Math.min(this.capacity, this.#tokens + added);
        this.#updatedAt = now;
    }

    tryTake(count = 1) {
        this.#refill();
        if (this.#tokens < count) return false;
        this.#tokens -= count;
        return true;
    }

    available() {
        this.#refill();
        return Math.floor(this.#tokens);
    }
}
