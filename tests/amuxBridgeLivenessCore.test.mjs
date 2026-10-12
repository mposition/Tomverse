import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_BRIDGE_LOST_AFTER_MS,
  AMUX_BRIDGE_WATCH_HORIZON_MS,
  amuxBridgeWatchHorizonStart,
  judgeAmuxBridgeLiveness,
} from "../lib/amux/bridgeLivenessCore.ts";

const NOW = new Date("2026-10-12T03:00:00.000Z");
const at = (offsetMs) => ({ leaseExpiresAt: new Date(NOW.getTime() + offsetMs) });
const MINUTE = 60_000;

test("no runtime row means there is no bridge to watch", () => {
  assert.deepEqual(judgeAmuxBridgeLiveness([], NOW), { state: "unwatched" });
});

test("one live lease among lapsed ones is a live bridge", () => {
  assert.deepEqual(
    judgeAmuxBridgeLiveness([at(-10 * MINUTE), at(45_000), at(-MINUTE)], NOW),
    { state: "live", liveRuntimes: 1 }
  );
});

test("a lease that runs out exactly now is out", () => {
  assert.deepEqual(judgeAmuxBridgeLiveness([at(0)], NOW), {
    state: "lapsing",
    lostSince: NOW,
  });
});

test("every lease out for less than the grace period is lapsing, not lost", () => {
  const verdict = judgeAmuxBridgeLiveness(
    [at(-2 * MINUTE), at(-(AMUX_BRIDGE_LOST_AFTER_MS - 1))],
    NOW
  );
  assert.equal(verdict.state, "lapsing");
  // The newest expiry is when the last heartbeat stopped counting.
  assert.deepEqual(verdict.lostSince, at(-2 * MINUTE).leaseExpiresAt);
});

test("every lease out for the grace period or longer is lost", () => {
  assert.deepEqual(
    judgeAmuxBridgeLiveness(
      [at(-AMUX_BRIDGE_LOST_AFTER_MS), at(-30 * MINUTE), at(-31 * MINUTE)],
      NOW
    ),
    {
      state: "lost",
      lostSince: at(-AMUX_BRIDGE_LOST_AFTER_MS).leaseExpiresAt,
      watchedRuntimes: 3,
    }
  );
});

// The 2026-10-07 halt: leases out at 02:02:37Z, found the next day.
test("a bridge halted for a day is still reported", () => {
  const halted = { leaseExpiresAt: new Date("2026-10-07T02:02:37.000Z") };
  const verdict = judgeAmuxBridgeLiveness(
    [halted, halted, halted],
    new Date("2026-10-08T07:50:00.000Z")
  );
  assert.equal(verdict.state, "lost");
  assert.equal(verdict.watchedRuntimes, 3);
});

test("a lease past the horizon is retired, and is not counted", () => {
  const old = at(-AMUX_BRIDGE_WATCH_HORIZON_MS);
  assert.deepEqual(judgeAmuxBridgeLiveness([old], NOW), { state: "unwatched" });
  const verdict = judgeAmuxBridgeLiveness([old, at(-6 * MINUTE)], NOW);
  assert.equal(verdict.state, "lost");
  assert.equal(verdict.watchedRuntimes, 1);
  assert.deepEqual(amuxBridgeWatchHorizonStart(NOW), old.leaseExpiresAt);
});

test("an unreadable timestamp is never a live lease", () => {
  assert.deepEqual(
    judgeAmuxBridgeLiveness([{ leaseExpiresAt: new Date(Number.NaN) }], NOW),
    { state: "unwatched" }
  );
});
