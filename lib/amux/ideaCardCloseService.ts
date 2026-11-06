import "server-only";

import { randomUUID } from "node:crypto";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { readDecisionMakerSwitchesOrThrow } from "@/lib/amux/decisionMakerSwitchStore";
import { BoardImportError } from "./boardImportCore.ts";
import {
  AMUX_IDEA_CARD_CLOSE_CANCEL_COOLDOWN_DAYS, AMUX_IDEA_CARD_CLOSE_KEEP_DAYS,
  AMUX_IDEA_CARD_CLOSE_SCAN, AMUX_IDEA_CARD_CLOSE_SYNC_LIMIT,
  amuxIdeaCardCloseAskedCards, amuxIdeaCardCloseAskedFrom, amuxIdeaCardCloseCandidate,
  amuxIdeaCardCloseDailyLimit, amuxIdeaCardCloseEnabled,
  amuxIdeaCardCloseRefusal, amuxIdeaCardCloseRelayCard, amuxIdeaCardCloseStaleDays,
  type AmuxIdeaCardCloseAnswerSource, type AmuxIdeaCardCloseAskedCard,
  type AmuxIdeaCardCloseCardFact, type AmuxIdeaCardCloseDecision, type AmuxIdeaCardCloseEnv,
} from "./ideaCardCloseCore.ts";

/**
 * The question "close this stalled idea's remaining cards?" (owner decision
 * 2026-11-05, docs/policy/amux-decision-maker.md §2-10). The relay's tick finds
 * at most one new idea to ask about, behind a default-off switch, and files the
 * question as the same typed-ask card a v22 worker's question uses, so the
 * Decision Maker proposes an answer through its ordinary path and a person
 * confirms it in Admin. The confirmed answer is applied here and never sent to
 * a session. The owner can also answer directly on the idea's detail, which is
 * the way out when the question stayed with the operator or the proposal failed.
 *
 * Raw statements on purpose: each reads or writes one statement, the boundary
 * counts it, and the row's JSON is read through the core's own parser.
 */

const CARD_ID = /^[A-Za-z0-9_-]{1,64}$/;
const QUESTION_ID = /^[0-9a-f-]{36}$/;
/** Who resolves a closed card's open escalation when no person answered. */
export const AMUX_IDEA_CARD_CLOSE_RESOLVER = "amux-idea-card-close";

type SqlCard = Omit<AmuxIdeaCardCloseCardFact, "updatedAtMs"> & { updatedAtMs: number };
type SqlCandidate = { ideaId: string; askedLastDay: number; cards: SqlCard[] | null };

/**
 * The ideas a question could be about, oldest first: one statement. Each idea's
 * cards come with what could still be moving them, and the core judges them.
 * Every exclusion the core makes is also here, before the LIMIT: an idea the
 * core refuses stays old, so one that passed this filter would hold its place in
 * the bound on every tick and hide the ideas behind it. An idea still waiting
 * for plan approval waits for a person already, unless it is completed, which
 * leaves its proposals behind (see lib/amux/ideaProgressCore.ts).
 */
