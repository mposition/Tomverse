import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { recordDecisionMakerSwitchByOperator } from "@/lib/amux/decisionMakerSwitchStore";
import { applyAmuxV22ResultReviewDecision, readAmuxV22ResultReviewSyncRows,
  recordAmuxV22ResultReviewHandoff } from "@/lib/amux/v22ResultReviewService";
import { isAmuxV22QuestionCard, recordDmQuestionLocalCard,
  recordDmQuestionLocalCardClosed } from "@/lib/amux/v22OwnerQuestionDmService";
import { prisma } from "@/lib/prisma";

// Real PostgreSQL: a v22 result waiting for review, decided by the Decision
// Maker (owner decision 2026-11-07). No TEST_DATABASE_URL: not executed.

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
process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-result-review-audit-key-2026";

const digest = "a".repeat(64);
const cipher = Buffer.from("synthetic-only", "utf8");
const seededTasks: string[] = [];
const seededIdeas: string[] = [];

const operator = () => ({ user: { id: `dm-operator-${randomUUID()}`, email: "operator@example.test" },
  expires: "2099-01-01T00:00:00.000Z" }) as Session;
const setKillSwitch = (value: "on" | "off") => prisma.$transaction((tx) =>
  recordDecisionMakerSwitchByOperator(tx, { session: operator(), scope: "kill_switch", value }));

const asReplica = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
    const result = await work(tx);
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin");
    return result;
  }, { timeout: 30_000 });

/** One v4 investigate Task in review after a successful run, its person's
 * escalation open and its review row filed, triggers off for the seed. */
