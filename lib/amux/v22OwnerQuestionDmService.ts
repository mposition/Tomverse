import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
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
import { AMUX_V22_PROVIDERS, amuxV22Provider } from "./v22WorkerClaimCore.ts";
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
/** Pending questions read per tick to find those that can be opened, so a
 * few that cannot never hide the ones behind them. */
export const AMUX_V22_QUESTION_PENDING_SCAN = 24;

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
  attemptId: string; worker: string; sequence: number; sourceSha256: string;
  provider: string | null };

/** Open questions with no local card yet, with their run's result rows, and
 * cards of questions no longer open that the relay has not closed. */
export async function readAmuxV22QuestionSyncRows(tx: Prisma.TransactionClient) {
  const pending = await tx.$queryRaw<PendingRow[]>`
    SELECT q."id" AS "questionId", q."taskId", q."attemptId", q."worker",
      q."sequence", r."ideaId", r."ciphertext", r."keyId", r."keyVersion",
      r."digest", r."digestKeyId", r."sourceSha256", r."bodyPurgedAt",
      g."provider"
    FROM "AmuxV22TaskQuestion" q
    JOIN "AmuxV22TaskResult" r
      ON r."attemptId" = q."attemptId" AND r."taskId" = q."taskId"
    JOIN "AmuxExecutionAttempt" a ON a."id" = q."attemptId"
    JOIN "AmuxWorkItem" w ON w."id" = q."taskId"
    LEFT JOIN "AmuxV22WorkerAssignment" g ON g."id" = a."v22AssignmentId"
    -- Only a question its run's settlement parked, on a Task still parked,
    -- with a body still there. Up to 24 are read so that a body that exists
    -- but cannot be opened (a key store fault) is passed over, not in the way.
    WHERE q."state" = 'open' AND q."localCardId" IS NULL
      AND a."endedAt" IS NOT NULL AND a."reason" = 'owner_question'
      AND w."status" = 'blocked' AND w."archivedAt" IS NULL
      AND r."bodyPurgedAt" IS NULL
    ORDER BY q."createdAt", q."id"
    LIMIT ${AMUX_V22_QUESTION_PENDING_SCAN}`;
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
    if (cards.length >= AMUX_V22_QUESTION_SYNC_LIMIT) break;
    // The provider class the Decision Maker routes by, from the asking run's
    // assignment: a v22 worker may have no local session that names it.
    const provider = row.provider ? amuxV22Provider(row.provider) : null;
    if (!provider) continue;
    // One question that cannot be opened (a key store fault) is left out of
    // this tick; the others and the closing list still go.
    let text: string | null = null;
    try { text = await openAmuxV22TaskResultRow(row.attemptId, row); }
    catch { continue; }
    const question = text ? parseAmuxV22OwnerQuestion(text) : null;
    if (!question) continue;
    cards.push({ question_id: row.questionId, worker: row.worker,
      provider: AMUX_V22_PROVIDERS[provider].providerClass,
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
  if (!row) throw new BoardImportError("not_found", 404);
  if (row.localCardId !== input.cardId || !row.localCardClosedAt)
    throw new BoardImportError("not_closable", 409);
  return { recorded: true as const };
}

/** Where the relay's walk over confirmations goes next. */
export type AmuxV22ResolveCursor =
  | { move: "keep" } | { move: "reset" }
  | { move: "advance"; judgedAtMs: number; requestId: string };

type Advance = Extract<AmuxV22ResolveCursor, { move: "advance" }>;

/** One read step of the walk, and what the writes after it should do. */
export type AmuxV22ResolveStep =
  | { kind: "wait"; cursor: AmuxV22ResolveCursor }
  | { kind: "skip"; cursor: Advance }
  | { kind: "answer"; cursor: Advance; questionId: string; taskId: string;
      requestId: string; message: string }
  | { kind: "cancel"; cursor: Advance; questionId: string; taskId: string;
      requestId: string; reason: string };

/**
 * The read step of the walk over confirmed Decision Maker proposals, the walk
 * the delivery read takes (`readNextDecisionMakerDeliveryJudgment`), from the
 * relay's cursor: six statements (switches, the confirmation, the request,
 * the open question of its card, the result detail, the bodies). Under the
 * kill switch, or when the switches cannot be read, nothing more is read and
 * the walk keeps its place (docs/policy/amux-decision-maker.md §6). A confirmation of an open v22 question card
 * yields the text a worker would have been sent; one whose asking run has not
 * settled yet waits for it; any other confirmation is stepped past.
 */
export async function readAmuxV22ResolveStep(
  tx: Prisma.TransactionClient, after: DmDeliveryCursor | null):
  Promise<AmuxV22ResolveStep> {
  let killSwitch: boolean | null;
  try { killSwitch = (await readDecisionMakerSwitchesOrThrow(tx)).killSwitch; }
  catch { killSwitch = null; }
  if (killSwitch !== false) return { kind: "wait", cursor: { move: "keep" } };
  const judgment = await readNextDecisionMakerDeliveryJudgment(tx, { after });
  if (!judgment) return { kind: "wait", cursor: { move: "reset" } };
  const cursor: Advance = { move: "advance", judgedAtMs: judgment.judgedAtMs,
    requestId: judgment.requestId };
  const state = await readDecisionMakerRequestState(tx, judgment.requestId);
  const question = state ? await tx.amuxV22TaskQuestion.findFirst({
    where: { localCardId: state.binding.cardId, state: "open" },
    select: { id: true, taskId: true, attempt: { select: { endedAt: true } } },
  }) : null;
  if (!question) return { kind: "skip", cursor };
  // The asking run has not settled yet: the walk waits here and asks again,
  // rather than cancel a question that is about to be parked.
  if (!question.attempt.endedAt) return { kind: "wait", cursor: { move: "keep" } };
  const detail = await readDecisionMakerResultDetail(tx, judgment.requestId);
  const bodies: DmDeliveryBodies = {};
  for (const body of await readDecisionMakerBodies(tx, judgment.requestId))
    if (body.field === "dm_answer" || body.field === "operator_answer")
      bodies[body.field] = body.text;
  const candidate = dmDeliveryCandidate({ judgment, state, detail, bodies });
  const base = { cursor, questionId: question.id, taskId: question.taskId,
    requestId: judgment.requestId };
  return candidate?.status === "ready" ?
    { kind: "answer", ...base, message: candidate.message } :
    { kind: "cancel", ...base, reason: "answer_unavailable" };
}

/**
 * Answers the question with the confirmed text: the audit chain lock first,
 * the kill switch read under it -- the lock the switch's own writer takes, so
 * an operator turning it on is seen -- then the answer, which resumes the
 * Task. Eleven statements. A refusal of the answer itself throws
 * `BoardImportError` and rolls back; the caller cancels the question then.
 */
export async function applyAmuxV22DmAnswer(tx: Prisma.TransactionClient,
  input: { questionId: string; requestId: string; message: string; now: Date }) {
  await takeAuditChainLock(tx);
  let killSwitch: boolean | null;
  try { killSwitch = (await readDecisionMakerSwitchesOrThrow(tx)).killSwitch; }
  catch { killSwitch = null; }
  if (killSwitch !== false) return { applied: false as const };
  await answerAmuxV22OwnerQuestionInTransaction(tx, {
    questionId: input.questionId, answer: input.message,
    // The person's judgment audit names who confirmed it.
    source: "dm_confirmed", answeredByUserId: null, now: input.now,
    audit: (taskId) => writeSystemAuditLog({ tx,
      systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
      action: "amux.v22.owner_question.answered",
      targetType: "AmuxV22TaskQuestion", targetId: input.questionId,
      summary: "Answered an AMUX v22 worker question with a confirmed Decision Maker proposal.",
      metadata: { taskId, source: "dm_confirmed", requestId: input.requestId } }),
  });
  return { applied: true as const };
}

/** A Task still parked by a question its confirmed answer cannot resume goes
 * to a person. Idempotent: an open escalation is kept. Run before the
 * question is cancelled, so a lost cancel is retried with it in place. */
export async function escalateAmuxV22UnanswerableQuestion(
  tx: Prisma.TransactionClient, input: { taskId: string }) {
  const task = await tx.amuxWorkItem.findUnique({ where: { id: input.taskId },
    select: { status: true } });
  if (task?.status === "blocked")
    await openAmuxHumanEscalation(tx, { taskId: input.taskId,
      specialty: "execution-recovery", reason: "owner_question_unanswerable",
      openedBy: AMUX_SYSTEM_AUDIT_ACTOR });
}

/** Cancels a question its confirmed answer cannot resume, once. */
export async function cancelAmuxV22UnanswerableQuestion(
  tx: Prisma.TransactionClient,
  input: { questionId: string; taskId: string; requestId: string; reason: string }) {
  const changed = await tx.amuxV22TaskQuestion.updateMany({ where: {
    id: input.questionId, state: "open" }, data: { state: "cancelled" } });
  if (changed.count !== 1) return { cancelled: false as const };
  await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
    action: "amux.v22.owner_question.cancelled",
    targetType: "AmuxV22TaskQuestion", targetId: input.questionId,
    summary: "Cancelled an AMUX v22 worker question its confirmed answer could not resume.",
    metadata: { taskId: input.taskId, requestId: input.requestId,
      reason: input.reason } });
  return { cancelled: true as const };
}

