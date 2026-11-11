import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { Prisma } from "@prisma/client";

import { completeAmuxV22ReviewOnObservedMerge } from "@/lib/amux/reviewMergeObserved";
import { recordAmuxReviewPullRequest } from "@/lib/amux/reviewPullRequest";
import { prisma } from "@/lib/prisma";

// Real PostgreSQL: a v22 implement Task in review, the pull request the
// engineering publisher opened for it, and that pull request's merge. The v4
// row cannot hold a review pull request number (plaintext exclusion keeps
// reviewSpecialty null, the human review shape then keeps requiresHumanReview
// false, and the review PR check needs it true), so the engineering binding
// holds it. Before 2026-11-11 the record was refused `review_not_required`,
// which opened a state mismatch that halted the whole agent for every pull
// request the publisher opened. No TEST_DATABASE_URL: not executed.

const requireDedicatedAmuxTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw)
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  const url = new URL(testRaw);
  const schemaName = url.searchParams.get("schema");
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (schemaName !== "tomverse_amux_test" && !(databaseName === "tomverse_test" &&
      (schemaName === null || schemaName === "public") &&
      (url.hostname === "127.0.0.1" || url.hostname === "localhost")))
    throw new Error("REFUSE: AMUX DB tests require the dedicated AMUX schema or the local canonical test database");
};
requireDedicatedAmuxTestDatabase();
process.env.ADMIN_AUDIT_INTEGRITY_KEY ??= "synthetic-amux-review-pr-binding-audit-key-2026";

const digest = "a".repeat(64);
const cipher = Buffer.from("synthetic-only", "utf8");
const seededTasks: string[] = [];
const seededIdeas: string[] = [];
const seededRuns: string[] = [];
let runCounter = 800_000_000 + (Math.floor(Date.now() / 1000) % 100_000_000);

const asReplica = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    const result = await work(tx);
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin");
    return result;
  }, { timeout: 30_000 });

/** A v22 implement Task in review after its worker's successful attempt, with
 * the person's escalation open and the engineering run and binding of the pull
 * request the publisher opened for that attempt; triggers off for the seed. */
