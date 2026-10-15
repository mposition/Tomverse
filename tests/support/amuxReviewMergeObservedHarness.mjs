import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

const dbNow = new Date("2026-10-15T06:00:00Z");
let task;
let attempt;
let writes;

const fakeTx = {
  $queryRaw: async (strings) => {
    const sql = strings.join("?");
    if (sql.includes(`FROM "AmuxWorkItem"`)) { writes.push(["read-task"]); return task ? [task] : []; }
    if (sql.includes(`FROM "AmuxExecutionAttempt"`)) return attempt ? [attempt] : [];
    throw new Error(`unexpected query: ${sql}`);
  },
  amuxWorkItem: { updateMany: async (args) => { writes.push(["task", args]); return { count: 1 }; } },
  amuxHumanEscalation: { updateMany: async (args) => { writes.push(["escalation", args]); return { count: 1 }; } },
};

mock.module(mod("lib/amux/dbBoundary.ts"), {
  namedExports: {
    AMUX_DB_BOUNDARIES: { reviewMergeObserved: { operation: "review_merge_observed", prismaCallCeiling: 12, isolation: "mutation" } },
    amuxBoundaryWithAttachment: (boundary) => boundary,
    withAmuxDbBoundary: async (_boundary, work) => work(fakeTx, { dbNow, attachedTransaction: fakeTx }),
  },
});
mock.module(mod("lib/adminAudit.ts"), {
  namedExports: {
    writeSystemAuditLog: async (entry) => { writes.push(["audit", entry]); return "audit-1"; },
    takeAuditChainLock: async () => { writes.push(["lock"]); },
  },
});

const { completeAmuxV22ReviewOnObservedMerge, AMUX_MERGE_OBSERVER_RESOLVER } =
  await import(mod("lib/amux/reviewMergeObserved.ts"));

const MERGE = "c".repeat(40);
const reset = () => {
  task = {
    id: "card", status: "review", owner: null, revision: 8, archivedAt: null,
    sourceSystem: "admin-idea-v4", cardType: "task", taskRole: "implement", reviewPrNumber: 42,
  };
  attempt = { id: "attempt", outcome: "succeeded", toStatus: "review", endedAt: dbNow, v22AssignmentId: "assignment" };
  writes = [];
};
const run = (overrides = {}) => completeAmuxV22ReviewOnObservedMerge({
  taskId: "card", attemptId: "attempt", prNumber: 42, mergeCommitSha: MERGE, approvalReviewId: 7, ...overrides,
});

// The observed approval and merge complete the card once, on the DB clock.
reset();
assert.deepEqual(await run(), { completed: true, taskRevision: 9 });
const taskWrite = writes.find(([kind]) => kind === "task")[1];
assert.deepEqual(taskWrite.where, { id: "card", status: "review", owner: null, archivedAt: null, revision: 8, reviewPrNumber: 42 });
assert.deepEqual(taskWrite.data, { status: "done", revision: { increment: 1 }, v4TerminalAt: dbNow });
const escalation = writes.find(([kind]) => kind === "escalation")[1];
assert.deepEqual(escalation.where, { taskId: "card", status: { in: ["open", "acknowledged"] } });
assert.equal(escalation.data.status, "resolved");
assert.equal(escalation.data.resolutionOutcome, "approve");
assert.equal(escalation.data.resolvedById, AMUX_MERGE_OBSERVER_RESOLVER);
assert.equal(escalation.data.resolvedAt, dbNow);
const audit = writes.find(([kind]) => kind === "audit")[1];
assert.equal(audit.action, "amux.v22.review.merge_observed");
assert.equal(audit.metadata.merge_commit_sha, MERGE);
assert.equal(audit.metadata.approval_review_id, 7);

// Every refusal writes nothing.
const refused = async (setup, reason, overrides) => {
  reset();
  setup();
  assert.deepEqual(await run(overrides), { completed: false, reason });
  // Only the audit chain lock, taken before the card is read; nothing written.
  assert.deepEqual(writes.filter(([kind]) => !kind.startsWith("read-")), [["lock"]]);
};
await refused(() => { task.status = "doing"; }, "task_not_in_review");
await refused(() => { task.owner = "worker"; }, "task_not_in_review");
await refused(() => { task.archivedAt = dbNow; }, "task_not_in_review");
await refused(() => { task = null; }, "task_not_in_review");
await refused(() => { task.taskRole = "design"; }, "not_a_v22_implement_task");
await refused(() => { task.sourceSystem = "workboard"; }, "not_a_v22_implement_task");
await refused(() => { task.reviewPrNumber = 43; }, "review_pr_mismatch");
await refused(() => { task.reviewPrNumber = null; }, "review_pr_mismatch");
await refused(() => { attempt.id = "newer"; }, "not_the_latest_attempt");
await refused(() => { attempt.v22AssignmentId = null; }, "not_the_latest_attempt");
await refused(() => { attempt.toStatus = "todo"; }, "not_the_latest_attempt");
await refused(() => { attempt = null; }, "not_the_latest_attempt");

// Malformed input is a programming error, not a refusal.
reset();
await assert.rejects(run({ mergeCommitSha: "nope" }));
await assert.rejects(run({ prNumber: 0 }));
await assert.rejects(run({ approvalReviewId: -1 }));
assert.deepEqual(writes, []);

// An attachment runs after the audit chain lock, with the completed card's fact.
reset();
let fact;
await completeAmuxV22ReviewOnObservedMerge(
  { taskId: "card", attemptId: "attempt", prNumber: 42, mergeCommitSha: MERGE, approvalReviewId: 7 },
  { prismaCalls: 1, work: async (_tx, value) => { writes.push(["attachment"]); fact = value; } },
);
assert.deepEqual(fact, { taskId: "card", attemptId: "attempt", prNumber: 42, taskRevision: 9 });
const kinds = writes.map(([kind]) => kind);
// The audit chain lock comes first of all, before the card's row lock.
assert.equal(kinds[0], "lock");
assert.ok(kinds.indexOf("lock") < kinds.indexOf("read-task"));
assert.ok(kinds.indexOf("audit") < kinds.indexOf("attachment"));
assert.equal(kinds.filter((kind) => kind === "lock").length, 1);