/**
 * One step of the walk, each part its own transaction within docs/policy/amux-decision-maker.md §9's 12
 * statements: the read; then the answer under the audit chain lock and the
 * kill switch; or, when the answer cannot resume the Task, an escalation and
 * the cancel. What the relay is told about its cursor comes back with it.
 */
export async function runAmuxV22ResolveStep(after: DmDeliveryCursor | null):
  Promise<{ resolved: null | "answered" | "cancelled"; cursor: AmuxV22ResolveCursor }> {
  const step = await withAmuxDbBoundary(
    AMUX_DB_BOUNDARIES.decisionMakerV22QuestionResolve,
    (tx) => readAmuxV22ResolveStep(tx, after));
  let cursor: AmuxV22ResolveCursor = step.cursor;
  let outcome: null | "answered" | "cancelled" = null;
  let cancel = step.kind === "cancel" ? step.reason : null;
  if (step.kind === "answer") {
    try {
      const applied = await withAmuxDbBoundary(
        AMUX_DB_BOUNDARIES.decisionMakerV22QuestionAnswer,
        (tx, context) => applyAmuxV22DmAnswer(tx, { questionId: step.questionId,
          requestId: step.requestId, message: step.message, now: context.dbNow }));
      if (applied.applied) outcome = "answered";
      else cursor = { move: "keep" };
    } catch (error) {
      // Rolled back: the answer cannot resume the Task.
      if (!(error instanceof BoardImportError)) throw error;
      // Answered meanwhile (in Admin): nothing to cancel.
      if (error.code !== "question_not_open") cancel = error.code;
    }
  }
  if ((step.kind === "answer" || step.kind === "cancel") && cancel) {
    await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerV22QuestionEscalate,
      (tx) => escalateAmuxV22UnanswerableQuestion(tx, { taskId: step.taskId }));
    await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerV22QuestionCancel,
      (tx) => cancelAmuxV22UnanswerableQuestion(tx, { questionId: step.questionId,
        taskId: step.taskId, requestId: step.requestId, reason: cancel! }));
    outcome = "cancelled";
  }
  return { resolved: outcome, cursor };
}
