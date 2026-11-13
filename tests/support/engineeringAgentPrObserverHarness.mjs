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
    prisma: { engineeringAgentBinding: { findMany: async (args) => {
      calls.push(["findMany", args]);
      const start = args.cursor ? bindings.findIndex((row) => row.id === args.cursor.id) + 1 : 0;
      return bindings.slice(start, start + args.take);
    } } },
  },
});
class ReadError extends Error { constructor(code) { super(code); this.code = code; } }
mock.module(mod("lib/engineeringAgentGitHubRead.ts"), {
  namedExports: { EngineeringAgentGitHubReadError: ReadError, readEngineeringAgentPullObservation: async () => { throw new Error("live read"); } },
});
mock.module(mod("lib/engineeringAgentStore.ts"), {
  namedExports: {
    engineeringAgentBindingSnapshotSchema: { parse: (value) => value,
      safeParse: (value) => typeof value?.diffDigest === "string" ? { success: true, data: value } : { success: false } },
    engineeringAgentTransactionInAmux: (lent) => lent,
    runEngineeringAgentTransaction: async (_prisma, work) => work("engineering-tx"),
    recordEngineeringAgentBindingObservation: async (tx, input) => { calls.push(["observe", tx, input]); return { recorded: true }; },
    openEngineeringAgentWorkItem: async (tx, input) => { calls.push(["mismatch", tx, input]); return { workItemId: "m" }; },
  },
});
// The live Decision Maker read is never reached here: every DM case passes its own port.
mock.module(mod("lib/amux/dmT2MergeService.ts"), {
  namedExports: { readAmuxDmT2MergeObserved: async () => { throw new Error("live dm read"); } },
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

const { observeEngineeringAgentPullRequests, ENGINEERING_AGENT_PR_FILE_MISMATCH_CAUSE,
  ENGINEERING_AGENT_UNAPPROVED_MERGE_CAUSE } = await import(mod("lib/engineeringAgentPrObserver.ts"));

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
  return observeEngineeringAgentPullRequests({ read, now: () => new Date("2026-10-15T05:40:00Z") });
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
  [{ bindingId: "binding", outcome: "unreadable", code: "http_error" }]);
assert.deepEqual(recorded(), []);

// Merged after an approval recorded before it: the card completes and the merge is recorded in the same transaction.
const approved = { verdict: "approved", reviewId: 9, observedAt: "2026-10-15T05:40:00.000Z" };
const merged = { state: "closed", merged: true, mergedAt: new Date("2026-10-15T05:50:00Z"), mergeCommitSha: MERGE, mergedByKind: "user" };
completeResult = { completed: true, taskRevision: 9 };
assert.deepEqual(await run([binding({ approvalObservation: approved })], async () => pull(merged)),
  [{ bindingId: "binding", outcome: "completed" }]);
assert.deepEqual(recorded()[0], ["complete", { taskId: "card", attemptId: "attempt", prNumber: 42, mergeCommitSha: MERGE, approvalReviewId: 9, changedFiles: null, bindingId: "binding" }]);
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
completeResult = { completed: false, reason: "pr_file_state_mismatch" };
assert.deepEqual(await run([binding({ approvalObservation: approved })],
  async () => pull({ ...merged, changedFiles: ["LIB/AMUX/execution.ts"] })),
  [{ bindingId: "binding", outcome: "pr_file_state_mismatch" }]);
assert.equal(recorded().at(-1)[2].reason, "pr_file_state_mismatch");
assert.equal(recorded().length, 3);

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

// Owner decision 2026-11-12: an authorised approver's own merge of the verified
// head into develop is the approval. The card completes with no review id, the
// merge observation says so, and no mismatch stops the agent.
{
  const ownMerge = { ...merged, mergedByApprover: true, reviews: [] };
  completeResult = { completed: true, taskRevision: 9 };
  assert.deepEqual(await run([binding()], async () => pull(ownMerge)), [{ bindingId: "binding", outcome: "completed" }]);
  assert.deepEqual(recorded()[0], ["complete", { taskId: "card", attemptId: "attempt", prNumber: 42,
    mergeCommitSha: MERGE, approvalReviewId: null, changedFiles: null, bindingId: "binding" }]);
  assert.deepEqual(recorded()[1].slice(0, 2), ["observe", "amux-tx"]);
  // The basis rides the audit entry; the stored observation's shape is fixed by its CHECK.
  assert.equal(recorded()[1][2].approvedByMerge, true);
  assert.equal("approvedByMerge" in recorded()[1][2].observation, false);
  assert.equal(recorded().some(([kind]) => kind === "mismatch"), false);

  // The owner already settled the card (or it is not in review): the merge is recorded, nothing stops.
  completeResult = { completed: false, reason: "task_not_in_review" };
  assert.deepEqual(await run([binding()], async () => pull(ownMerge)), [{ bindingId: "binding", outcome: "merge_recorded" }]);
  assert.equal(recorded().at(-1)[2].approvedByMerge, true);
  assert.equal(recorded().some(([kind]) => kind === "mismatch"), false);

  // A review recorded before the merge still completes on that review, and the merge is not marked.
  completeResult = { completed: true, taskRevision: 9 };
  await run([binding({ approvalObservation: approved })], async () => pull({ ...ownMerge }));
  assert.equal(recorded()[0][1].approvalReviewId, 9);
  assert.equal("approvedByMerge" in recorded()[1][2].observation, false);

  // Not the approver's own merge of the verified head into develop: still a
  // mismatch, under a cause key the store admits (a prefix of at most 20
  // characters; the reason codes themselves were longer and were refused).
  for (const cause of [ENGINEERING_AGENT_UNAPPROVED_MERGE_CAUSE, ENGINEERING_AGENT_PR_FILE_MISMATCH_CAUSE])
    assert.match(cause, /^[a-z0-9_]{1,20}$/);
  const moved = "f".repeat(40);
  for (const overrides of [{ mergedByApprover: false }, { baseRef: "main" },
    // A moved head whose pull request diff changed, or could not be read.
    { headSha: moved, diffDigest: "9".repeat(64) }, { headSha: moved, diffDigest: null }]) {
    assert.deepEqual(await run([binding()], async () => pull({ ...ownMerge, ...overrides })),
      [{ bindingId: "binding", outcome: "merged_without_approval" }]);
    assert.equal(recorded().at(-1)[2].reason, "merged_without_approval");
    assert.equal(recorded().at(-1)[2].causeKey, "unapproved_merge:binding");
    assert.equal(recorded().some(([kind]) => kind === "complete"), false);
  }

  // #3828 (2026-11-13): develop merged into the branch moved the head, but the
  // pull request's diff is byte for byte the verified one, so the approver's
  // merge is still the approval and the card completes.
  completeResult = { completed: true, taskRevision: 9 };
  assert.deepEqual(await run([binding()], async () => pull({ ...ownMerge, headSha: moved })),
    [{ bindingId: "binding", outcome: "completed" }]);
  assert.equal(recorded()[0][1].approvalReviewId, null);
  assert.equal(recorded().some(([kind]) => kind === "mismatch"), false);
  // Without a readable bound diff to compare, a moved head is not verified.
  assert.deepEqual(await run([binding({ snapshot: { baseSha: BASE } })], async () => pull({ ...ownMerge, headSha: moved })),
    [{ bindingId: "binding", outcome: "merged_without_approval" }]);
}

// Owner decision 2026-11-13: the merge lane's own merge into develop of a pull
// request the Decision Maker approved before it, at exactly the merged head and
// diff, is the approval (approval_basis dm_approval); nothing stops.
{
  const SETTLEMENT = "0123abcd-0000-8000-8000-000000000001";
  const laneMerge = { ...merged, mergedByKind: "bot", mergedByApprover: false, reviews: [] };
  const facts = (over = {}) => ({ settlementId: SETTLEMENT, approvedHeadSha: HEAD, approvedDiffDigest: DIFF,
    decidedAt: new Date("2026-10-15T05:45:00Z"), laneMerge: "merged", ...over });
  const dmRun = async (read, answer) => {
    bindings = [binding()];
    calls = [];
    return observeEngineeringAgentPullRequests({ read, now: () => new Date("2026-10-15T05:40:00Z"),
      dmMerge: async (input) => { calls.push(["dm", input]); return typeof answer === "function" ? answer() : answer; } });
  };

  completeResult = { completed: true, taskRevision: 9 };
  assert.deepEqual(await dmRun(async () => pull(laneMerge), facts()), [{ bindingId: "binding", outcome: "completed" }]);
  assert.deepEqual(calls.find(([kind]) => kind === "dm")[1],
    { bindingId: "binding", prNumber: 42, headSha: HEAD, mergeCommitSha: MERGE });
  const complete = calls.find(([kind]) => kind === "complete")[1];
  assert.equal(complete.approvalReviewId, null);
  assert.equal(complete.dmSettlementId, SETTLEMENT);
  const observed = calls.find(([kind]) => kind === "observe");
  assert.equal(observed[2].approvedByDm, true);
  assert.equal("approvedByMerge" in observed[2], false);
  assert.equal(calls.some(([kind]) => kind === "mismatch"), false);

  // Not the approved change, not develop, not the lane's merge, or no approval: the agent stops as before.
  for (const [pullOver, answer] of [
    [{ headSha: "f".repeat(40) }, facts()],
    [{ baseRef: "main" }, facts()],
    [{ diffDigest: "9".repeat(64) }, facts()],
    [{ mergedByKind: "user" }, facts()],
    [{}, facts({ laneMerge: null })],
    [{}, facts({ decidedAt: new Date("2026-10-15T06:00:00Z") })],
    [{}, null],
  ]) {
    assert.deepEqual(await dmRun(async () => pull({ ...laneMerge, ...pullOver }), answer),
      [{ bindingId: "binding", outcome: "merged_without_approval" }], JSON.stringify(pullOver));
    assert.equal(calls.some(([kind]) => kind === "complete"), false);
    assert.equal(calls.at(-1)[2].causeKey, "unapproved_merge:binding");
  }

  // The lane's report still to come, a diff not read, or an approval not read: nothing is decided this round.
  for (const [pullOver, answer] of [[{}, facts({ laneMerge: "pending" })], [{ diffDigest: null }, facts()]]) {
    assert.deepEqual(await dmRun(async () => pull({ ...laneMerge, ...pullOver }), answer),
      [{ bindingId: "binding", outcome: "waiting" }]);
    assert.deepEqual(calls.filter(([kind]) => kind !== "findMany" && kind !== "dm"), []);
  }
  assert.deepEqual(await dmRun(async () => pull(laneMerge), () => { throw new Error("db"); }),
    [{ bindingId: "binding", outcome: "unreadable", code: "dm_approval_unreadable" }]);
  assert.deepEqual(calls.filter(([kind]) => kind !== "findMany" && kind !== "dm"), []);

  // An approver's own merge, or a review recorded first, never asks for the Decision Maker's approval.
  await dmRun(async () => pull({ ...merged, mergedByApprover: true, reviews: [] }), facts());
  assert.equal(calls.some(([kind]) => kind === "dm"), false);

  // Without the port (the switch off) the same merge stops the agent, exactly as before.
  assert.deepEqual(await run([binding()], async () => pull(laneMerge)),
    [{ bindingId: "binding", outcome: "merged_without_approval" }]);
}

// A round reads every watched binding, page after page: none is crowded out by older ones that wait.
{
  const many = Array.from({ length: 45 }, (_, index) => binding({ id: `binding-${String(index).padStart(3, "0")}` }));
  const outcomes = await run(many, async () => pull({ reviews: [] }));
  assert.equal(outcomes.length, 45);
  assert.equal(new Set(outcomes.map((entry) => entry.bindingId)).size, 45);
  assert.equal(calls.filter(([kind]) => kind === "findMany").length, 3);
}
