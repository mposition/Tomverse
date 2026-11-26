# Rate limiters

Existing: `TokenBucket` (src/bucket.js) and `KeyedLimiter` (src/keyed.js, one bucket per key). Both take a `clock` with a `now()` method returning milliseconds; `manualClock()` in src/clock.js is for tests.

To add: `SlidingWindowLimiter` in `src/window.js`.

```js
const limiter = new SlidingWindowLimiter({ limit: 3, windowMs: 1000, clock });
limiter.tryAcquire("user-1"); // { allowed: true, remaining: 2, retryAfterMs: 0 }
```

- At most `limit` acquisitions per key are allowed in any window of `windowMs` milliseconds. An acquisition made at time `t` counts until time `t + windowMs` (it has expired when `now >= t + windowMs`).
- `tryAcquire(key = "default")` returns `{ allowed, remaining, retryAfterMs }`. When allowed the acquisition is recorded and `remaining` is how many more are allowed now, `retryAfterMs` is 0. When denied nothing is recorded, `remaining` is 0 and `retryAfterMs` is how long until the oldest recorded acquisition of that key expires.
- `remaining(key = "default")` is how many acquisitions are allowed now, without recording anything.
- `reset(key)` forgets one key; `reset()` forgets all keys.
- Keys are independent. A key whose acquisitions have all expired must not stay in memory: `size()` returns the number of keys that currently have at least one live acquisition.
- Invalid options (`limit` or `windowMs` not a positive integer) throw a RangeError.
