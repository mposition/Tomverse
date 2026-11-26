import { sleep as defaultSleep } from "./sleep.js";

export async function retry(fn, { retries = 3, delayMs = 100, sleep = defaultSleep } = {}) {
    let attempt = 0;
    for (;;) {
        attempt += 1;
        try {
            return await fn(attempt);
        } catch (error) {
            if (attempt > retries) throw error;
            await sleep(delayMs);
        }
    }
}
