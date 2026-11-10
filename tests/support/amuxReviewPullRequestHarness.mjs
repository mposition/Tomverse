import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

const dbNow = new Date("2026-11-11T00:00:00Z");
let task;
let attempt;
let writes;
let attached;

const fakeTx = {
  $queryRaw: async (strings) => {
    const sql = strings.join("?");
    if (sql.includes(`FROM "AmuxWorkItem"`)) return task ? [task] : [];
    if (sql.includes(`FROM "AmuxExecutionAttempt"`)) return attempt ? [attempt] : [];
    throw new Error(`unexpected query: ${sql}`);
  },
  amuxWorkItem: { updateMany: async (args) => { writes.push(["task", args]); return { count: 1 }; } },
};

mock.module(mod("lib/amux/dbBoundary.ts"), {
  namedExports: {
    AMUX_DB_BOUNDARIES: { reviewPullRequest: { operation: "review_pull_request", prismaCallCeiling: 11, isolation: "mutation" } },
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

const { recordAmuxReviewPullRequest, amuxV22ImplementTask } = await import(mod("lib/amux/reviewPullRequest.ts"));

// A v22 implement Task as the publisher finds it: settled to review by its
// worker's attempt before any pull request existed. Its row cannot carry the
// number (the v4 plaintext exclusion keeps reviewSpecialty null, so
// requiresHumanReview stays false, and the review PR check needs it true).
const reset = (overrides = {}) => {
  task = {
    id: "card", status: "review", owner: null, revision: 8, archivedAt: null,
    requiresHumanReview: false, reviewPrNumber: null,
    sourceSystem: "admin-idea-v4", cardType: "task", taskRole: "implement",
    ...overrides,
  };
  attempt = { id: "attempt", worker: "ubuntu-codex", outcome: "succeeded", toStatus: "review", endedAt: dbNow };
  writes = [];
  attached = [];
};
const attachment = { prismaCalls: 0, work: async (_tx, fact) => { attached.push(fact); } };
const run = (overrides = {}, withAttachment = attachment) =>
  recordAmuxReviewPullRequest(
    { taskId: "card", attemptId: "attempt", worker: "ubuntu-codex", prNumber: 3702, ...overrides },
    withAttachment,
  );
const cardWrites = () => writes.filter(([kind]) => kind === "task");

// The publisher's pull request on a v22 implement Task is taken: the card's
// row is left as the schema requires, and the attachment's binding -- the
// engineering publisher's, in this same transaction -- holds the number.
// Before 2026-11-11 this was refused `review_not_required`, which opened a
// state mismatch for every published pull request and halted the agent.
reset();
assert.deepEqual(await run(), { recorded: true, taskRevision: 8, changed: false });
assert.deepEqual(cardWrites(), []);
const held = writes.find(([kind]) => kind === "audit")[1];
assert.equal(held.action, "amux.review.pull_request_recorded");
assert.equal(held.targetId, "card");
assert.deepEqual(held.metadata, {
  pr_number: 3702, worker: "ubuntu-codex", attempt_id: "attempt", held_by: "engineering_binding",
  previous_revision: 8, next_revision: 8,
});
assert.deepEqual(attached, [{ taskId: "card", attemptId: "attempt", prNumber: 3702, taskRevision: 8 }]);
// The audit chain's lock comes first, and again before the attachment.
assert.equal(writes.filter(([kind]) => kind === "lock").length, 2);

// A v22 `test` Task leaves a patch too, and is held the same way.
reset({ taskRole: "test" });
assert.deepEqual(await run(), { recorded: true, taskRevision: 8, changed: false });

// Without an attachment nothing would hold the number: still refused.
reset();
assert.deepEqual(
  await recordAmuxReviewPullRequest({ taskId: "card", attemptId: "attempt", worker: "ubuntu-codex", prNumber: 3702 }),
  { recorded: false, reason: "review_not_required" },
);
assert.equal(writes.some(([kind]) => kind === "audit"), false);

// The worker and attempt checks still come before anything is held.
reset();
assert.deepEqual(await run({ worker: "someone-else" }), { recorded: false, reason: "not_the_workers_review" });
reset();
assert.deepEqual(await run({ attemptId: "older" }), { recorded: false, reason: "not_the_workers_review" });
reset({ status: "doing" });
assert.deepEqual(await run(), { recorded: false, reason: "task_not_in_review" });
assert.deepEqual(attached, []);
assert.equal(writes.some(([kind]) => kind === "audit"), false);

// Any other unmarked card still has no review to attach a number to.
for (const other of [
  { sourceSystem: null, cardType: null, taskRole: null },
  { sourceSystem: "admin-idea-v4", cardType: "story", taskRole: null },
  { sourceSystem: "admin-idea-v4", cardType: "task", taskRole: "design" },
  { sourceSystem: "board-sync", cardType: "task", taskRole: "implement" },
]) {
  reset(other);
  assert.equal(amuxV22ImplementTask(task), false, JSON.stringify(other));
  assert.deepEqual(await run(), { recorded: false, reason: "review_not_required" }, JSON.stringify(other));
  assert.equal(writes.some(([kind]) => kind === "task" || kind === "audit"), false);
  assert.deepEqual(attached, []);
}

// A card a person reviews takes the number on its own row, as before.
reset({ sourceSystem: null, cardType: null, taskRole: null, requiresHumanReview: true });
assert.deepEqual(await run(), { recorded: true, taskRevision: 9, changed: true });
assert.deepEqual(cardWrites()[0][1].data, { reviewPrNumber: 3702, revision: { increment: 1 } });
assert.equal(writes.find(([kind]) => kind === "audit")[1].metadata.held_by, undefined);
reset({ sourceSystem: null, cardType: null, taskRole: null, requiresHumanReview: true, reviewPrNumber: 3702 });
assert.deepEqual(await run(), { recorded: true, taskRevision: 8, changed: false });
assert.deepEqual(cardWrites(), []);
reset({ sourceSystem: null, cardType: null, taskRole: null, requiresHumanReview: true, reviewPrNumber: 41 });
assert.deepEqual(await run(), { recorded: false, reason: "review_pr_conflict" });