async function seedReview(input: { localCardId?: string } = {}) {
  const ideaId = randomUUID();
  const taskId = randomUUID();
  const attemptId = randomUUID();
  const reviewId = randomUUID();
  seededIdeas.push(ideaId);
  seededTasks.push(taskId);
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
        'investigate', 'routine',
        ${`AMUX-RR${randomUUID().replaceAll("-", "").slice(0, 8).toUpperCase()}-001`}, ${now}, ${now})`;
    await tx.$executeRaw`
      INSERT INTO "AmuxExecutionAttempt" ("id", "taskId", "worker", "workerInstanceId", "workerGeneration",
        "taskRevision", "attemptNumber", "heartbeatAt", "startedAt", "endedAt", "outcome", "toStatus",
        "endedBy", "reason", "updatedAt")
      VALUES (${attemptId}, ${taskId}, 'codex-impl', 'fixture-instance', 1, 4, 1, ${now}, ${now}, ${now},
        'succeeded', 'review', 'codex-impl', 'reported_result', ${now})`;
    await tx.$executeRaw`
      INSERT INTO "AmuxV22TaskResult" ("attemptId", "taskId", "ideaId", "ciphertext", "keyId", "keyVersion",
        "digest", "digestKeyId", "sourceSha256", "byteLength", "conclusionVerdict", "conclusionSha256")
      VALUES (${attemptId}, ${taskId}, ${ideaId}, ${cipher}, 'synthetic', 1, ${digest}, 'synthetic', ${digest},
        14, 'needs_owner', ${digest})`;
    await tx.$executeRaw`
      INSERT INTO "AmuxHumanEscalation" ("id", "taskId", "specialty", "reason", "status", "openedBy",
        "openedTaskRevision", "updatedAt")
      VALUES (${randomUUID()}, ${taskId}, 'code-review', 'human_review_required', 'open', 'codex-impl', 5, ${now})`;
    await tx.$executeRaw`
      INSERT INTO "AmuxV22ResultReview" ("id", "taskId", "attemptId", "kind", "localCardId", "updatedAt")
      VALUES (${reviewId}, ${taskId}, ${attemptId}, 'needs_owner', ${input.localCardId ?? null}, ${now})`;
  });
  return { ideaId, taskId, attemptId, reviewId };
}

const apply = (reviewId: string, decision: "approve" | "retry" | "block",
  options: { replica?: boolean } = {}) => {
  const work = (tx: Prisma.TransactionClient) => applyAmuxV22ResultReviewDecision(tx, {
    reviewId, decision, source: "dm", requestId: `req-${randomUUID().slice(0, 8)}`, now: new Date() });
  // approve and retry move a v4 Task into a status whose promotion receipt
  // guard needs a real receipt; the seed has none, so those run past it.
  return options.replica ? asReplica(work) : prisma.$transaction(work, { timeout: 30_000 });
};
const taskOf = (id: string) => prisma.amuxWorkItem.findUniqueOrThrow({ where: { id },
  select: { status: true, revision: true, v4TerminalAt: true, owner: true } });
const escalationOf = (taskId: string) => prisma.amuxHumanEscalation.findFirstOrThrow({
  where: { taskId }, orderBy: { createdAt: "desc" },
  select: { status: true, resolvedById: true, resolutionOutcome: true } });
const reviewOf = (id: string) => prisma.amuxV22ResultReview.findUniqueOrThrow({ where: { id } });
const auditOf = (taskId: string) => prisma.adminAuditLog.findFirst({
  where: { targetId: taskId, action: "amux.v22.result_review.applied" },
  select: { actorUserId: true, entryHash: true, metadata: true } });

before(async () => { await setKillSwitch("off"); });
after(async () => {
  await asReplica(async (tx) => {
    await tx.$executeRaw`DELETE FROM "AmuxV22ResultReview" WHERE "taskId" = ANY(${seededTasks})`;
    await tx.$executeRaw`DELETE FROM "AmuxV22TaskResult" WHERE "taskId" = ANY(${seededTasks})`;
    await tx.$executeRaw`DELETE FROM "AmuxHumanEscalation" WHERE "taskId" = ANY(${seededTasks})`;
    await tx.$executeRaw`DELETE FROM "AmuxExecutionAttempt" WHERE "taskId" = ANY(${seededTasks})`;
    await tx.$executeRaw`DELETE FROM "AmuxWorkItem" WHERE "id" = ANY(${seededTasks})`;
    await tx.$executeRaw`DELETE FROM "AmuxIdeaSubmission" WHERE "id" = ANY(${seededIdeas})`;
  });
  await prisma.$disconnect();
});

test("approve finishes the Task once, terminal, resolves the person's escalation as the system, and audits through the chain", async () => {
  const seed = await seedReview();
  const result = await apply(seed.reviewId, "approve", { replica: true });
  assert.deepEqual(result, { applied: true, outcome: "done" });
  const task = await taskOf(seed.taskId);
  assert.equal(task.status, "done");
  assert.equal(task.revision, 6);
  assert.ok(task.v4TerminalAt, "dependents wait on this timestamp");
  assert.deepEqual(await escalationOf(seed.taskId),
    { status: "resolved", resolvedById: "system:amux-v22-result-review", resolutionOutcome: "approve" });
  const review = await reviewOf(seed.reviewId);
  assert.equal(review.state, "applied");
  assert.equal(review.decision, "approve");
  assert.equal(review.answerSource, "dm");
  const audit = await auditOf(seed.taskId);
  assert.ok(audit?.entryHash, "the hash-chained audit row");
  assert.equal(audit?.actorUserId, null, "a system actor, not a person");
  assert.equal((audit?.metadata as Record<string, unknown>).toStatus, "done");
  assert.deepEqual(await apply(seed.reviewId, "approve", { replica: true }), { applied: false, outcome: null },
    "a second answer finds the review applied");
});

test("retry sends the Task back to todo for a new run", async () => {
  const seed = await seedReview();
  assert.deepEqual(await apply(seed.reviewId, "retry", { replica: true }), { applied: true, outcome: "todo" });
  const task = await taskOf(seed.taskId);
  assert.equal(task.status, "todo");
  assert.equal(task.owner, null);
  assert.equal(task.v4TerminalAt, null);
});

test("block parks the Task with the person's escalation still open, under every guard", async () => {
  const seed = await seedReview();
  assert.deepEqual(await apply(seed.reviewId, "block"), { applied: true, outcome: "blocked" });
  assert.equal((await taskOf(seed.taskId)).status, "blocked");
  assert.equal((await escalationOf(seed.taskId)).status, "open", "it waits for a person");
});

test("a Task a person already moved cancels the review, and the sync cancels it too", async () => {
  const seed = await seedReview();
  await asReplica((tx) => tx.$executeRaw`UPDATE "AmuxWorkItem" SET "status" = 'done' WHERE "id" = ${seed.taskId}`);
  assert.deepEqual(await apply(seed.reviewId, "approve"), { applied: true, outcome: "cancelled" });
  const review = await reviewOf(seed.reviewId);
  assert.equal(review.state, "cancelled");
  assert.equal(review.cancelReason, "task_moved");

  const other = await seedReview();
  await asReplica((tx) => tx.$executeRaw`UPDATE "AmuxWorkItem" SET "status" = 'todo' WHERE "id" = ${other.taskId}`);
  const rows = await prisma.$transaction((tx) => readAmuxV22ResultReviewSyncRows(tx));
  assert.ok(!rows.pending.some((row) => row.reviewId === other.reviewId));
  assert.equal((await reviewOf(other.reviewId)).state, "cancelled");
});

test("under the kill switch nothing is applied", async () => {
  const seed = await seedReview();
  await setKillSwitch("on");
  try {
    assert.deepEqual(await apply(seed.reviewId, "block"), { applied: false, outcome: null });
    assert.equal((await taskOf(seed.taskId)).status, "review");
  } finally { await setKillSwitch("off"); }
});

test("an unreadable answer hands the review to a person once, and the card dispatch finds the review", async () => {
  const card = `RR-${randomUUID().slice(0, 8)}`;
  const seed = await seedReview();
  const handoff = () => prisma.$transaction((tx) => recordAmuxV22ResultReviewHandoff(tx, {
    reviewId: seed.reviewId, requestId: "req-1", reason: "answer_unreadable", now: new Date() }));
  assert.deepEqual(await handoff(), { recorded: true });
  assert.deepEqual(await handoff(), { recorded: false });
  assert.equal((await reviewOf(seed.reviewId)).handoffReason, "answer_unreadable");

  const filed = await seedReview();
  assert.deepEqual(await prisma.$transaction((tx) => recordDmQuestionLocalCard(tx,
    { questionId: filed.reviewId, cardId: card })), { recorded: true });
  assert.equal(await isAmuxV22QuestionCard(prisma, card), true, "its confirmed answer never reaches a session");
  await apply(filed.reviewId, "block");
  assert.deepEqual(await prisma.$transaction((tx) => recordDmQuestionLocalCardClosed(tx,
    { questionId: filed.reviewId, cardId: card, now: new Date() })), { recorded: true });
});

test("a result whose body is gone is never approved on the DM's word: the review goes to the person", async () => {
  const seed = await seedReview();
  await asReplica((tx) => tx.$executeRaw`
    UPDATE "AmuxV22TaskResult" SET "bodyPurgedAt" = now(), "ciphertext" = NULL, "keyId" = NULL,
      "keyVersion" = NULL WHERE "attemptId" = ${seed.attemptId}`);
  assert.deepEqual(await apply(seed.reviewId, "approve", { replica: true }),
    { applied: false, outcome: "handed_off" });
  assert.equal((await taskOf(seed.taskId)).status, "review");
  assert.equal((await escalationOf(seed.taskId)).status, "open");
  const review = await reviewOf(seed.reviewId);
  assert.equal(review.state, "open");
  assert.equal(review.handoffReason, "result_unreadable");
  const rows = await prisma.$transaction((tx) => readAmuxV22ResultReviewSyncRows(tx));
  assert.ok(!rows.pending.some((row) => row.reviewId === seed.reviewId), "no card for a handed-off review");
});

test("a conclusion verdict never stands without its digest (the CHECK itself, past the row guards)", async () => {
  const seed = await seedReview();
  const refused = await asReplica((tx) => tx.$executeRaw`
    UPDATE "AmuxV22TaskResult" SET "conclusionSha256" = NULL WHERE "attemptId" = ${seed.attemptId}`)
    .then(() => false, (error: Error) => /AmuxV22TaskResult_conclusion_check/.test(error.message));
  assert.equal(refused, true);
});

test("the tables accept the dm source and refuse what the lifecycle does not allow", async () => {
  const seed = await seedReview();
  const refused = async (promise: Promise<unknown>) => {
    try { await promise; } catch { return true; }
    return false;
  };
  assert.equal(await refused(prisma.$executeRaw`
    UPDATE "AmuxV22ResultReview" SET "state" = 'applied' WHERE "id" = ${seed.reviewId}`), true,
    "applied needs its decision, source and time");
  assert.equal(await refused(prisma.$executeRaw`
    UPDATE "AmuxV22ResultReview" SET "kind" = 'anything' WHERE "id" = ${seed.reviewId}`), true);
  assert.equal(await refused(prisma.$executeRaw`
    UPDATE "AmuxV22TaskResult" SET "conclusionVerdict" = 'approve' WHERE "attemptId" = ${seed.attemptId}`), true);
  assert.equal(await refused(prisma.$executeRaw`
    UPDATE "AmuxV22TaskResult" SET "conclusionSha256" = NULL WHERE "attemptId" = ${seed.attemptId}`), true,
    "a verdict never stands without its digest");
});