async function readCandidateRows(tx: Prisma.TransactionClient,
  input: { now: Date; staleDays: number; ideaId: string | null }): Promise<SqlCandidate[]> {
  const now = input.now.toISOString();
  return tx.$queryRaw<SqlCandidate[]>`
    WITH clock AS (
      SELECT (${now}::timestamptz AT TIME ZONE 'UTC') AS "now"
    ), own AS NOT MATERIALIZED (
      -- Inlined per idea, so each reference uses the decision's idea index.
      SELECT d."ideaId", w."id", w."displayKey", w."cardType", w."status", w."owner", w."claimedAt",
        w."v22AssignmentId", w."updatedAt"
      FROM "AmuxIdeaUnitDecision" d
      JOIN "AmuxWorkItem" w ON w."id" = d."registeredWorkItemId"
      WHERE d."action" = 'register_card' AND d."state" = 'consumed'
    )
    SELECT i."id" AS "ideaId",
      (SELECT count(*)::int FROM "AmuxIdeaCardCloseQuestion" r, clock
        WHERE r."createdAt" > clock."now" - INTERVAL '1 day') AS "askedLastDay",
      (SELECT json_agg(json_build_object(
          'id', c."id", 'displayKey', c."displayKey", 'cardType', c."cardType", 'status', c."status",
          'assigned', (c."owner" IS NOT NULL OR c."claimedAt" IS NOT NULL OR c."v22AssignmentId" IS NOT NULL),
          'updatedAtMs', (extract(epoch FROM c."updatedAt") * 1000)::double precision,
          'liveAttempt', EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" a
            WHERE a."taskId" = c."id" AND a."endedAt" IS NULL),
          'workerQuestion', EXISTS (SELECT 1 FROM "AmuxV22TaskQuestion" t
            WHERE t."taskId" = c."id" AND t."state" IN ('open', 'answered')),
          'foreignDependent', EXISTS (SELECT 1 FROM "AmuxWorkDependency" e
            JOIN "AmuxWorkItem" o ON o."id" = e."taskId"
            WHERE e."dependencyId" = c."id" AND o."status" NOT IN ('done', 'cancelled')
              AND NOT EXISTS (SELECT 1 FROM own same WHERE same."ideaId" = i."id" AND same."id" = o."id")))
          ORDER BY c."id")
        FROM own c WHERE c."ideaId" = i."id") AS "cards"
    FROM "AmuxIdeaSubmission" i, clock
    WHERE i."cancelledAt" IS NULL AND i."state" IN ('awaiting_owner', 'completed')
      AND (${input.ideaId}::text IS NULL OR i."id" = ${input.ideaId}::text)
      AND NOT EXISTS (SELECT 1 FROM "AmuxIdeaLaneAttempt" l WHERE l."ideaId" = i."id")
      AND NOT EXISTS (SELECT 1 FROM "AmuxIdeaCardCloseQuestion" q WHERE q."ideaId" = i."id" AND (
        q."state" = 'open' OR
        (q."state" = 'kept' AND q."answeredAt" > clock."now" - (${AMUX_IDEA_CARD_CLOSE_KEEP_DAYS}::int * INTERVAL '1 day')) OR
        (q."state" = 'cancelled' AND q."updatedAt" > clock."now" - (${AMUX_IDEA_CARD_CLOSE_CANCEL_COOLDOWN_DAYS}::int * INTERVAL '1 day'))))
      AND (i."state" = 'completed' OR NOT EXISTS (SELECT 1 FROM "AmuxIdeaDraftUnit" u
        WHERE u."ideaId" = i."id" AND u."state" = 'proposed' AND u."unitKind" IN ('node', 'card')
          AND u."expiresAt" > clock."now"))
      AND EXISTS (SELECT 1 FROM own c WHERE c."ideaId" = i."id" AND c."cardType" = 'task'
        AND c."status" NOT IN ('done', 'cancelled'))
      AND NOT EXISTS (SELECT 1 FROM own c WHERE c."ideaId" = i."id"
        AND c."status" NOT IN ('done', 'cancelled', 'backlog', 'blocked', 'todo'))
      AND NOT EXISTS (SELECT 1 FROM own c WHERE c."ideaId" = i."id" AND c."status" NOT IN ('done', 'cancelled')
        AND (c."owner" IS NOT NULL OR c."claimedAt" IS NOT NULL OR c."v22AssignmentId" IS NOT NULL))
      AND NOT EXISTS (SELECT 1 FROM own c JOIN "AmuxExecutionAttempt" a ON a."taskId" = c."id"
        WHERE c."ideaId" = i."id" AND a."endedAt" IS NULL)
      AND NOT EXISTS (SELECT 1 FROM own c JOIN "AmuxV22TaskQuestion" t ON t."taskId" = c."id"
        WHERE c."ideaId" = i."id" AND t."state" IN ('open', 'answered'))
      AND NOT EXISTS (SELECT 1 FROM own c
        JOIN "AmuxWorkDependency" e ON e."dependencyId" = c."id"
        JOIN "AmuxWorkItem" o ON o."id" = e."taskId"
        WHERE c."ideaId" = i."id" AND c."status" IN ('backlog', 'blocked', 'todo')
          AND o."status" NOT IN ('done', 'cancelled')
          AND NOT EXISTS (SELECT 1 FROM own same WHERE same."ideaId" = i."id" AND same."id" = o."id"))
      AND (EXISTS (SELECT 1 FROM own c WHERE c."ideaId" = i."id" AND c."cardType" = 'task' AND c."status" = 'blocked')
        OR NOT EXISTS (SELECT 1 FROM own c WHERE c."ideaId" = i."id" AND c."status" NOT IN ('done', 'cancelled')
          AND c."updatedAt" >= clock."now" - (${input.staleDays}::int * INTERVAL '1 day')))
    ORDER BY i."submittedAt" ASC, i."id" ASC
    LIMIT ${AMUX_IDEA_CARD_CLOSE_SCAN}`;
}