async function seedPublishedTask(prNumber: number) {
  const ideaId = randomUUID();
  const taskId = randomUUID();
  const attemptId = randomUUID();
  const runId = String((runCounter += 1));
  const bindingId = randomUUID();
  seededIdeas.push(ideaId);
  seededTasks.push(taskId);
  seededRuns.push(runId);
  const now = new Date();
  const completed = new Date(now.getTime() + 1_000);
  await asReplica(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "AmuxIdeaSubmission" ("id", "requestId", "actorUserId", "state", "submittedAt",
        "analysisDeadlineAt", "analysisCompletedAt", "rawPurgeAfter", "updatedAt")
      VALUES (${ideaId}, ${randomUUID()}::uuid, 'owner-fixture', 'completed', ${now},
        ${new Date(now.getTime() + 7 * 86_400_000)}, ${completed}, ${completed}, ${completed})`;
    await tx.$executeRaw`
      INSERT INTO "AmuxWorkItem" ("id", "title", "status", "revision", "sourceSystem", "sourceKey",
        "sourceVersion", "sourceDigest", "sourceSnapshot", "cardType", "parentFeatureNodeId",
        "v4TitleCiphertext", "v4TitleKeyId", "v4TitleKeyVersion", "v4TitleDigest", "v4TitleDigestKeyId",
        "v4BodyCiphertext", "v4BodyKeyId", "v4BodyKeyVersion", "v4BodyDigest", "v4BodyDigestKeyId",
        "v4BriefCiphertext", "v4BriefKeyId", "v4BriefKeyVersion", "v4BriefDigest", "v4BriefDigestKeyId",
        "v4SourceApprovalId", "v22ReceiptId", "taskRole", "executionGrade", "displayKey", "createdAt", "updatedAt")
      VALUES (${taskId}, 'AMUX Task', 'review', 5, 'admin-idea-v4', ${taskId.toUpperCase()}, '1', ${digest},
        ${JSON.stringify({ schemaVersion: "amux-v4", ideaId, approvalId: randomUUID() })}::jsonb, 'task',
        ${randomUUID()}, ${cipher}, 'synthetic', 1, ${digest}, 'synthetic', ${cipher}, 'synthetic', 1, ${digest},
        'synthetic', ${cipher}, 'synthetic', 1, ${digest}, 'synthetic', ${randomUUID()}, ${randomUUID()}::uuid,
        'implement', 'routine',
        ${`AMUX-RP${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}-001`}, ${now}, ${now})`;
    await tx.$executeRaw`
      INSERT INTO "AmuxExecutionAttempt" ("id", "taskId", "worker", "workerInstanceId", "workerGeneration",
        "taskRevision", "attemptNumber", "heartbeatAt", "startedAt", "endedAt", "outcome", "toStatus",
        "endedBy", "reason", "v22AssignmentId", "updatedAt")
      VALUES (${attemptId}, ${taskId}, 'codex-impl', 'fixture-instance', 1, 4, 1, ${now}, ${now}, ${now},
        'succeeded', 'review', 'codex-impl', 'reported_result', ${randomUUID()}::uuid, ${now})`;
    await tx.$executeRaw`
      INSERT INTO "AmuxHumanEscalation" ("id", "taskId", "specialty", "reason", "status", "openedBy",
        "openedTaskRevision", "updatedAt")
      VALUES (${randomUUID()}, ${taskId}, 'code-review', 'human_review_required', 'open', 'codex-impl', 5, ${now})`;
    await tx.$executeRaw`
      INSERT INTO "EngineeringAgentRun" ("id", "amuxAttemptId", "cardId", "cardKind", "baseSha", "status",
        "outcome", "halt", "modeAtStart", "startedAt", "endedAt", "leaseExpiresAt")
      VALUES (${runId}, ${attemptId}, ${taskId}, 'task', ${"b".repeat(40)}, 'finished', 't2_draft', 'none', 't1',
        ${now}, ${now}, ${now})`;
    await tx.$executeRaw`
      INSERT INTO "EngineeringAgentBinding" ("id", "runId", "prNumber", "headSha", "verifiedHeadSha", "ref",
        "snapshot", "currentPrNumber", "updatedAt")
      VALUES (${bindingId}, ${runId}, ${prNumber}, ${"c".repeat(40)}, ${"c".repeat(40)},
        ${`agent/engineering/${runId}`},
        ${JSON.stringify({ baseSha: "b".repeat(40), diffDigest: digest, treeId: "d".repeat(40), invalidatedReviewIds: [] })}::jsonb,
        ${prNumber}, ${now})`;
  });
  return { taskId, attemptId, runId, bindingId };
}

const taskOf = (id: string) => prisma.amuxWorkItem.findUniqueOrThrow({ where: { id },
  select: { status: true, revision: true, reviewPrNumber: true, requiresHumanReview: true, reviewSpecialty: true,
    v4TerminalAt: true } });

after(async () => {
  await asReplica(async (tx) => {
    await tx.$executeRaw`DELETE FROM "EngineeringAgentBinding" WHERE "runId" = ANY(${seededRuns})`;
    await tx.$executeRaw`DELETE FROM "EngineeringAgentRun" WHERE "id" = ANY(${seededRuns})`;
    await tx.$executeRaw`DELETE FROM "AmuxHumanEscalation" WHERE "taskId" = ANY(${seededTasks})`;
    await tx.$executeRaw`DELETE FROM "AmuxExecutionAttempt" WHERE "taskId" = ANY(${seededTasks})`;
    await tx.$executeRaw`DELETE FROM "AmuxWorkItem" WHERE "id" = ANY(${seededTasks})`;
    await tx.$executeRaw`DELETE FROM "AmuxIdeaSubmission" WHERE "id" = ANY(${seededIdeas})`;
  });
  await prisma.$disconnect();
});

test("a v22 implement Task's pull request is recorded on its binding, and that pull request's merge completes it", async () => {
  const prNumber = 900_000 + Math.floor(Math.random() * 90_000);
  const seed = await seedPublishedTask(prNumber);
  const before = await taskOf(seed.taskId);

  // The row itself refuses the number: this is why the binding holds it.
  await assert.rejects(
    prisma.amuxWorkItem.update({ where: { id: seed.taskId }, data: { reviewPrNumber: prNumber } }),
    /AmuxWorkItem_review_pr_check/,
  );
  await assert.rejects(
    prisma.amuxWorkItem.update({
      where: { id: seed.taskId },
      data: { reviewPrNumber: prNumber, requiresHumanReview: true, reviewSpecialty: "code-review" },
    }),
    /AmuxWorkItem_v4_plaintext_exclusion_check/,
  );

  // With no attachment nothing would hold the number.
  assert.deepEqual(
    await recordAmuxReviewPullRequest({ taskId: seed.taskId, attemptId: seed.attemptId, worker: "codex-impl", prNumber }),
    { recorded: false, reason: "review_not_required" },
  );
  // Another worker's review is still refused.
  const facts: unknown[] = [];
  const attachment = { prismaCalls: 1, work: async (tx: { $queryRaw: typeof prisma.$queryRaw }, fact: unknown) => {
    await tx.$queryRaw`SELECT 1`;
    facts.push(fact);
  } };
  assert.deepEqual(
    await recordAmuxReviewPullRequest(
      { taskId: seed.taskId, attemptId: seed.attemptId, worker: "someone-else", prNumber }, attachment),
    { recorded: false, reason: "not_the_workers_review" },
  );
  assert.deepEqual(facts, []);

  // The publisher's own record is taken: the card row is unchanged, the
  // attachment runs in the same transaction, and the audit chain says so.
  assert.deepEqual(
    await recordAmuxReviewPullRequest(
      { taskId: seed.taskId, attemptId: seed.attemptId, worker: "codex-impl", prNumber }, attachment),
    { recorded: true, taskRevision: before.revision, changed: false },
  );
  assert.deepEqual(facts, [{ taskId: seed.taskId, attemptId: seed.attemptId, prNumber, taskRevision: before.revision }]);
  assert.deepEqual(await taskOf(seed.taskId), before);
  const recorded = await prisma.adminAuditLog.findFirstOrThrow({
    where: { targetId: seed.taskId, action: "amux.review.pull_request_recorded" },
    select: { entryHash: true, metadata: true },
  });
  assert.ok(recorded.entryHash);
  assert.equal((recorded.metadata as Record<string, unknown>).held_by, "engineering_binding");
  assert.equal((recorded.metadata as Record<string, unknown>).pr_number, prNumber);

  // A merge of some other pull request completes nothing.
  const merge = (number: number, bindingId: string | null = seed.bindingId) => completeAmuxV22ReviewOnObservedMerge({
    taskId: seed.taskId, attemptId: seed.attemptId, prNumber: number, mergeCommitSha: "e".repeat(40),
    approvalReviewId: 7, bindingId,
  });
  assert.deepEqual(await merge(prNumber + 1), { completed: false, reason: "review_pr_mismatch" });
  // The observed binding must be named: a caller that names none completes nothing.
  assert.deepEqual(await merge(prNumber, null), { completed: false, reason: "review_pr_mismatch" });
  assert.equal((await taskOf(seed.taskId)).status, "review");

  // The merge of the bound pull request completes the card, terminal, and
  // closes the person's escalation. The seed builds no promotion receipt or
  // idea registration, so the two triggers that re-check that provenance on
  // every v4 Task write are off for this one call; nothing here changes them.
  const provenanceGuards = ["amux_v22_card_receipt_guard_trigger", "amux_v4_registered_card_complete"];
  for (const guard of provenanceGuards) await prisma.$executeRawUnsafe(`ALTER TABLE "AmuxWorkItem" DISABLE TRIGGER "${guard}"`);
  try {
    assert.deepEqual(await merge(prNumber), { completed: true, taskRevision: before.revision + 1 });
  } finally {
    for (const guard of provenanceGuards) await prisma.$executeRawUnsafe(`ALTER TABLE "AmuxWorkItem" ENABLE TRIGGER "${guard}"`);
  }
  const done = await taskOf(seed.taskId);
  assert.equal(done.status, "done");
  assert.equal(done.reviewPrNumber, null);
  assert.ok(done.v4TerminalAt);
  const completedAudit = await prisma.adminAuditLog.findFirstOrThrow({
    where: { targetId: seed.taskId, action: "amux.v22.review.merge_observed" }, select: { metadata: true } });
  assert.equal((completedAudit.metadata as Record<string, unknown>).binding_id, seed.bindingId);
  const escalation = await prisma.amuxHumanEscalation.findFirstOrThrow({ where: { taskId: seed.taskId } });
  assert.equal(escalation.status, "resolved");
  assert.equal(escalation.resolutionOutcome, "approve");
});

test("a superseded binding, or one for another card's attempt, does not complete the card", async () => {
  const prNumber = 900_000 + Math.floor(Math.random() * 90_000);
  const seed = await seedPublishedTask(prNumber);
  // A re-bind under a new snapshot supersedes the binding whose approval was
  // observed (engineering-agent.md §9-10): naming the old one completes nothing.
  await asReplica((tx) => tx.$executeRaw`
    UPDATE "EngineeringAgentBinding" SET "supersededAt" = NOW(), "currentPrNumber" = NULL WHERE "id" = ${seed.bindingId}`);
  assert.deepEqual(
    await completeAmuxV22ReviewOnObservedMerge({
      taskId: seed.taskId, attemptId: seed.attemptId, prNumber, mergeCommitSha: "e".repeat(40), approvalReviewId: 7,
      bindingId: seed.bindingId,
    }),
    { completed: false, reason: "review_pr_mismatch" },
  );

  const other = await seedPublishedTask(prNumber + 1);
  // Another card's current binding, for its own attempt, does not complete this card.
  assert.deepEqual(
    await completeAmuxV22ReviewOnObservedMerge({
      taskId: seed.taskId, attemptId: seed.attemptId, prNumber: prNumber + 1, mergeCommitSha: "e".repeat(40),
      approvalReviewId: 7, bindingId: other.bindingId,
    }),
    { completed: false, reason: "review_pr_mismatch" },
  );
  assert.equal((await taskOf(seed.taskId)).status, "review");
  assert.equal((await taskOf(other.taskId)).status, "review");
});
