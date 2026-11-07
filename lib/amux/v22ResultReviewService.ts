import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { BoardImportError } from "@/lib/amux/boardImportCore";
import { openAmuxContent, verifyAmuxContentDigest } from "@/lib/amux/ideaCrypto";
import { loadAmuxContentKeyRing } from "@/lib/amux/ideaKeyStore";
import { readDecisionMakerSwitchesOrThrow } from "@/lib/amux/decisionMakerSwitchStore";
import { settlementDestinationForBudget } from "@/lib/amux/executionBudgetCore";
import { parseAmuxV22Conclusion } from "@/lib/amux/v22ConclusionCore";
import { amuxV22ResultReviewRelayCard, amuxV22ResultReviewTarget,
  type AmuxV22ResultReviewDecision, type AmuxV22ResultReviewKind } from
  "@/lib/amux/v22ResultReviewCore";
import { openAmuxV22TaskResultRow, type AmuxV22SealedRow } from
  "@/lib/amux/v22TaskResultStore";

/**
 * A v22 result waiting for review, through the Decision Maker (owner decision
 * 2026-11-07). Settlement writes the row (execution.ts); the relay's sync
 * files it as a typed-ask card in the shape of a v22 question, so the bridge
 * needs no change; the walk applies the answer here. The human escalation
 * settlement opened stays open beside it: whichever answers first wins, and a
 * review whose Task left review is cancelled.
 */

const CARD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REVIEW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const AMUX_V22_RESULT_REVIEW_SYNC_LIMIT = 3;
export const AMUX_V22_RESULT_REVIEW_PENDING_SCAN = 24;
export const AMUX_V22_RESULT_REVIEW_APPLIED_ACTION = "amux.v22.result_review.applied";
/** Who resolves the person's escalation when the Decision Maker decided, as
 * the card close and the merge observer name themselves: never a person's id. */
export const AMUX_V22_RESULT_REVIEW_RESOLVER = "system:amux-v22-result-review";

type PendingReview = AmuxV22SealedRow & { reviewId: string; taskId: string;
  attemptId: string; kind: AmuxV22ResultReviewKind; taskLabel: string;
  role: string | null; sourceSha256: string;
  bodyCiphertext: Uint8Array | null; bodyKeyId: string | null;
  bodyKeyVersion: number | null; bodyDigest: string | null;
  bodyDigestKeyId: string | null };

/** Open reviews with no card yet, on a Task still in review, with their run's
 * result rows; and cards of reviews no longer open that the relay has not
 * closed. Reviews whose Task left review meanwhile are cancelled first. */
export async function readAmuxV22ResultReviewSyncRows(tx: Prisma.TransactionClient) {
  await tx.$executeRaw`
    UPDATE "AmuxV22ResultReview" v SET "state" = 'cancelled', "cancelReason" = 'task_moved',
      "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
    FROM "AmuxWorkItem" w
    WHERE w."id" = v."taskId" AND v."state" = 'open'
      AND (w."status" <> 'review' OR w."archivedAt" IS NOT NULL)`;
  const pending = await tx.$queryRaw<PendingReview[]>`
    SELECT v."id" AS "reviewId", v."taskId", v."attemptId", v."kind",
      coalesce(w."displayKey", w."id") AS "taskLabel", w."taskRole" AS "role",
      w."v4BodyCiphertext" AS "bodyCiphertext", w."v4BodyKeyId" AS "bodyKeyId",
      w."v4BodyKeyVersion" AS "bodyKeyVersion", w."v4BodyDigest" AS "bodyDigest",
      w."v4BodyDigestKeyId" AS "bodyDigestKeyId",
      r."ideaId", r."ciphertext", r."keyId", r."keyVersion", r."digest",
      r."digestKeyId", r."sourceSha256", r."bodyPurgedAt"
    FROM "AmuxV22ResultReview" v
    JOIN "AmuxWorkItem" w ON w."id" = v."taskId"
    JOIN "AmuxV22TaskResult" r ON r."attemptId" = v."attemptId" AND r."taskId" = v."taskId"
    WHERE v."state" = 'open' AND v."localCardId" IS NULL AND v."handoffAt" IS NULL
      AND w."status" = 'review' AND w."archivedAt" IS NULL
    ORDER BY v."createdAt", v."id"
    LIMIT ${AMUX_V22_RESULT_REVIEW_PENDING_SCAN}`;
  const closing = await tx.$queryRaw<Array<{ questionId: string; cardId: string }>>`
    SELECT v."id" AS "questionId", v."localCardId" AS "cardId"
    FROM "AmuxV22ResultReview" v
    WHERE v."state" <> 'open' AND v."localCardId" IS NOT NULL
      AND v."localCardClosedAt" IS NULL
    ORDER BY v."updatedAt", v."id"
    LIMIT ${AMUX_V22_RESULT_REVIEW_SYNC_LIMIT}`;
  return { pending, closing };
}

