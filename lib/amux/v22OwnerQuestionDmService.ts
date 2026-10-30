import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { readDecisionMakerBodies, readDecisionMakerResultDetail } from
  "@/lib/amux/decisionMakerBodyStore";
import { dmDeliveryCandidate, type DmDeliveryBodies,
  type DmDeliveryCursor } from "@/lib/amux/decisionMakerDeliveryCore";
import { readNextDecisionMakerDeliveryJudgment } from
  "@/lib/amux/decisionMakerJudgmentStore";
import { readDecisionMakerRequestState } from
  "@/lib/amux/decisionMakerRequestStore";
import { readDecisionMakerSwitchesOrThrow } from
  "@/lib/amux/decisionMakerSwitchStore";
import { openAmuxHumanEscalation } from "@/lib/amux/escalation";
import { BoardImportError } from "./boardImportCore.ts";
import { parseAmuxV22OwnerQuestion } from "./v22OwnerQuestionCore.ts";
import { answerAmuxV22OwnerQuestionInTransaction } from
  "./v22OwnerQuestionService.ts";
import { openAmuxV22TaskResultRow, type AmuxV22SealedRow } from
  "./v22TaskResultStore.ts";

/**
 * A v22 worker's owner question through the Decision Maker (operator decision
 * 2026-10-30). The bridge's relay mirrors each open question as a typed-ask
 * card on the AMUX host's local board, so the existing relay routes it to a
 * DM like any worker's ask; the operator confirms the proposal in Admin. The
 * confirmed answer is not typed into a terminal: a v22 worker has none.
 * Instead it answers the question here, which sends the Task back to the
 * same worker with the question and the answer, and the delivery walk steps
 * past it (decisionMakerDeliveryRead.ts). When the question has left "open"
 * the relay closes its local card. The Decision Maker's tables are read only
 * through their own stores.
 */

const CARD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const QUESTION_ID = /^[0-9a-f-]{36}$/;

/** At most this many questions or cards per relay tick. */
export const AMUX_V22_QUESTION_SYNC_LIMIT = 3;

/** Whether a Decision Maker request's card mirrors a v22 worker question.
 * One statement. */
export async function isAmuxV22QuestionCard(
  client: Pick<Prisma.TransactionClient, "$queryRaw">, cardId: string) {
  const rows = await client.$queryRaw<Array<{ found: number }>>`
    SELECT 1 AS "found" FROM "AmuxV22TaskQuestion"
    WHERE "localCardId" = ${cardId} LIMIT 1`;
  return rows.length > 0;
}

type PendingRow = AmuxV22SealedRow & { questionId: string; taskId: string;
  attemptId: string; worker: string; sequence: number; sourceSha256: string };

/** Open questions with no local card yet, with their run's result rows, and
 * cards of questions no longer open that the relay has not closed. */
export async function readAmuxV22QuestionSyncRows(tx: Prisma.TransactionClient) {
  const pending = await tx.$queryRaw<PendingRow[]>`
    SELECT q."id" AS "questionId", q."taskId", q."attemptId", q."worker",
      q."sequence", r."ideaId", r."ciphertext", r."keyId", r."keyVersion",
      r."digest", r."digestKeyId", r."sourceSha256", r."bodyPurgedAt"
    FROM "AmuxV22TaskQuestion" q
    JOIN "AmuxV22TaskResult" r
      ON r."attemptId" = q."attemptId" AND r."taskId" = q."taskId"
    WHERE q."state" = 'open' AND q."localCardId" IS NULL
    ORDER BY q."createdAt", q."id"
    LIMIT ${AMUX_V22_QUESTION_SYNC_LIMIT}`;
  const closing = await tx.$queryRaw<Array<{ questionId: string; cardId: string }>>`
    SELECT q."id" AS "questionId", q."localCardId" AS "cardId"
    FROM "AmuxV22TaskQuestion" q
    WHERE q."state" <> 'open' AND q."localCardId" IS NOT NULL
      AND q."localCardClosedAt" IS NULL
    ORDER BY q."updatedAt", q."id"
    LIMIT ${AMUX_V22_QUESTION_SYNC_LIMIT}`;
  return { pending, closing };
}

/** The card the relay files for each pending question, opened outside the
 * DB transaction. A question whose text cannot be read is left out. */
export async function openAmuxV22QuestionCards(pending: PendingRow[]) {
  const cards = [];
  for (const row of pending) {
    const text = await openAmuxV22TaskResultRow(row.attemptId, row);
    const question = text ? parseAmuxV22OwnerQuestion(text) : null;
    if (!question) continue;
    cards.push({ question_id: row.questionId, worker: row.worker,
      title: `v22 Task ${row.taskId} question ${row.sequence}`,
      question: question.question, unblocks: question.unblocks,
      options: question.options });
  }
  return cards;
}

/** Names the local card of a question, once; the same card again is a read. */
export async function recordAmuxV22QuestionLocalCard(
  tx: Prisma.TransactionClient, input: { questionId: string; cardId: string }) {
  if (!QUESTION_ID.test(input.questionId) || !CARD_ID.test(input.cardId))
    throw new BoardImportError("invalid_input", 400);
  const changed = await tx.amuxV22TaskQuestion.updateMany({ where: {
    id: input.questionId, localCardId: null }, data: { localCardId: input.cardId } });
  if (changed.count === 1) return { recorded: true as const };
  const row = await tx.amuxV22TaskQuestion.findUnique({
    where: { id: input.questionId }, select: { localCardId: true } });
  if (!row) throw new BoardImportError("not_found", 404);
  if (row.localCardId !== input.cardId)
    throw new BoardImportError("card_conflict", 409);
  return { recorded: true as const };
}

