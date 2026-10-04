import assert from "node:assert/strict";
import test from "node:test";

import { decideQaReleaseLaneRound, judgeQaReleaseMergeLanding } from "../lib/qaReleaseMergeLaneRoundCore.ts";

const PICK = { number: 7, baseRefName: "develop", headRefOid: "a".repeat(40) };
const round = (overrides) =>
  decideQaReleaseLaneRound({
    latched: false,
    attemptOpen: false,
    stagingDeployments: [{ status: "SUCCESS" }, { status: "SLEEPING" }],
    selection: { pick: PICK, skipped: [] },
    ...overrides,
  });

test("a free lane with a candidate asks the app for an instruction", () => {
  assert.deepEqual(round({}), { action: "request_instruction", pullRequest: PICK });
});

test("a latch, an open attempt or unread lane state stops the round, in that order of reading", () => {
  assert.deepEqual(round({ latched: true }), { action: "stop", reason: "latched" });
  assert.deepEqual(round({ attemptOpen: true }), { action: "stop", reason: "attempt_open" });
  assert.deepEqual(round({ latched: null }), { action: "stop", reason: "state_unknown" });
  assert.deepEqual(round({ attemptOpen: null }), { action: "stop", reason: "state_unknown" });
  assert.deepEqual(round({ latched: true, attemptOpen: null }), { action: "stop", reason: "state_unknown" });
});

test("any staging deployment in flight holds; unread deployments stop", () => {
  for (const status of ["WAITING", "NEEDS_APPROVAL", "QUEUED", "INITIALIZING", "BUILDING", "DEPLOYING"]) {
    assert.deepEqual(
      round({ stagingDeployments: [{ status: "SUCCESS" }, { status }] }),
      { action: "hold", reason: "deployment_in_flight", inFlight: 1 },
      status,
    );
  }
  assert.deepEqual(round({ stagingDeployments: null }), { action: "stop", reason: "deployments_unknown" });
});

test("no candidate is idle, not a stop", () => {
  assert.deepEqual(round({ selection: { pick: null, skipped: [{ number: 1, kind: "exclusion_unjudged" }] } }), {
    action: "idle",
  });
});

const landed = (overrides) =>
  judgeQaReleaseMergeLanding({
    merged: true,
    baseRefName: "develop",
    mergeCommitSha: "b".repeat(40),
    mergeCommitOnDevelop: true,
    ...overrides,
  });

test("a merge landed only when merged into develop with its commit on develop", () => {
  assert.deepEqual(landed({}), { landed: true, mergeCommitSha: "b".repeat(40) });
});

test("a merge anywhere else, or one that cannot be read back, latches", () => {
  assert.deepEqual(landed({ baseRefName: "main" }), { landed: false, latch: true, reason: "wrong_base" });
  assert.deepEqual(landed({ baseRefName: "release/x" }), { landed: false, latch: true, reason: "wrong_base" });
  assert.deepEqual(landed({ merged: false }), { landed: false, latch: true, reason: "not_merged" });
  assert.deepEqual(landed({ mergeCommitOnDevelop: false }), { landed: false, latch: true, reason: "not_on_develop" });
  for (const unread of [{ merged: null }, { baseRefName: null }, { mergeCommitOnDevelop: null }, { mergeCommitSha: null }, { mergeCommitSha: "xyz" }]) {
    assert.deepEqual(landed(unread), { landed: false, latch: true, reason: "unknown" }, JSON.stringify(unread));
  }
});