/** The Task's approved completion criteria, opened from its sealed body, or
 * null when they cannot be read. */
async function openCompletionCriteria(row: PendingReview): Promise<string[] | null> {
  if (!row.bodyCiphertext || !row.bodyKeyId || !row.bodyKeyVersion ||
      !row.bodyDigest || !row.bodyDigestKeyId) return null;
  const keys = await loadAmuxContentKeyRing([
    { ideaId: row.ideaId, purpose: "card_body", subjectId: row.taskId }]);
  let plain: Buffer | null = null;
  try {
    plain = openAmuxContent({ ciphertext: Buffer.from(row.bodyCiphertext),
      keyId: row.bodyKeyId, keyVersion: row.bodyKeyVersion }, "card_body", row.taskId, keys);
    if (!verifyAmuxContentDigest(plain, "card_body", row.taskId, row.bodyDigest,
      row.bodyDigestKeyId, keys)) return null;
    const criteria = (JSON.parse(plain.toString("utf8")) as
      { completionCriteria?: unknown }).completionCriteria;
    return Array.isArray(criteria) && criteria.length > 0 &&
      criteria.every((item) => typeof item === "string" && item.trim().length > 0) ?
      criteria as string[] : null;
  } finally { plain?.fill(0); }
}

/**
 * The cards the relay files, opened outside the DB transaction: the Task's
 * completion criteria and the run's findings (its conclusion's, else the whole
 * result), both whole. A review whose evidence cannot be read, or does not fit
 * a card whole, is not put to the Decision Maker -- approving what it cannot
 * see would be a blind approval -- and comes back in `unfilable` to be handed
 * to the person, so it never holds back the reviews behind it.
 */
export async function openAmuxV22ResultReviewCards(pending: PendingReview[]) {
  const cards = [];
  const unfilable: string[] = [];
  for (const row of pending) {
    if (cards.length >= AMUX_V22_RESULT_REVIEW_SYNC_LIMIT) break;
    let card: ReturnType<typeof amuxV22ResultReviewRelayCard> = null;
    try {
      const text = await openAmuxV22TaskResultRow(row.attemptId, row);
      const criteria = text ? await openCompletionCriteria(row) : null;
      if (text && criteria) card = amuxV22ResultReviewRelayCard({ reviewId: row.reviewId,
        taskLabel: row.taskLabel, role: row.role, kind: row.kind, criteria,
        findings: parseAmuxV22Conclusion(text)?.findings ?? text });
    } catch { card = null; }
    if (card) cards.push(card);
    else unfilable.push(row.reviewId);
  }
  return { cards, unfilable };
}

/** Hands reviews the relay could not file to the person, once each, with one
 * system audit: the open escalation already waits for them. */
export async function recordAmuxV22ResultReviewsUnfilable(tx: Prisma.TransactionClient,
  input: { reviewIds: string[]; now: Date }) {
  const ids = input.reviewIds.filter((id) => REVIEW_ID.test(id));
  if (ids.length === 0) return { recorded: 0 };
  await takeAuditChainLock(tx);
  const at = input.now.toISOString();
  const changed = await tx.$executeRaw`
    UPDATE "AmuxV22ResultReview" SET "handoffReason" = 'evidence_unavailable',
      "handoffAt" = (${at}::timestamptz AT TIME ZONE 'UTC'),
      "updatedAt" = (${at}::timestamptz AT TIME ZONE 'UTC')
    WHERE "id" = ANY(${ids}) AND "state" = 'open' AND "handoffAt" IS NULL`;
  if (changed > 0)
    await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
      action: "amux.v22.result_review.handed_off", targetType: "AmuxV22ResultReview",
      targetId: ids[0]!,
      summary: "Left v22 result reviews to a person: their evidence could not be read or did not fit a card whole.",
      metadata: { reviewIds: ids, reason: "evidence_unavailable" } });
  return { recorded: changed };
}

