// Key transitions (docs/policy/sre-ops.md §1, §5): thresholds, recovery after
// two good evaluations, worsening only to a later band, unknown changes
// nothing, and a second open on the same owner date is a reopen even after 24
// hours -- the 25-hour daylight-saving day.

import assert from "node:assert/strict";
import test from "node:test";

import {
  REOPEN_WINDOW_MS,
  S2_PAGE_KEYS,
  S2_PAGE_SIGNALS,
  evaluateKey,
  initialKeyState,
} from "../scripts/ops-observer/classify-core.mjs";

const MIN = 60_000;
const readiness = S2_PAGE_SIGNALS.find((s) => s.id === "P1a");
const cron = S2_PAGE_SIGNALS.find((s) => s.id === "P3");

function run(signalDef, observations, { start = 0, step = 10 * MIN, ownerDate = "2026-10-05", state } = {}) {
  let current = state ?? initialKeyState();
  const messages = [];
  observations.forEach((obs, i) => {
    const out = evaluateKey(signalDef, current, obs, { now: start + i * step, ownerDate });
    current = out.state;
    if (out.message) messages.push([i, out.message]);
  });
  return { state: current, messages };
}

test("S2 has the policy's eight page keys", () => {
  assert.deepEqual(S2_PAGE_KEYS, [
    "P1a#database",
    "P1a#securityEnvironment",
    "P1b#providerBudgets",
    "P1c#emailSnapshotKeyring",
    "P1c#emailSendingIdentity",
    "P1u#snapshot",
    "P3#credit_reservation_reconciliation",
    "P-D#standard_email_drain",
  ]);
});

test("readiness opens on the third consecutive bad evaluation, not earlier", () => {
  assert.deepEqual(run(readiness, ["false", "false"]).messages, []);
  assert.deepEqual(run(readiness, ["false", "ok", "false", "false"]).messages, []);
  assert.deepEqual(run(readiness, ["false", "false", "false"]).messages, [[2, "new_open"]]);
});

test("unknown neither advances nor resets a streak", () => {
  assert.deepEqual(run(readiness, ["false", "unknown", "false", "unknown", "false"]).messages, [[4, "new_open"]]);
  const open = run(readiness, ["false", "false", "false"]).state;
  assert.deepEqual(run(readiness, ["ok", "unknown", "ok"], { state: open }).messages, [[2, "recovery"]]);
});

test("recovery needs two consecutive good evaluations", () => {
  const r = run(readiness, ["false", "false", "false", "ok", "false", "ok", "ok"]);
  assert.deepEqual(r.messages, [[2, "new_open"], [6, "recovery"]]);
  assert.equal(r.state.status, "closed");
});

test("cron silence opens at once, including straight into stuck", () => {
  assert.deepEqual(run(cron, ["delayed"]).messages, [[0, "new_open"]]);
  const stuck = run(cron, ["stuck"]);
  assert.deepEqual(stuck.messages, [[0, "new_open"]]);
  assert.equal(stuck.state.lastBand, "stuck");
});

test("worsening only on a move to a later band, once", () => {
  const r = run(cron, ["delayed", "stuck", "stuck", "delayed", "stuck"]);
  assert.deepEqual(r.messages, [[0, "new_open"], [1, "worsening"]]);
});

test("reopen within 24 hours of recovery; new open after, on a new date", () => {
  const recovered = run(readiness, ["false", "false", "false", "ok", "ok"], { ownerDate: "2026-10-05" }).state;
  const soon = run(readiness, ["false", "false", "false"], {
    start: recovered.recoveredAt + 60 * MIN,
    ownerDate: "2026-10-05",
    state: recovered,
  });
  assert.deepEqual(soon.messages, [[2, "reopen"]]);

  const later = run(readiness, ["false", "false", "false"], {
    start: recovered.recoveredAt + REOPEN_WINDOW_MS + MIN,
    ownerDate: "2026-10-06",
    state: recovered,
  });
  assert.deepEqual(later.messages, [[2, "new_open"]]);
});

test("a second open on the same owner date is a reopen even after 24 hours (25-hour day)", () => {
  const recovered = run(readiness, ["false", "false", "false", "ok", "ok"], { ownerDate: "2027-04-04" }).state;
  const sameDate = run(readiness, ["false", "false", "false"], {
    start: recovered.recoveredAt + REOPEN_WINDOW_MS + 10 * MIN,
    ownerDate: "2027-04-04",
    state: recovered,
  });
  assert.deepEqual(sameDate.messages, [[2, "reopen"]]);
  assert.equal(sameDate.state.newOpenOwnerDate, "2027-04-04");
});

test("inputs outside the contract throw instead of guessing", () => {
  const s = initialKeyState();
  assert.throws(() => evaluateKey(readiness, s, "degraded", { now: 0, ownerDate: "2026-10-05" }), /band_unknown/);
  assert.throws(() => evaluateKey(readiness, s, "ok", { now: 1.5, ownerDate: "2026-10-05" }), /now_invalid/);
  assert.throws(() => evaluateKey(readiness, s, "ok", { now: 0, ownerDate: "05/10/2026" }), /owner_date_invalid/);
  assert.throws(() => evaluateKey(readiness, { ...s, streak: 4 }, "ok", { now: 0, ownerDate: "2026-10-05" }), /state_invalid/);
});
