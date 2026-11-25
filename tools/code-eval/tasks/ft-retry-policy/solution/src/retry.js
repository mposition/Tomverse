import { AbortError } from "./errors.js";
import { sleep as defaultSleep } from "./sleep.js";

export async function retry(
    fn,
    {
        retries = 3,
        delayMs = 100,
        sleep = defaultSleep,
        backoff = "constant",
        factor = 2,
        maxDelayMs = Infinity,
        jitter = false,
        rng = Math.random,
        shouldRetry = () => true,
        onRetry,
        signal,
    } = {},
) {
    let attempt = 0;
    let lastError;
    for (;;) {
        if (signal?.aborted) throw new AbortError("retry aborted", lastError === undefined ? undefined : { cause: lastError });
        attempt += 1;
        try {
            return await fn(attempt);
        } catch (error) {
            lastError = error;
            if (attempt > retries) throw error;
            if (!shouldRetry(error, attempt)) throw error;
            let delay = backoff === "exponential" ? delayMs * factor ** (attempt - 1) : delayMs;
            delay = Math.min(delay, maxDelayMs);
            if (jitter) delay = rng() * delay;
            if (onRetry) onRetry({ error, attempt, delayMs: delay });
            await sleep(delay);
        }
    }
}
