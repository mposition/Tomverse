import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const MERGE = "c".repeat(40);
const DIFF = "d".repeat(64);
const OWNER = 60078951;
const createdAt = new Date("2026-10-15T05:00:00Z");

let bindings;
let calls;
let completeResult;

mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: { engineeringAgentBinding: { findMany: async (args) => { calls.push(["findMany", args]); return bindings; } } },
  },
});
class ReadError extends Error {}
mock.module(mod("lib/engineeringAgentGitHubRead.ts"), {
  namedExports: { EngineeringAgentGitHubReadError: ReadError, readEngineeringAgentPullObservation: async () => { throw new Error("live read"); } },
});
mock.module(mod("lib/engineeringAgentStore.ts"), {
  namedExports: {
    engineeringAgentBindingSnapshotSchema: { parse: (value) => value },
    engineeringAgentTransactionInAmux: (lent) => lent,
    runEngineeringAgentTransaction: async (_prisma, work) => work("engineering-tx"),
    recordEngineeringAgentBindingObservation: async (tx, input) => { calls.push(["observe", tx, input]); return { recorded: true }; },
    openEngineeringAgentWorkItem: async (tx, input) => { calls.push(["mismatch", tx, input]); return { workItemId: "m" }; },
  },
});
mock.module(mod("lib/amux/reviewMergeObserved.ts"), {
  namedExports: {
    completeAmuxV22ReviewOnObservedMerge: async (input, attachment) => {
      calls.push(["complete", input]);
      if (completeResult.completed) await attachment.work("amux-tx", { taskId: input.taskId });
      return completeResult;
    },
  },
});

const { observeEngineeringAgentPullRequests } = await import(mod("lib/engineeringAgentPrObserver.ts"));

const binding = (overrides = {}) => ({
  id: "binding", runId: "700000001", prNumber: 42, verifiedHeadSha: HEAD, createdAt,
  snapshot: { baseSha: BASE, diffDigest: DIFF, treeId: "e".repeat(40), invalidatedReviewIds: [] },
  approvalObservation: null,
  run: { cardId: "card", amuxAttemptId: "attempt" },
  ...overrides,
});
const pull = (overrides = {}) => ({
  state: "open", merged: false, mergedAt: null, mergeCommitSha: null, mergedByKind: "unknown",
  baseRef: "develop", baseSha: BASE, headSha: HEAD,
  reviews: [{ id: 9, userId: OWNER, login: "mposition", state: "APPROVED", commitId: HEAD,
    submittedAt: new Date("2026-10-15T05:30:00Z") }],
  requiredChecks: { allPassed: true }, diffDigest: DIFF,
  ...overrides,
});
const run = async (rows, read) => {
  bindings = rows;
  calls = [];
  return observeEngineeringAgentPullRequests({}, { read, now: () => new Date("2026-10-15T05:40:00Z") });
};
const recorded = () => calls.filter(([kind]) => kind !== "findMany");

// Only current, unmerged bindings are read.
await run([], async () => pull());
assert.deepEqual(calls[0][1].where.state, "open");
assert.equal(calls[0][1].where.supersededAt, null);

// An open pull request that meets all seven conditions: the approval is recorded with its reviewer.
assert.deepEqual(await run([binding()], async () => pull()), [{ bindingId: "binding", outcome: "approved" }]);
assert.deepEqual(recorded(), [["observe", "engineering-tx", {
  bindingId: "binding", kind: "approval",
  observation: { verdict: "approved", reviewId: 9, reviewCommitId: HEAD, submittedAt: "2026-10-15T05:30:00.000Z",
    observedAt: "2026-10-15T05:40:00.000Z" },
  reviewer: { githubId: OWNER, login: "mposition" },
}]]);

// Not yet reviewed, checks pending, or already approved: nothing is recorded before the merge.
for (const overrides of [{ reviews: [] }, { requiredChecks: null }, { diffDigest: null }, { requiredChecks: { allPassed: false } }]) {
  assert.deepEqual(await run([binding()], async () => pull(overrides)), [{ bindingId: "binding", outcome: "waiting" }]);
  assert.deepEqual(recorded(), []);
}
assert.deepEqual(await run([binding({ approvalObservation: { verdict: "approved", reviewId: 9, observedAt: "2026-10-15T05:40:00.000Z" } })],
  async () => pull()), [{ bindingId: "binding", outcome: "waiting" }]);
assert.deepEqual(recorded(), []);

// A read that fails decides nothing.
assert.deepEqual(await run([binding()], async () => { throw new ReadError("http_error"); }),
  [{ bindingId: "binding", outcome: "unreadable" }]);
assert.deepEqual(recorded(), []);

// Merged after an approval recorded before it: the card completes and the merge is recorded in the same transaction.
const approved = { verdict: "approved", reviewId: 9, observedAt: "2026-10-15T05:40:00.000Z" };
const merged = { state: "closed", merged: true, mergedAt: new Date("2026-10-15T05:50:00Z"), mergeCommitSha: MERGE, mergedByKind: "user" };
completeResult = { completed: true, taskRevision: 9 };
assert.deepEqual(await run([binding({ approvalObservation: approved })], async () => pull(merged)),
  [{ bindingId: "binding", outcome: "completed" }]);
assert.deepEqual(recorded()[0], ["complete", { taskId: "card", attemptId: "attempt", prNumber: 42, mergeCommitSha: MERGE, approvalReviewId: 9 }]);
assert.equal(recorded()[1][0], "observe");
assert.equal(recorded()[1][1], "amux-tx");
assert.equal(recorded()[1][2].kind, "merge");
assert.equal(recorded()[1][2].observation.mergeCommitSha, MERGE);

// A card that is not a v22 implement Task keeps its own review: only the merge is recorded.
completeResult = { completed: false, reason: "not_a_v22_implement_task" };
assert.deepEqual(await run([binding({ approvalObservation: approved })], async () => pull(merged)),
  [{ bindingId: "binding", outcome: "merge_recorded" }]);
assert.equal(recorded()[0][0], "complete");
assert.deepEqual(recorded()[1].slice(0, 2), ["observe", "engineering-tx"]);
assert.equal(recorded()[1][2].kind, "merge");
assert.equal(recorded().length, 2);

// Merged with no approval recorded before it: not approved, a mismatch for a person, and no completion.
for (const approval of [null, { verdict: "approved", reviewId: 9, observedAt: "2026-10-15T06:00:00.000Z" }]) {
  assert.deepEqual(await run([binding({ approvalObservation: approval })], async () => pull(merged)),
    [{ bindingId: "binding", outcome: "merged_without_approval" }]);
  const kinds = recorded().map(([kind, , input]) => [kind, input.kind]);
  assert.equal(kinds.some(([kind]) => kind === "complete"), false);
  assert.deepEqual(kinds.at(-1), ["mismatch", "state_mismatch"]);
  assert.equal(recorded().at(-1)[2].reason, "merged_without_approval");
  if (approval === null) {
    assert.deepEqual(recorded()[0][2].observation, { verdict: "not_approved", reason: "merged_without_approval",
      observedAt: "2026-10-15T05:40:00.000Z" });
  }
}