/** The first idea the core accepts, under the day's limit, or null. */
function pickCandidate(rows: SqlCandidate[], input: { now: Date; staleDays: number; dailyLimit: number }) {
  for (const row of rows) {
    if (row.askedLastDay >= input.dailyLimit) return null;
    const found = amuxIdeaCardCloseCandidate(row.cards ?? [],
      { nowMs: input.now.getTime(), staleDays: input.staleDays });
    if (found) return { ideaId: row.ideaId, reason: found.reason,
      asked: amuxIdeaCardCloseAskedFrom(found.targets) };
  }
  return null;
}

/**
 * Asks about at most one idea, from the relay's tick. Off by default: while the
 * switch is off nothing is read and no question appears. The scan needs no lock,
 * so an idle tick costs one read; the write takes the audit chain lock and reads
 * again under it, with the kill switch, within §9's 12 statements: setup + lock +
 * switches + the idea's read + the row + audit 4 + fence.
 */
export async function openAmuxIdeaCardCloseQuestionIfDue(env: AmuxIdeaCardCloseEnv = process.env) {
  if (!amuxIdeaCardCloseEnabled(env)) return { opened: false as const };
  const staleDays = amuxIdeaCardCloseStaleDays(env);
  const dailyLimit = amuxIdeaCardCloseDailyLimit(env);
  const found = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerIdeaCardCloseScan,
    async (tx, { dbNow }) => pickCandidate(
      await readCandidateRows(tx, { now: dbNow, staleDays, ideaId: null }),
      { now: dbNow, staleDays, dailyLimit }));
  if (!found) return { opened: false as const };
  return withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerIdeaCardCloseOpen, async (tx, { dbNow }) => {
    await takeAuditChainLock(tx);
    let killSwitch: boolean | null;
    try { killSwitch = (await readDecisionMakerSwitchesOrThrow(tx)).killSwitch; }
    catch { killSwitch = null; }
    if (killSwitch !== false) return { opened: false as const };
    const current = pickCandidate(
      await readCandidateRows(tx, { now: dbNow, staleDays, ideaId: found.ideaId }),
      { now: dbNow, staleDays, dailyLimit });
    if (!current) return { opened: false as const };
    const questionId = randomUUID();
    const at = dbNow.toISOString();
    await tx.$executeRaw`
      INSERT INTO "AmuxIdeaCardCloseQuestion"
        ("id", "ideaId", "reasonCode", "cards", "createdAt", "updatedAt")
      VALUES (${questionId}, ${current.ideaId}, ${current.reason}, ${JSON.stringify(current.asked)}::jsonb,
        (${at}::timestamptz AT TIME ZONE 'UTC'), (${at}::timestamptz AT TIME ZONE 'UTC'))`;
    await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
      action: "amux.idea.card_close.asked", targetType: "AmuxIdeaCardCloseQuestion",
      targetId: questionId,
      summary: "Asked whether to close the remaining cards of a stalled AMUX idea.",
      metadata: { ideaId: current.ideaId, reasonCode: current.reason, cardCount: current.asked.length } });
    return { opened: true as const, questionId, ideaId: current.ideaId };
  });
}

type SyncPendingRow = { id: string; reasonCode: string; cards: unknown };

/**
 * Open questions with no local card yet, and cards of questions no longer open
 * that the relay has not closed. A question is filed only while the switch is
 * on, because filing one is what starts a paid turn; closing is always allowed.
 */