/** Names the local card of a review, once. Null when no such review exists. */
export async function recordAmuxV22ResultReviewLocalCard(tx: Prisma.TransactionClient,
  input: { questionId: string; cardId: string }) {
  if (!REVIEW_ID.test(input.questionId) || !CARD_ID.test(input.cardId)) return null;
  const changed = await tx.$executeRaw`
    UPDATE "AmuxV22ResultReview" SET "localCardId" = ${input.cardId},
      "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
    WHERE "id" = ${input.questionId} AND "localCardId" IS NULL`;
  if (changed === 1) return { recorded: true as const };
  const rows = await tx.$queryRaw<Array<{ localCardId: string | null }>>`
    SELECT "localCardId" FROM "AmuxV22ResultReview" WHERE "id" = ${input.questionId}`;
  if (rows.length === 0) return null;
  if (rows[0].localCardId !== input.cardId) throw new BoardImportError("card_conflict", 409);
  return { recorded: true as const };
}

/** Records that the relay closed a review's local card, once. Null when no such review exists. */
export async function recordAmuxV22ResultReviewLocalCardClosed(tx: Prisma.TransactionClient,
  input: { questionId: string; cardId: string; now: Date }) {
  if (!REVIEW_ID.test(input.questionId) || !CARD_ID.test(input.cardId)) return null;
  const at = input.now.toISOString();
  const changed = await tx.$executeRaw`
    UPDATE "AmuxV22ResultReview" SET "localCardClosedAt" = (${at}::timestamptz AT TIME ZONE 'UTC'),
      "updatedAt" = (${at}::timestamptz AT TIME ZONE 'UTC')
    WHERE "id" = ${input.questionId} AND "localCardId" = ${input.cardId}
      AND "state" <> 'open' AND "localCardClosedAt" IS NULL`;
  if (changed === 1) return { recorded: true as const };
  const rows = await tx.$queryRaw<Array<{ localCardId: string | null; closed: boolean }>>`
    SELECT "localCardId", "localCardClosedAt" IS NOT NULL AS "closed"
    FROM "AmuxV22ResultReview" WHERE "id" = ${input.questionId}`;
  if (rows.length === 0) return null;
  if (rows[0].localCardId !== input.cardId || !rows[0].closed)
    throw new BoardImportError("not_closable", 409);
  return { recorded: true as const };
}

