import { after } from "node:test";

import { setAmuxV19AppTimingForTest } from
  "../../lib/amux/ideaLocalAppRequest.mjs";

/** An instant, deterministic clock for the v19 runner's retry and stop
 * schedules, for the rest of the importing test file. Each sleep advances
 * the clock by its duration and is recorded. */
export function installAmuxV19FakeAppTiming() {
  const clock = { now: 0, sleeps: [] };
  const restore = setAmuxV19AppTimingForTest({
    now: () => clock.now,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      clock.sleeps.push(ms);
      clock.now += ms;
    },
  });
  after(restore);
  return clock;
}