export async function readAmuxIdeaCardCloseSyncRows(tx: Prisma.TransactionClient,
  input: { filing: boolean }) {
  const pending = input.filing ? await tx.$queryRaw<SyncPendingRow[]>`
    SELECT q."id", q."reasonCode", q."cards" FROM "AmuxIdeaCardCloseQuestion" q
    WHERE q."state" = 'open' AND q."localCardId" IS NULL
    ORDER BY q."createdAt", q."id"
    LIMIT ${AMUX_IDEA_CARD_CLOSE_SYNC_LIMIT}` : [];
  const closing = await tx.$queryRaw<Array<{ questionId: string; cardId: string }>>`
    SELECT q."id" AS "questionId", q."localCardId" AS "cardId"
    FROM "AmuxIdeaCardCloseQuestion" q
    WHERE q."state" <> 'open' AND q."localCardId" IS NOT NULL AND q."localCardClosedAt" IS NULL
    ORDER BY q."updatedAt", q."id"
    LIMIT ${AMUX_IDEA_CARD_CLOSE_SYNC_LIMIT}`;
  return { pending, closing };
}

/** The relay's entries for the rows. A row that cannot be read is left out. */
export function amuxIdeaCardCloseRelayCards(pending: SyncPendingRow[]) {
  return pending.flatMap((row) => {
    const cards = amuxIdeaCardCloseAskedCards(row.cards);
    return cards ? [amuxIdeaCardCloseRelayCard({ questionId: row.id, reasonCode: row.reasonCode, cards })] : [];
  });
}

/**
 * The relay's list for this tick. A fault here costs this tick's card-close
 * entries and nothing of the v22 questions beside them, which share the route.
 */
export async function readAmuxIdeaCardCloseSyncForRelay(env: AmuxIdeaCardCloseEnv = process.env) {
  try {
    const rows = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerIdeaCardCloseRead,
      (tx) => readAmuxIdeaCardCloseSyncRows(tx, { filing: amuxIdeaCardCloseEnabled(env) }));
    return { pending: amuxIdeaCardCloseRelayCards(rows.pending), closing: rows.closing };
  } catch {
    console.warn(JSON.stringify({ subsystem: "amux", event: "idea_card_close_sync_read_failed" }));
    return { pending: [], closing: [] };
  }
}

/** Names the local card of a question, once. Null when no such question exists. */
export async function recordAmuxIdeaCardCloseLocalCard(tx: Prisma.TransactionClient,
  input: { questionId: string; cardId: string }) {
  if (!QUESTION_ID.test(input.questionId) || !CARD_ID.test(input.cardId))
    throw new BoardImportError("invalid_input", 400);
  const changed = await tx.$executeRaw`
    UPDATE "AmuxIdeaCardCloseQuestion" SET "localCardId" = ${input.cardId},
      "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
    WHERE "id" = ${input.questionId} AND "localCardId" IS NULL`;
  if (changed === 1) return { recorded: true as const };
  const rows = await tx.$queryRaw<Array<{ localCardId: string | null }>>`
    SELECT "localCardId" FROM "AmuxIdeaCardCloseQuestion" WHERE "id" = ${input.questionId}`;
  if (rows.length === 0) return null;
  if (rows[0].localCardId !== input.cardId) throw new BoardImportError("card_conflict", 409);
  return { recorded: true as const };
}

