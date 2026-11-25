import { TokenBucket } from "./bucket.js";

export class KeyedLimiter {
    #buckets = new Map();

    constructor(options) {
        this.options = options;
    }

    tryTake(key, count = 1) {
        let bucket = this.#buckets.get(key);
        if (!bucket) {
            bucket = new TokenBucket(this.options);
            this.#buckets.set(key, bucket);
        }
        return bucket.tryTake(count);
    }
}