/** Records that the relay closed a question's local card, once. */
export async function recordAmuxV22QuestionLocalCardClosed(
  tx: Prisma.TransactionClient,
  input: { questionId: string; cardId: string; now: Date }) {
  if (!QUESTION_ID.test(input.questionId) || !CARD_ID.test(input.cardId))
    throw new BoardImportError("invalid_input", 400);
  const changed = await tx.amuxV22TaskQuestion.updateMany({ where: {
    id: input.questionId, localCardId: input.cardId, state: { not: "open" },
    localCardClosedAt: null }, data: { localCardClosedAt: input.now } });
  if (changed.count === 1) return { recorded: true as const };
  const row = await tx.amuxV22TaskQuestion.findUnique({
    where: { id: input.questionId },
    select: { localCardId: true, localCardClosedAt: true } });
  if (row?.localCardId !== input.cardId || !row.localCardClosedAt)
    throw new BoardImportError("not_closable", 409);
  return { recorded: true as const };
}

/** Where the relay's walk over confirmations goes next. */
export type AmuxV22ResolveCursor =
  | { move: "keep" } | { move: "reset" }
  | { move: "advance"; judgedAtMs: number; requestId: string };

/**
 * One step of a walk over the confirmed Decision Maker proposals, the walk
 * the delivery read takes (`readNextDecisionMakerDeliveryJudgment`), from
 * the relay's cursor. A confirmation whose card mirrors an open v22 question
 * answers it with the text a worker would have been sent, which sends the
 * Task back to the same worker. A question that cannot take that answer (the
 * Task moved on, or the text is not an answer) is cancelled instead, and a
 * Task still parked by it goes to a person. Any other confirmation is stepped
 * past. Under the kill switch, or when the switches cannot be read, nothing
 * is read or applied and the walk keeps its place (§6: no confirmed answer
 * is read or delivered while it is on).
 */
export async function resolveAmuxV22QuestionFromDmJudgment(
  tx: Prisma.TransactionClient, now: Date, after: DmDeliveryCursor | null):
  Promise<{ resolved: null | "answered" | "cancelled"; questionId?: string;
    cursor: AmuxV22ResolveCursor }> {
  let killSwitch: boolean | null;
  try { killSwitch = (await readDecisionMakerSwitchesOrThrow(tx)).killSwitch; }
  catch { killSwitch = null; }
  if (killSwitch !== false) return { resolved: null, cursor: { move: "keep" } };
  const judgment = await readNextDecisionMakerDeliveryJudgment(tx, { after });
  if (!judgment) return { resolved: null, cursor: { move: "reset" } };
  const cursor: AmuxV22ResolveCursor = { move: "advance",
    judgedAtMs: judgment.judgedAtMs, requestId: judgment.requestId };
  const state = await readDecisionMakerRequestState(tx, judgment.requestId);
  const question = state ? await tx.amuxV22TaskQuestion.findFirst({
    where: { localCardId: state.binding.cardId, state: "open" },
    select: { id: true, taskId: true } }) : null;
  if (!question) return { resolved: null, cursor };
  const row = { questionId: question.id, taskId: question.taskId,
    requestId: judgment.requestId };
  const detail = await readDecisionMakerResultDetail(tx, row.requestId);
  const bodies: DmDeliveryBodies = {};
  for (const body of await readDecisionMakerBodies(tx, row.requestId))
    if (body.field === "dm_answer" || body.field === "operator_answer")
      bodies[body.field] = body.text;
  const candidate = dmDeliveryCandidate({ judgment, state, detail, bodies });
  try {
    if (candidate?.status !== "ready")
      throw new BoardImportError("answer_unavailable", 409);
    await answerAmuxV22OwnerQuestionInTransaction(tx, {
      questionId: row.questionId, answer: candidate.message,
      // The person's judgment audit names who confirmed it.
      source: "dm_confirmed", answeredByUserId: null, now,
      audit: (taskId) => writeSystemAuditLog({ tx,
        systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
        action: "amux.v22.owner_question.answered",
        targetType: "AmuxV22TaskQuestion", targetId: row.questionId,
        summary: "Answered an AMUX v22 worker question with a confirmed Decision Maker proposal.",
        metadata: { taskId, source: "dm_confirmed", requestId: row.requestId } }),
    });
    return { resolved: "answered", questionId: row.questionId, cursor };
  } catch (error) {
    if (!(error instanceof BoardImportError)) throw error;
    await tx.amuxV22TaskQuestion.update({ where: { id: row.questionId },
      data: { state: "cancelled" } });
    const task = await tx.amuxWorkItem.findUnique({ where: { id: row.taskId },
      select: { status: true } });
    if (task?.status === "blocked")
      await openAmuxHumanEscalation(tx, { taskId: row.taskId,
        specialty: "execution-recovery", reason: "owner_question_unanswerable",
        openedBy: AMUX_SYSTEM_AUDIT_ACTOR });
    await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
      action: "amux.v22.owner_question.cancelled",
      targetType: "AmuxV22TaskQuestion", targetId: row.questionId,
      summary: "Cancelled an AMUX v22 worker question its confirmed answer could not resume.",
      metadata: { taskId: row.taskId, requestId: row.requestId,
        reason: error.code } });
    return { resolved: "cancelled", questionId: row.questionId, cursor };
  }
}
