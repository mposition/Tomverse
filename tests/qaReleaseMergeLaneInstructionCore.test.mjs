import assert from "node:assert/strict";
import test from "node:test";

import {
  QA_RELEASE_INSTRUCTION_TTL_MS,
  judgeQaReleaseInstructionConsume,
  judgeQaReleaseInstructionIssue,
} from "../lib/qaReleaseMergeLaneInstructionCore.ts";

const HEAD = "c".repeat(40);
const CONTROL = { revision: 4, developLaneOn: true };

const issue = (overrides) =>
  judgeQaReleaseInstructionIssue({
    control: CONTROL,
    callerRevision: 4,
    latched: false,
    attemptOpen: false,
    pullRequest: { number: 12, headSha: HEAD, base: "develop" },
    ...overrides,
  });

test("an instruction is issued only under the newest revision with the develop lane on and the lane free", () => {
  assert.deepEqual(issue({}), { issue: true, revision: 4 });
  assert.deepEqual(issue({ control: null }), { issue: false, reason: "control_unavailable" });
  assert.deepEqual(issue({ callerRevision: 3 }), { issue: false, reason: "revision_mismatch" });
  assert.deepEqual(issue({ callerRevision: null }), { issue: false, reason: "revision_mismatch" });
  assert.deepEqual(issue({ control: { revision: 4, developLaneOn: false } }), { issue: false, reason: "develop_lane_off" });
  assert.deepEqual(issue({ latched: null }), { issue: false, reason: "lane_state_unknown" });
  assert.deepEqual(issue({ latched: true }), { issue: false, reason: "latched" });
  assert.deepEqual(issue({ attemptOpen: true }), { issue: false, reason: "attempt_open" });
});

test("an instruction names a develop pull request by number and full head SHA", () => {
  assert.deepEqual(issue({ pullRequest: { number: 12, headSha: HEAD, base: "main" } }), { issue: false, reason: "not_develop" });
  for (const pullRequest of [
    { number: 0, headSha: HEAD, base: "develop" },
    { number: 1.5, headSha: HEAD, base: "develop" },
    { number: 12, headSha: "abc", base: "develop" },
    { number: 12, headSha: HEAD.toUpperCase(), base: "develop" },
  ]) {
    assert.deepEqual(issue({ pullRequest }), { issue: false, reason: "invalid_pull_request" }, JSON.stringify(pullRequest));
  }
});

const NOW = 1_000_000;
const STORED = {
  attemptId: "attempt-1",
  pullRequestNumber: 12,
  headSha: HEAD,
  base: "develop",
  revision: 4,
  expiresAtMs: NOW + QA_RELEASE_INSTRUCTION_TTL_MS,
  consumed: false,
};
const consume = (overrides) =>
  judgeQaReleaseInstructionConsume({
    instruction: STORED,
    request: { attemptId: "attempt-1", pullRequestNumber: 12, headSha: HEAD, base: "develop" },
    control: CONTROL,
    callerRevision: 4,
    latched: false,
    dbNowMs: NOW,
    ...overrides,
  });

test("a consume succeeds once, before expiry, for exactly what was issued", () => {
  assert.deepEqual(consume({}), { consume: true });
  assert.deepEqual(consume({ instruction: { ...STORED, consumed: true } }), { consume: false, reason: "already_consumed" });
  assert.deepEqual(consume({ instruction: null }), { consume: false, reason: "instruction_unknown" });
  assert.deepEqual(consume({ request: { attemptId: "other", pullRequestNumber: 12, headSha: HEAD, base: "develop" } }), {
    consume: false,
    reason: "instruction_unknown",
  });
});

test("expiry is on the database clock and its boundary is expired", () => {
  assert.deepEqual(consume({ dbNowMs: NOW + QA_RELEASE_INSTRUCTION_TTL_MS }), { consume: false, reason: "expired" });
  assert.deepEqual(consume({ dbNowMs: NOW + QA_RELEASE_INSTRUCTION_TTL_MS - 1 }), { consume: true });
  assert.deepEqual(consume({ dbNowMs: Number.NaN }), { consume: false, reason: "expired" });
});

test("a pull request whose number, head or base changed since issue is refused", () => {
  for (const change of [{ pullRequestNumber: 13 }, { headSha: "d".repeat(40) }, { base: "main" }]) {
    const request = { attemptId: "attempt-1", pullRequestNumber: 12, headSha: HEAD, base: "develop", ...change };
    assert.deepEqual(consume({ request }), { consume: false, reason: "binding_mismatch" }, JSON.stringify(change));
  }
});

test("the app's own switches are judged again at consume, and a newer revision refuses", () => {
  assert.deepEqual(consume({ control: { revision: 5, developLaneOn: true }, callerRevision: 5 }), {
    consume: false,
    reason: "revision_moved",
  });
  assert.deepEqual(consume({ control: { revision: 4, developLaneOn: false } }), { consume: false, reason: "develop_lane_off" });
  assert.deepEqual(consume({ callerRevision: 3 }), { consume: false, reason: "revision_mismatch" });
  assert.deepEqual(consume({ control: null }), { consume: false, reason: "control_unavailable" });
  assert.deepEqual(consume({ latched: true }), { consume: false, reason: "latched" });
  assert.deepEqual(consume({ latched: null }), { consume: false, reason: "lane_state_unknown" });
});