/** Records that the relay closed a question's local card, once. Null when no such question exists. */
export async function recordAmuxIdeaCardCloseLocalCardClosed(tx: Prisma.TransactionClient,
  input: { questionId: string; cardId: string; now: Date }) {
  if (!QUESTION_ID.test(input.questionId) || !CARD_ID.test(input.cardId))
    throw new BoardImportError("invalid_input", 400);
  const at = input.now.toISOString();
  const changed = await tx.$executeRaw`
    UPDATE "AmuxIdeaCardCloseQuestion" SET "localCardClosedAt" = (${at}::timestamptz AT TIME ZONE 'UTC'),
      "updatedAt" = (${at}::timestamptz AT TIME ZONE 'UTC')
    WHERE "id" = ${input.questionId} AND "localCardId" = ${input.cardId} AND "state" <> 'open'
      AND "localCardClosedAt" IS NULL`;
  if (changed === 1) return { recorded: true as const };
  const rows = await tx.$queryRaw<Array<{ localCardId: string | null; closed: boolean }>>`
    SELECT "localCardId", ("localCardClosedAt" IS NOT NULL) AS "closed"
    FROM "AmuxIdeaCardCloseQuestion" WHERE "id" = ${input.questionId}`;
  if (rows.length === 0) return null;
  if (rows[0].localCardId !== input.cardId || !rows[0].closed) throw new BoardImportError("not_closable", 409);
  return { recorded: true as const };
}

