import { after } from "node:test";

import { setAmuxV19AppTimingForTest } from
  "../../lib/amux/ideaLocalAppRequest.mjs";

/** An instant, deterministic sleep for the v19 runner's retry and stop
 * schedules, for the rest of the importing test file. Each sleep adds its
 * duration to the elapsed time (`now`) and is recorded. */
export function installAmuxV19FakeAppTiming() {
  const clock = { now: 0, sleeps: [] };
  const restore = setAmuxV19AppTimingForTest({
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      clock.sleeps.push(ms);
      clock.now += ms;
    },
  });
  after(restore);
  return clock;
}
