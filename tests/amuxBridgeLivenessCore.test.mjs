import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import test from "node:test";

import {
  AMUX_BRIDGE_LOST_AFTER_MS,
  AMUX_NON_BRIDGE_WORKERS,
  AMUX_BRIDGE_WATCH_HORIZON_MS,
  amuxBridgeWatchHorizonStart,
  judgeAmuxBridgeLiveness,
} from "../lib/amux/bridgeLivenessCore.ts";

const NOW = new Date("2026-10-12T03:00:00.000Z");
const at = (offsetMs, workerName = "codex-impl") => ({
  workerName,
  leaseExpiresAt: new Date(NOW.getTime() + offsetMs),
});
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
  const halted = { workerName: "codex-impl", leaseExpiresAt: new Date("2026-10-07T02:02:37.000Z") };
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
    judgeAmuxBridgeLiveness([{ workerName: "codex-impl", leaseExpiresAt: new Date(Number.NaN) }], NOW),
    { state: "unwatched" }
  );
});

// 2026-10-12 overnight: the bridges had all halted, and the engineering agent's
// ninety-second registration every thirty minutes read as a live fleet.
test("a runtime no bridge runs never makes the bridges live", () => {
  const verdict = judgeAmuxBridgeLiveness(
    [at(-40 * MINUTE), at(45_000, "engineering-runner")],
    NOW
  );
  assert.equal(verdict.state, "lost");
  assert.equal(verdict.watchedRuntimes, 1);
  assert.deepEqual(judgeAmuxBridgeLiveness([at(45_000, "engineering-runner")], NOW), {
    state: "unwatched",
  });
});

const ROOT = new URL("..", import.meta.url);
const sourceFiles = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|mjs)$/.test(name) ? [path] : [];
  });

// Only host bridges register through the workers routes. Any other caller of
// registerAmuxWorkerRuntime is a runtime that says nothing about the bridges,
// and must be named in AMUX_NON_BRIDGE_WORKERS or it will mask a halted fleet.
test("every runtime the app registers itself is excluded from the bridge watch", () => {
  const root = new URL(".", ROOT).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  const allowed = new Set([
    ["app", "api", "internal", "amux", "workers", "register", "route.ts"].join(sep),
    ["lib", "amux", "workerRuntime.ts"].join(sep),
  ]);
  const callers = ["app", "lib"]
    .flatMap((dir) => sourceFiles(join(root, dir)))
    .filter((path) => /registerAmuxWorkerRuntime\s*\(/.test(readFileSync(path, "utf8")))
    .map((path) => relative(root, path))
    .filter((path) => !allowed.has(path));
  assert.deepEqual(callers, [join("lib", "engineeringAgentAmuxAdapter.ts")]);
  const adapter = readFileSync(join(root, callers[0]), "utf8");
  const worker = adapter.match(/export const ENGINEERING_AGENT_AMUX_WORKER = "([^"]+)";/)?.[1];
  assert.ok(worker, "ENGINEERING_AGENT_AMUX_WORKER not found");
  assert.ok(AMUX_NON_BRIDGE_WORKERS.includes(worker), worker);
});