/** The open question of a Decision Maker request's card. One statement. */
export async function readOpenAmuxIdeaCardCloseQuestionOfCard(tx: Prisma.TransactionClient, cardId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT q."id" FROM "AmuxIdeaCardCloseQuestion" q
    WHERE q."localCardId" = ${cardId} AND q."state" = 'open' LIMIT 1`;
  return rows[0] ?? null;
}

type LockedRow = AmuxIdeaCardCloseCardFact & { questionId: string; ideaId: string;
  state: string; asked: unknown; ideaCancelled: boolean };

export type AmuxIdeaCardCloseAuditEntry = {
  action: string; summary: string; metadata: Record<string, Prisma.InputJsonValue>;
};
export type AmuxIdeaCardCloseApplied =
  | { outcome: "closed"; closedCards: number; auditId: string }
  | { outcome: "kept"; auditId: string }
  | { outcome: "cancelled"; reason: string; auditId: string }
  | { outcome: "not_open" }
  | { outcome: "not_found" };

/**
 * Applies an answer, on the caller's transaction, under the audit chain lock
 * the caller took: unit approval, registration and every other audited writer
 * take the same lock, so a new card cannot land between this read and the
 * write, and a worker's claim locks the same card rows. One statement locks the
 * question and every card of its idea, then the state is judged again: a card
 * that started or a set that changed since the question closes nothing and
 * cancels the question. "keep" only records.
 *
 * A closed card is `cancelled` with `v4TerminalAt` on the DB clock: that is when
 * it became terminal for result retention and any later content purge (the
 * column's CHECKs admit done and cancelled alike), and `merged` in the progress
 * read needs `done` as well, so it never counts as finished work. Its open
 * escalation has nothing left to decide.
 *
 * Eight statements past the caller's: the locked read, the cards, the
 * escalations, the question, audit 4 (fewer on keep and cancel).
 */
export async function applyAmuxIdeaCardCloseAnswerInTransaction(tx: Prisma.TransactionClient, input: {
  questionId: string; decision: AmuxIdeaCardCloseDecision; source: AmuxIdeaCardCloseAnswerSource;
  answeredByUserId: string | null; now: Date;
  audit: (entry: AmuxIdeaCardCloseAuditEntry) => Promise<string>;
}): Promise<AmuxIdeaCardCloseApplied> {
  const rows = await tx.$queryRaw<LockedRow[]>`
    SELECT q."id" AS "questionId", q."ideaId", q."state", q."cards" AS "asked",
      (i."cancelledAt" IS NOT NULL OR i."state" = 'cancelled') AS "ideaCancelled",
      w."id", w."displayKey", w."cardType", w."status",
      (w."owner" IS NOT NULL OR w."claimedAt" IS NOT NULL OR w."v22AssignmentId" IS NOT NULL) AS "assigned",
      (extract(epoch FROM w."updatedAt") * 1000)::double precision AS "updatedAtMs",
      EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" a
        WHERE a."taskId" = w."id" AND a."endedAt" IS NULL) AS "liveAttempt",
      EXISTS (SELECT 1 FROM "AmuxV22TaskQuestion" t
        WHERE t."taskId" = w."id" AND t."state" IN ('open', 'answered')) AS "workerQuestion",
      EXISTS (SELECT 1 FROM "AmuxWorkDependency" e
        JOIN "AmuxWorkItem" o ON o."id" = e."taskId"
        WHERE e."dependencyId" = w."id" AND o."status" NOT IN ('done', 'cancelled')
          AND NOT EXISTS (SELECT 1 FROM "AmuxIdeaUnitDecision" same
            WHERE same."registeredWorkItemId" = o."id" AND same."ideaId" = q."ideaId")) AS "foreignDependent"
    FROM "AmuxIdeaCardCloseQuestion" q
    JOIN "AmuxIdeaSubmission" i ON i."id" = q."ideaId"
    JOIN "AmuxIdeaUnitDecision" d ON d."ideaId" = q."ideaId"
      AND d."action" = 'register_card' AND d."state" = 'consumed'
    JOIN "AmuxWorkItem" w ON w."id" = d."registeredWorkItemId"
    WHERE q."id" = ${input.questionId}
    ORDER BY w."id"
    FOR UPDATE OF q, w`;
  const head = rows[0];
  if (!head) return { outcome: "not_found" };
  if (head.state !== "open") return { outcome: "not_open" };
  const at = input.now.toISOString();
  const answeredBy = input.answeredByUserId;
  const finish = async (state: "closed" | "kept" | "cancelled", cancelReason: string | null) => {
    const changed = await tx.$executeRaw`
      UPDATE "AmuxIdeaCardCloseQuestion" SET "state" = ${state}, "answerSource" = ${input.source},
        "answeredByUserId" = ${answeredBy}::text, "answeredAt" = (${at}::timestamptz AT TIME ZONE 'UTC'),
        "cancelReason" = ${cancelReason}::text, "updatedAt" = (${at}::timestamptz AT TIME ZONE 'UTC')
      WHERE "id" = ${input.questionId} AND "state" = 'open'`;
    if (changed !== 1) throw new BoardImportError("conflict", 409);
  };
  const base = { ideaId: head.ideaId, source: input.source };
  if (input.decision === "keep") {
    await finish("kept", null);
    return { outcome: "kept", auditId: await input.audit({ action: "amux.idea.card_close.kept",
      summary: "Kept the remaining cards of a stalled AMUX idea.", metadata: base }) };
  }
  const asked = amuxIdeaCardCloseAskedCards(head.asked);
  const refusal = asked ? amuxIdeaCardCloseRefusal({ ideaCancelled: head.ideaCancelled, asked, cards: rows }) :
    "cards_changed";
  if (refusal) {
    await finish("cancelled", refusal);
    return { outcome: "cancelled", reason: refusal, auditId: await input.audit({
      action: "amux.idea.card_close.cancelled",
      summary: "Left an AMUX idea's cards as they were: its state changed after the question.",
      metadata: { ...base, reason: refusal } }) };
  }
  const targets = (asked as AmuxIdeaCardCloseAskedCard[]).map((card) => card.id);
  const moved = await tx.amuxWorkItem.updateMany({
    where: { id: { in: targets }, status: { in: ["backlog", "blocked", "todo"] },
      owner: null, claimedAt: null, v22AssignmentId: null },
    data: { status: "cancelled", revision: { increment: 1 }, v4TerminalAt: input.now },
  });
  if (moved.count !== targets.length) throw new BoardImportError("conflict", 409);
  const resolved = await tx.amuxHumanEscalation.updateMany({
    where: { taskId: { in: targets }, status: { in: ["open", "acknowledged"] } },
    data: { status: "resolved", resolutionOutcome: "block",
      resolution: `Closed with the idea's remaining cards (question ${input.questionId}).`,
      resolvedById: answeredBy ?? AMUX_IDEA_CARD_CLOSE_RESOLVER, resolvedByEmail: null, resolvedAt: input.now },
  });
  await finish("closed", null);
  return { outcome: "closed", closedCards: targets.length, auditId: await input.audit({
    action: "amux.idea.card_close.closed",
    summary: "Closed the remaining cards of a stalled AMUX idea.",
    metadata: { ...base, cardIds: targets, escalationsResolved: resolved.count } }) };
}

/**
 * Applies a confirmed Decision Maker answer: the audit chain lock first, the
 * kill switch read under it, the lock the switch's own writer takes, so an
 * operator turning it on is seen, then the answer. Twelve statements at most:
 * setup + lock + switches + the eight above + fence, pinned by the boundary.
 */