/** The open review of a local card, for the walk. One statement. */
export async function readOpenAmuxV22ResultReviewOfCard(tx: Prisma.TransactionClient,
  cardId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "AmuxV22ResultReview"
    WHERE "localCardId" = ${cardId} AND "state" = 'open' LIMIT 1`;
  return rows[0] ?? null;
}

type LockedReview = { reviewId: string; state: string; attemptId: string; taskId: string;
  taskStatus: string; taskRevision: number; sourceSystem: string | null;
  archived: boolean; attemptNumber: number | null; newestAttemptId: string | null;
  resultReadable: boolean };

/**
 * Applies a decision on a review: under the audit chain lock and the kill
 * switch, the review, its Task and the Task's newest attempt locked in one
 * statement. approve finishes the Task (terminal once, on the DB clock),
 * retry returns it to todo for a new run within the attempt budget (a spent
 * budget blocks it instead), block parks it blocked with the person's
 * escalation still open. approve and retry resolve that escalation as the
 * system. A Task that left review, or ran again, cancels the review instead.
 * Twelve statements: setup, lock, switches, the locked rows, Task, escalation,
 * review, canonical audit 4, fence.
 */
export async function applyAmuxV22ResultReviewDecision(tx: Prisma.TransactionClient,
  input: { reviewId: string; decision: AmuxV22ResultReviewDecision;
    source: "dm" | "dm_confirmed"; requestId: string; now: Date }) {
  await takeAuditChainLock(tx);
  let killSwitch: boolean | null;
  try { killSwitch = (await readDecisionMakerSwitchesOrThrow(tx)).killSwitch; }
  catch { killSwitch = null; }
  if (killSwitch !== false) return { applied: false as const, outcome: null };
  const rows = await tx.$queryRaw<LockedReview[]>`
    SELECT v."id" AS "reviewId", v."state", v."attemptId", v."taskId",
      w."status" AS "taskStatus", w."revision" AS "taskRevision", w."sourceSystem",
      w."archivedAt" IS NOT NULL AS "archived",
      a."attemptNumber", a."id" AS "newestAttemptId",
      (r."bodyPurgedAt" IS NULL AND r."ciphertext" IS NOT NULL) AS "resultReadable"
    FROM "AmuxV22ResultReview" v
    JOIN "AmuxWorkItem" w ON w."id" = v."taskId"
    LEFT JOIN "AmuxV22TaskResult" r ON r."attemptId" = v."attemptId" AND r."taskId" = v."taskId"
    LEFT JOIN LATERAL (
      SELECT x."id", x."attemptNumber" FROM "AmuxExecutionAttempt" x
      WHERE x."taskId" = v."taskId" ORDER BY x."startedAt" DESC, x."id" DESC LIMIT 1
    ) a ON true
    WHERE v."id" = ${input.reviewId}
    FOR UPDATE OF v, w`;
  const row = rows[0];
  if (!row || row.state !== "open") return { applied: false as const, outcome: null };
  const at = input.now.toISOString();
  if (row.taskStatus !== "review" || row.archived || row.sourceSystem !== "admin-idea-v4" ||
      row.newestAttemptId !== row.attemptId) {
    await tx.$executeRaw`
      UPDATE "AmuxV22ResultReview" SET "state" = 'cancelled', "cancelReason" = 'task_moved',
        "updatedAt" = (${at}::timestamptz AT TIME ZONE 'UTC')
      WHERE "id" = ${input.reviewId} AND "state" = 'open'`;
    return { applied: true as const, outcome: "cancelled" as const };
  }
  // A result whose body is gone cannot be approved or retried on its
  // strength: the review goes to the person, whose escalation is open.
  if (!row.resultReadable && input.decision !== "block") {
    await tx.$executeRaw`
      UPDATE "AmuxV22ResultReview" SET "handoffReason" = 'result_unreadable',
        "handoffAt" = (${at}::timestamptz AT TIME ZONE 'UTC'),
        "updatedAt" = (${at}::timestamptz AT TIME ZONE 'UTC')
      WHERE "id" = ${input.reviewId} AND "state" = 'open' AND "handoffAt" IS NULL`;
    return { applied: false as const, outcome: "handed_off" as const };
  }
  let target = amuxV22ResultReviewTarget(input.decision);
  if (target === "todo" && settlementDestinationForBudget({ requested_status: "todo",
    attempt_number: row.attemptNumber }).to_status !== "todo") target = "blocked";
  await tx.amuxWorkItem.update({ where: { id: row.taskId }, data: {
    status: target, revision: { increment: 1 },
    ...(target === "done" ? { v4TerminalAt: input.now } : {}),
    ...(target === "todo" ? { owner: null, claimedAt: null, reviewPrNumber: null } : {}),
  } });
  // A block leaves the person's escalation open: the Task waits for them.
  if (target !== "blocked")
    await tx.amuxHumanEscalation.updateMany({ where: { taskId: row.taskId,
      status: { in: ["open", "acknowledged"] } }, data: { status: "resolved",
      resolutionOutcome: input.decision,
      resolution: `Decision Maker result review (${input.source}): ${input.decision}`,
      resolvedById: AMUX_V22_RESULT_REVIEW_RESOLVER, resolvedByEmail: null,
      resolvedAt: input.now } });
  await tx.amuxV22ResultReview.update({ where: { id: row.reviewId }, data: {
    state: "applied", decision: input.decision, answerSource: input.source,
    requestId: input.requestId, decidedAt: input.now } });
  await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
    action: AMUX_V22_RESULT_REVIEW_APPLIED_ACTION, targetType: "AmuxWorkItem",
    targetId: row.taskId,
    summary: "Applied a Decision Maker answer to a v22 result waiting for review.",
    metadata: { reviewId: row.reviewId, attemptId: row.attemptId,
      decision: input.decision, source: input.source, requestId: input.requestId,
      fromRevision: row.taskRevision, toStatus: target } });
  return { applied: true as const, outcome: target };
}

/** An answer that says none of the three words changes nothing; the review
 * stays with the person's escalation, and this says why, once. */
export async function recordAmuxV22ResultReviewHandoff(tx: Prisma.TransactionClient,
  input: { reviewId: string; requestId: string; reason: string; now: Date }) {
  await takeAuditChainLock(tx);
  const at = input.now.toISOString();
  const changed = await tx.$executeRaw`
    UPDATE "AmuxV22ResultReview" SET "handoffReason" = ${input.reason},
      "handoffAt" = (${at}::timestamptz AT TIME ZONE 'UTC'),
      "updatedAt" = (${at}::timestamptz AT TIME ZONE 'UTC')
    WHERE "id" = ${input.reviewId} AND "state" = 'open' AND "handoffAt" IS NULL`;
  if (changed !== 1) return { recorded: false as const };
  await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
    action: "amux.v22.result_review.handed_off", targetType: "AmuxV22ResultReview",
    targetId: input.reviewId,
    summary: "Left a v22 result review to a person: the Decision Maker answer did not decide it.",
    metadata: { requestId: input.requestId, reason: input.reason } });
  return { recorded: true as const };
}
