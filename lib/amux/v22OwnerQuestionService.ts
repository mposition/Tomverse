import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { prisma } from "@/lib/prisma";
import { BoardImportError } from "./boardImportCore.ts";
import { OWNER_TRANSACTION_LIMITS, withAutoTransaction } from
  "./autoPromotionService.ts";
import { AMUX_V22_OWNER_QUESTION_RULES, AMUX_V22_RESUME_PROMPT_MAX_BYTES,
  amuxV22ResumeMinimumBytes, normalizeAmuxV22OwnerAnswer,
  parseAmuxV22OwnerQuestion, type AmuxV22OwnerAnswerSource } from
  "./v22OwnerQuestionCore.ts";
import { AMUX_V22_WORKER_AUTHORITY_NOTICE } from "./v22ExternalAuthorityCore.ts";

/** What a resumed prompt holds beside its resume section and its brief: the
 * Task and attempt lines (bounded), the notice twice and the question rules.
 * The sealed brief's ciphertext length stands in for the brief: it is never
 * shorter than the text. */
const PROMPT_FIXED_BYTES = 512 +
  2 * Buffer.byteLength(AMUX_V22_WORKER_AUTHORITY_NOTICE, "utf8") +
  Buffer.byteLength(AMUX_V22_OWNER_QUESTION_RULES, "utf8");
import { openAmuxV22TaskPatchRow, openAmuxV22TaskResultRow } from
  "./v22TaskResultStore.ts";

/** The question a Task's newest result asked, for the owner's result view. */
export async function readAmuxV22OwnerQuestionForResult(attemptId: string,
  resultText: string) {
  const row = await prisma.amuxV22TaskQuestion.findUnique({
    where: { attemptId },
    select: { id: true, sequence: true, state: true, answerSource: true,
      answeredAt: true },
  });
  const question = parseAmuxV22OwnerQuestion(resultText);
  if (!row || !question) return null;
  return { id: row.id, sequence: row.sequence, state: row.state,
    answerSource: row.answerSource,
    answeredAt: row.answeredAt?.toISOString() ?? null, ...question };
}

/**
 * Records the answer and sends the waiting Task back to todo, in one
 * transaction with its audit. Only an open question of a Task still parked by
 * that question's own run is answered: a Task recovered or moved since is
 * not resumed behind the operator's back. The claim then prefers the asking
 * worker, and its delivery carries the question and this answer.
 */
export async function answerAmuxV22OwnerQuestionInTransaction(
  tx: Prisma.TransactionClient,
  input: { questionId: string; answer: string;
    source: AmuxV22OwnerAnswerSource; answeredByUserId: string | null;
    now: Date; audit: (taskId: string) => Promise<string> },
) {
  const answer = normalizeAmuxV22OwnerAnswer(input.answer);
  if (!answer) throw new BoardImportError("answer_invalid", 400);
  const rows = await tx.$queryRaw<Array<{ id: string; taskId: string;
    attemptId: string; state: string }>>`
    SELECT "id", "taskId", "attemptId", "state" FROM "AmuxV22TaskQuestion"
    WHERE "id" = ${input.questionId} FOR UPDATE`;
  const question = rows[0];
  if (!question) throw new BoardImportError("not_found", 404);
  if (question.state !== "open")
    throw new BoardImportError("question_not_open", 409);
  const task = await tx.amuxWorkItem.findUnique({ where: { id: question.taskId },
    select: { status: true, owner: true, claimedAt: true, archivedAt: true,
      v22AssignmentId: true, revision: true, v4BriefCiphertext: true } });
  const parked = await tx.amuxExecutionAttempt.findFirst({
    where: { taskId: question.taskId },
    orderBy: [{ startedAt: "desc" }, { id: "desc" }],
    select: { id: true, toStatus: true, reason: true },
  });
  if (!task || task.status !== "blocked" || task.owner || task.claimedAt ||
      task.archivedAt || task.v22AssignmentId ||
      parked?.id !== question.attemptId || parked.toStatus !== "blocked" ||
      parked.reason !== "owner_question")
    throw new BoardImportError("task_not_waiting", 409);
  // The answer goes whole into the resumed prompt; one that cannot fit beside
  // the brief is refused now, to be shortened, never cut at delivery.
  if (PROMPT_FIXED_BYTES + (task.v4BriefCiphertext?.length ?? 0) +
      amuxV22ResumeMinimumBytes(answer, input.source) + 2 >
      AMUX_V22_RESUME_PROMPT_MAX_BYTES)
    throw new BoardImportError("answer_too_long_for_prompt", 409);
  const auditId = await input.audit(question.taskId);
  await tx.amuxV22TaskQuestion.update({ where: { id: question.id }, data: {
    state: "answered", answerText: answer, answerSource: input.source,
    answeredByUserId: input.answeredByUserId, answeredAt: input.now } });
  const changed = await tx.amuxWorkItem.updateMany({ where: {
    id: question.taskId, revision: task.revision, status: "blocked",
    owner: null, claimedAt: null, v22AssignmentId: null, archivedAt: null,
  }, data: { status: "todo", revision: { increment: 1 } } });
  if (changed.count !== 1) throw new BoardImportError("conflict", 409);
  return { questionId: question.id, taskId: question.taskId, auditId };
}

