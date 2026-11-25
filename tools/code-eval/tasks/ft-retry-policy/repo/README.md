# retry

```js
await retry(fn, { retries: 3, delayMs: 100 });
```

`retries` is the number of retries after the first attempt, so there are at most `retries + 1` attempts. When the last attempt fails, its error is thrown unchanged.

New options
- `backoff: "exponential"`: the delay before retry number `n` (1 for the first retry) is `delayMs * factor ** (n - 1)`, with `factor` defaulting to 2. Without `backoff` (or with `"constant"`) the delay is always `delayMs`.
- `maxDelayMs`: upper bound of the delay (applied before jitter). Default: no bound.
- `jitter: true`: the actual wait is `rng() * delay` ("full jitter"). `rng` defaults to `Math.random` and must be called once per wait.
- `shouldRetry(error, attempt)`: called after a failed attempt (`attempt` is 1 for the first attempt). If it returns false the error is thrown at once. Default: retry every error.
- `onRetry({ error, attempt, delayMs })`: called before waiting, once per retry, with the actual wait in `delayMs`. It is not called for the final failure.
- `signal`: an AbortSignal. If it is already aborted before an attempt, `retry` throws `AbortError` (from `src/errors.js`) without calling `fn`. If it is aborted while waiting, `retry` throws `AbortError` right after the wait instead of calling `fn` again. `AbortError#cause` is the last error from `fn`, if there was one.
- `sleep(ms)` stays injectable so tests do not really wait.
