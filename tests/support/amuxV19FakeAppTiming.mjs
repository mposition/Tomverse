import { after } from "node:test";

import { AMUX_V19_APP_RETRY_DELAYS_MS, setAmuxV19AppTimingForTest } from
  "../../lib/amux/ideaLocalAppRequest.mjs";

/** An instant, deterministic sleep for the v19 runner's retry and stop
 * schedules, for the rest of the importing test file. Each sleep adds its
 * duration to the elapsed time (`now`) and is recorded.
 *
 * The runner itself waits for the app with no deadline (only the caller's
 * signal or an explicit stop answer ends it). A test link that never comes
 * back would then wait forever, so this sleep ends a wait the way the
 * process stop would: it throws once one request or stop confirmation has
 * waited `maxConsecutiveSleeps` times in a row. A wait begins again at the
 * first delay of the schedule. Tests that need a longer outage raise it. */
export function installAmuxV19FakeAppTiming() {
  const clock = { now: 0, sleeps: [], maxConsecutiveSleeps: 6,
    /** Runs `test` with a link that may stay down for any number of waits. */
    async withLongOutage(test) {
      const previous = clock.maxConsecutiveSleeps;
      clock.maxConsecutiveSleeps = Number.POSITIVE_INFINITY;
      try { return await test(); } finally { clock.maxConsecutiveSleeps = previous; }
    } };
  let consecutive = 0;
  const restore = setAmuxV19AppTimingForTest({
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw signal.reason ?? new Error("aborted");
      if (ms === AMUX_V19_APP_RETRY_DELAYS_MS[0]) consecutive = 0;
      consecutive += 1;
      if (consecutive > clock.maxConsecutiveSleeps)
        throw new Error("the test link stayed down");
      clock.sleeps.push(ms);
      clock.now += ms;
    },
  });
  after(restore);
  return clock;
}