/** The owner answers a worker's question from Admin. */
export async function answerAmuxV22OwnerQuestion(input: { session: Session;
  request: Request; taskId: string; questionId: string; answer: string }) {
  const actorUserId = input.session.user?.id;
  if (!actorUserId || !isAdminSession(input.session) ||
      getAdminRole(input.session) !== "owner")
    throw new BoardImportError("forbidden", 403);
  return withAutoTransaction(input.taskId, OWNER_TRANSACTION_LIMITS,
    async (tx, now) => {
      const owned = await tx.amuxV22TaskQuestion.findUnique({
        where: { id: input.questionId }, select: { taskId: true } });
      if (owned?.taskId !== input.taskId)
        throw new BoardImportError("not_found", 404);
      return answerAmuxV22OwnerQuestionInTransaction(tx, {
        questionId: input.questionId, answer: input.answer,
        source: "operator", answeredByUserId: actorUserId, now,
        audit: (taskId) => writeAdminAuditLog({ tx, session: input.session,
          request: input.request, action: "amux.v22.owner_question.answered",
          targetType: "AmuxV22TaskQuestion", targetId: input.questionId,
          summary: "Answered an AMUX v22 worker question and resumed the Task.",
          metadata: { taskId, source: "operator" } }),
      });
    });
}

const SEALED = { ideaId: true, ciphertext: true, keyId: true, keyVersion: true,
  digest: true, digestKeyId: true, bodyPurgedAt: true } as const;

/** Prisma calls `readAmuxV22ResumeRows` makes, for its caller's boundary. */
export const AMUX_V22_RESUME_ROWS_PRISMA_CALLS = 3;

/**
 * The rows a resumed delivery carries: an answered question of this Task, or
 * the one this very attempt already resumed (a delivery pulled again after an
 * unknown answer), with its run's result and patch rows. Read inside the
 * caller's DB boundary; the bodies are opened outside it
 * (`openAmuxV22ResumeContext`), and the delivery transaction checks the
 * question again before it marks it resumed.
 */
export async function readAmuxV22ResumeRows(tx: Prisma.TransactionClient,
  taskId: string, attemptId: string) {
  const question = await tx.amuxV22TaskQuestion.findFirst({
    where: { taskId, answerText: { not: null }, OR: [
      { state: "answered" },
      { state: "resumed", resumedAttemptId: attemptId },
    ] },
    select: { id: true, attemptId: true, state: true, answerText: true,
      answerSource: true },
  });
  if (!question?.answerText || !question.answerSource) return null;
  const result = await tx.amuxV22TaskResult.findUnique({
    where: { attemptId: question.attemptId },
    select: { ...SEALED, taskId: true, sourceSha256: true } });
  const patch = await tx.amuxV22TaskPatch.findUnique({
    where: { attemptId: question.attemptId },
    select: { ...SEALED, taskId: true, patchSha256: true } });
  if (result?.taskId !== taskId || (patch && patch.taskId !== taskId))
    return null;
  return { question: { id: question.id, attemptId: question.attemptId,
    state: question.state,
    answerText: question.answerText,
    answerSource: question.answerSource as AmuxV22OwnerAnswerSource },
    result, patch };
}

/** Opens the rows outside the DB transaction. The answer is in the row; the
 * question text comes from the asking run's result and is null when that can
 * no longer be read, in which case the section carries the answer alone. */
export async function openAmuxV22ResumeContext(
  rows: NonNullable<Awaited<ReturnType<typeof readAmuxV22ResumeRows>>>) {
  const attemptId = rows.question.attemptId;
  const text = await openAmuxV22TaskResultRow(attemptId, rows.result);
  const question = text ? parseAmuxV22OwnerQuestion(text) : null;
  const previousPatch = rows.patch ?
    await openAmuxV22TaskPatchRow(attemptId, rows.patch) : null;
  return { questionId: rows.question.id, question,
    answer: rows.question.answerText,
    answerSource: rows.question.answerSource, previousPatch };
}