export async function applyAmuxIdeaCardCloseDmAnswer(tx: Prisma.TransactionClient, input: {
  questionId: string; requestId: string; decision: AmuxIdeaCardCloseDecision; now: Date;
}) {
  await takeAuditChainLock(tx);
  let killSwitch: boolean | null;
  try { killSwitch = (await readDecisionMakerSwitchesOrThrow(tx)).killSwitch; }
  catch { killSwitch = null; }
  if (killSwitch !== false) return { applied: false as const };
  const result = await applyAmuxIdeaCardCloseAnswerInTransaction(tx, {
    questionId: input.questionId, decision: input.decision, source: "dm_confirmed",
    // The person's judgment audit names who confirmed it.
    answeredByUserId: null, now: input.now,
    audit: (entry) => writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
      action: entry.action, targetType: "AmuxIdeaCardCloseQuestion", targetId: input.questionId,
      summary: entry.summary, metadata: { ...entry.metadata, requestId: input.requestId } }),
  });
  return { applied: true as const, outcome: result.outcome };
}

/**
 * A confirmed answer that says neither close nor keep changes nothing and goes
 * to a person: the question stays open with its panel on the idea's detail, and
 * this says why, once. A walk that passes it again records nothing more. The
 * audit chain lock comes before the question's row, the order the owner's
 * answer and the applied answer take, so the two never wait on each other.
 */
export async function recordAmuxIdeaCardCloseHandoff(tx: Prisma.TransactionClient, input: {
  questionId: string; requestId: string; reason: string; now: Date;
}) {
  await takeAuditChainLock(tx);
  const at = input.now.toISOString();
  const changed = await tx.$executeRaw`
    UPDATE "AmuxIdeaCardCloseQuestion" SET "handoffReason" = ${input.reason},
      "handoffAt" = (${at}::timestamptz AT TIME ZONE 'UTC'), "updatedAt" = (${at}::timestamptz AT TIME ZONE 'UTC')
    WHERE "id" = ${input.questionId} AND "state" = 'open' AND "handoffAt" IS NULL`;
  if (changed !== 1) return { recorded: false as const };
  await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
    action: "amux.idea.card_close.handed_off", targetType: "AmuxIdeaCardCloseQuestion",
    targetId: input.questionId,
    summary: "Left a card close question to the owner: its confirmed answer could not be read.",
    metadata: { requestId: input.requestId, reason: input.reason } });
  return { recorded: true as const };
}

export type AmuxIdeaCardCloseOwnerView = {
  questionId: string; reasonCode: string; cards: AmuxIdeaCardCloseAskedCard[];
  handedOff: boolean; createdAt: string;
};

/** The open question of one of the owner's ideas, for its detail. Another owner's reads as none. */
export async function readAmuxIdeaCardCloseQuestionForOwner(input: { ideaId: string; actorUserId: string }):
  Promise<AmuxIdeaCardCloseOwnerView | null> {
  const rows = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerIdeaCardCloseOwnerRead,
    (tx) => tx.$queryRaw<Array<{ id: string; reasonCode: string; cards: unknown; handedOff: boolean; createdAtMs: number }>>`
      SELECT q."id", q."reasonCode", q."cards", (q."handoffAt" IS NOT NULL) AS "handedOff",
        (extract(epoch FROM q."createdAt") * 1000)::double precision AS "createdAtMs"
      FROM "AmuxIdeaCardCloseQuestion" q
      JOIN "AmuxIdeaSubmission" i ON i."id" = q."ideaId"
      WHERE q."ideaId" = ${input.ideaId} AND q."state" = 'open' AND i."actorUserId" = ${input.actorUserId}
      LIMIT 1`);
  const row = rows[0];
  const cards = row ? amuxIdeaCardCloseAskedCards(row.cards) : null;
  return row && cards ? { questionId: row.id, reasonCode: row.reasonCode, cards,
    handedOff: row.handedOff, createdAt: new Date(row.createdAtMs).toISOString() } : null;
}
