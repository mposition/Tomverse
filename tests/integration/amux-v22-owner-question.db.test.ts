import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { answerAmuxV22OwnerQuestionInTransaction, readAmuxV22ResumeRows } from
  "@/lib/amux/v22OwnerQuestionService";
import { prisma } from "@/lib/prisma";

// Real PostgreSQL: the question table's guard and the answer that resumes a
// Task parked by a v22 worker's owner question (operator decision
// 2026-10-30). No TEST_DATABASE_URL means this suite was not executed.

const requireDedicatedDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw)
    throw new Error("REFUSE: requires DATABASE_URL=TEST_DATABASE_URL");
  const url = new URL(testRaw);
  const name = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!["127.0.0.1", "localhost"].includes(url.hostname) ||
      !/(?:^|[_-])test(?:[_-]|$)/i.test(name))
    throw new Error("REFUSE: requires a loopback test database");
};
requireDedicatedDatabase();

const digest = "a".repeat(64);

async function parkedTask(reason = "owner_question") {
  const task = await prisma.amuxWorkItem.create({ data: {
    id: `amux-owner-question-${randomUUID()}`, title: "Owner question fixture",
    status: "blocked", kind: "code", priority: "p2", revision: 4 } });
  const now = new Date();
  const attempt = await prisma.amuxExecutionAttempt.create({ data: {
    id: randomUUID(), taskId: task.id, worker: "codex-impl",
    workerInstanceId: "fixture-instance", workerGeneration: 1,
    taskRevision: 3, attemptNumber: 1, heartbeatAt: now, startedAt: now,
    endedAt: now, outcome: "succeeded", toStatus: "blocked",
    endedBy: "codex-impl", reason } });
  const question = await prisma.amuxV22TaskQuestion.create({ data: {
    id: randomUUID(), taskId: task.id, attemptId: attempt.id,
    worker: "codex-impl", sequence: 1, questionSha256: digest } });
  return { task, attempt, question };
}

const answer = (questionId: string, text = "Keep it generic.") =>
  prisma.$transaction((tx) => answerAmuxV22OwnerQuestionInTransaction(tx, {
    questionId, answer: text, source: "operator",
    answeredByUserId: "owner-fixture", now: new Date(),
    audit: async () => "audit-fixture" }));

const refusal = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) {
    return (error as { code?: string }).code ?? (error as Error).message;
  }
  return null;
};
/** A database refusal, by its message (Prisma codes it P2039 or P2002). */
const dbRefusal = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return (error as Error).message; }
  return null;
};

test("an answer resumes the parked Task once and keeps the question's identity", async () => {
  const { task, question } = await parkedTask();
  const result = await answer(question.id, "  Keep it generic.  ");
  assert.equal(result.taskId, task.id);
  const after = await prisma.amuxWorkItem.findUniqueOrThrow({ where: { id: task.id } });
  assert.equal(after.status, "todo");
  assert.equal(after.revision, task.revision + 1);
  const answered = await prisma.amuxV22TaskQuestion.findUniqueOrThrow({
    where: { id: question.id } });
  assert.equal(answered.state, "answered");
  assert.equal(answered.answerText, "Keep it generic.");
  assert.equal(answered.answerSource, "operator");
  assert.equal(answered.answeredByUserId, "owner-fixture");
  assert.equal(await refusal(answer(question.id)), "question_not_open");
  assert.equal(await refusal(answer(question.id, " ")), "answer_invalid");
});

test("a Task that moved on, or was parked for another reason, is not resumed", async () => {
  const moved = await parkedTask();
  await prisma.amuxWorkItem.update({ where: { id: moved.task.id },
    data: { status: "todo" } });
  assert.equal(await refusal(answer(moved.question.id)), "task_not_waiting");

  const other = await parkedTask("execution_blocked");
  assert.equal(await refusal(answer(other.question.id)), "task_not_waiting");

  const later = await parkedTask();
  const now = new Date(Date.now() + 1_000);
  await prisma.amuxExecutionAttempt.create({ data: {
    id: randomUUID(), taskId: later.task.id, worker: "codex-impl",
    workerInstanceId: "fixture-instance", workerGeneration: 1,
    taskRevision: 4, attemptNumber: 2, heartbeatAt: now, startedAt: now,
    endedAt: now, outcome: "failed", toStatus: "blocked",
    endedBy: "codex-impl", reason: "owner_question" } });
  assert.equal(await refusal(answer(later.question.id)), "task_not_waiting");
  assert.equal(await refusal(answer(randomUUID())), "not_found");
});

test("the resume rows are those of an answered question or of this attempt's resume", async () => {
  const { task, question } = await parkedTask();
  assert.equal(await prisma.$transaction((tx) =>
    readAmuxV22ResumeRows(tx, task.id, "next-attempt")), null,
    "an open question carries nothing");
  await answer(question.id);
  // No retained result for the asking attempt: nothing to resume with.
  assert.equal(await prisma.$transaction((tx) =>
    readAmuxV22ResumeRows(tx, task.id, "next-attempt")), null);
});

test("the table refuses what the lifecycle does not allow", async () => {
  const { task, attempt, question } = await parkedTask();
  const update = (data: Record<string, unknown>) => dbRefusal(
    prisma.amuxV22TaskQuestion.update({ where: { id: question.id }, data }));
  assert.match(String(await update({ state: "resumed",
    resumedAttemptId: "x", answerSource: "operator", answeredAt: new Date() })),
    /cannot move from open to resumed/);
  assert.match(String(await update({ sequence: 2 })), /identity is immutable/);
  assert.match(String(await update({ state: "answered" })), /state_check/);
  assert.match(String(await dbRefusal(prisma.amuxV22TaskQuestion.delete({
    where: { id: question.id } }))), /never deleted/);
  await answer(question.id);
  // A second live question for the same Task, while the first waits.
  const now = new Date();
  const second = await prisma.amuxExecutionAttempt.create({ data: {
    id: randomUUID(), taskId: task.id, worker: "codex-impl",
    workerInstanceId: "fixture-instance", workerGeneration: 1,
    taskRevision: 4, attemptNumber: 2, heartbeatAt: now, startedAt: now,
    endedAt: now, outcome: "succeeded", toStatus: "blocked",
    endedBy: "codex-impl", reason: "owner_question" } });
  assert.match(String(await dbRefusal(prisma.amuxV22TaskQuestion.create({ data: {
    id: randomUUID(), taskId: task.id, attemptId: second.id,
    worker: "codex-impl", sequence: 2, questionSha256: digest } }))),
    /one_live_per_task|Unique constraint/);

  assert.match(String(await update({ state: "open", answerText: null,
    answerSource: null, answeredByUserId: null, answeredAt: null })),
    /cannot move from answered to open/);
  assert.match(String(await update({ state: "resumed", resumedAttemptId: second.id,
    answerText: "rewritten" })), /cannot move from answered to resumed/);
  await prisma.amuxV22TaskQuestion.update({ where: { id: question.id },
    data: { state: "resumed", resumedAttemptId: second.id } });
  assert.match(String(await update({ answerText: "changed" })),
    /cannot change its resumed answer/);
  await prisma.amuxV22TaskQuestion.update({ where: { id: question.id },
    data: { answerText: null } });
  const cleared = await prisma.amuxV22TaskQuestion.findUniqueOrThrow({
    where: { id: question.id } });
  assert.equal(cleared.answerText, null);
  assert.equal(cleared.resumedAttemptId, second.id);
  assert.equal(cleared.attemptId, attempt.id);
});
