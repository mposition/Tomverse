import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { BoardImportError } from "@/lib/amux/boardImportCore";
import { readDecisionMakerSwitchesOrThrow } from "@/lib/amux/decisionMakerSwitchStore";
import { settlementDestinationForBudget } from "@/lib/amux/executionBudgetCore";
import { readAmuxCardTitle } from "./adminExecutionRead.ts";
import {
  AMUX_DM_OWNER_SETTLEMENT_DECISIONS, amuxDmOwnerSettlementCard, amuxDmOwnerSettlementId,
  amuxDmOwnerSettlementKind, isAmuxDmOwnerSettlementId,
  type AmuxDmOwnerSettlementAnswer, type AmuxDmOwnerSettlementKind,
} from "./dmOwnerSettlementCore.ts";
import {
  readAmuxDmOwnerSettlementApprovalFacts, readAmuxDmOwnerSettlementPullEvidence,
  scanAmuxDmOwnerSettlementCandidates,
} from "./dmOwnerSettlementRead.ts";
import {
  AMUX_DM_OWNER_SETTLEMENT_RESOLVER, closeAmuxStoppedCardAsSystemWithin,
  completeAmuxStoppedCardAsSystemWithin, type AmuxStoppedCardLockedFacts,
} from "./legacyCardSystemService.ts";
import { parseAmuxV22Conclusion } from "./v22ConclusionCore.ts";
import { openCompletionCriteria } from "./v22ResultReviewService.ts";
import { openAmuxV22TaskResultRow, v22TaskResultIdeaId } from "./v22TaskResultStore.ts";

/**
 * The AMUX owner queue through the Decision Maker (owner decision 2026-11-13).
 * The relay's v22 question tick files each stopped v22 Task no other Decision
 * Maker path holds (dmOwnerSettlementRead.ts) as one settlement row per human
 * escalation, then as a typed-ask card in the shape of a v22 question, so the
 * bridge needs no change. The walk over confirmations and the DM approver
 * apply the answer here; the escalation stays open beside it, so a person who
 * answers first wins and the settlement is cancelled. Nothing is filed while
 * TOMVERSE_AMUX_DM_OWNER_SETTLEMENT is off; the rows already open still close.
 *
 * An approval of a review pull request is recorded only -- the binding, its
 * verified head and diff digest -- for the merge lane's next stage; the Task
 * and its escalation stay as they are.
 */

const CARD_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** New settlements filed per tick, and cards handed to the relay per tick. */
export const AMUX_DM_OWNER_SETTLEMENT_SYNC_LIMIT = 3;
/** Pending settlements read per tick, so a few that cannot be filed never hide the rest. */
export const AMUX_DM_OWNER_SETTLEMENT_PENDING_SCAN = 12;
const SIBLINGS_READ = 8;
export const AMUX_DM_OWNER_SETTLEMENT_APPLIED_ACTION = "amux.dm_owner_settlement.applied";
export const AMUX_DM_OWNER_SETTLEMENT_HANDED_OFF_ACTION = "amux.dm_owner_settlement.handed_off";

type SealedTitle = { cardTitle: string; sourceSystem: string; sourceSnapshot: Prisma.JsonValue;
  v4TitleCiphertext: Uint8Array<ArrayBuffer> | null; v4TitleKeyId: string | null;
  v4TitleKeyVersion: number | null; v4TitleDigest: string | null; v4TitleDigestKeyId: string | null };

type PendingSettlement = SealedTitle & {
  settlementId: string; kind: AmuxDmOwnerSettlementKind; taskId: string; attemptId: string | null;
  bindingId: string | null; taskStatus: string; reason: string; taskLabel: string;
  role: string | null; grade: string | null;
  bodyCiphertext: Uint8Array | null; bodyKeyId: string | null; bodyKeyVersion: number | null;
  bodyDigest: string | null; bodyDigestKeyId: string | null;
  hasResult: boolean; resultIdeaId: string | null; ciphertext: Uint8Array | null; keyId: string | null;
  keyVersion: number | null; digest: string | null; digestKeyId: string | null;
  sourceSha256: string | null; bodyPurgedAt: Date | null; rejections: number;
};

type SiblingRow = SealedTitle & { forTaskId: string; id: string; label: string; status: string;
  waitsOnThis: boolean; total: number };

/**
 * One tick's read, one transaction: settlements whose Task moved, or whose
 * escalation a person resolved, are cancelled first; while the switch is on,
 * up to three new stopped Tasks are filed, and the open settlements with no
 * card yet are read with the rows their cards are opened from; the cards of
 * settlements no longer open that the relay has not closed come back to be
 * closed. At most seven statements past the boundary's own.
 */
export async function readAmuxDmOwnerSettlementSyncRows(tx: Prisma.TransactionClient,
  input: { enabled: boolean }) {
  await tx.$executeRaw`
    UPDATE "AmuxDmOwnerSettlement" s SET "state" = 'cancelled',
      "cancelReason" = CASE WHEN e."status" IN ('open', 'acknowledged') THEN 'task_moved'
        ELSE 'escalation_resolved' END,
      "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
    FROM "AmuxWorkItem" w, "AmuxHumanEscalation" e
    WHERE w."id" = s."taskId" AND e."id" = s."escalationId" AND s."state" = 'open'
      AND (w."status" <> s."taskStatus" OR w."archivedAt" IS NOT NULL
        OR e."status" NOT IN ('open', 'acknowledged')
        OR (SELECT x."id" FROM "AmuxExecutionAttempt" x WHERE x."taskId" = w."id"
          ORDER BY x."taskRevision" DESC, x."startedAt" DESC, x."id" DESC LIMIT 1)
          IS DISTINCT FROM s."attemptId")`;
  let pending: PendingSettlement[] = [];
  let siblings: SiblingRow[] = [];
  let pulls: Awaited<ReturnType<typeof readAmuxDmOwnerSettlementPullEvidence>> = [];
  if (input.enabled) {
    const found = await scanAmuxDmOwnerSettlementCandidates(tx, AMUX_DM_OWNER_SETTLEMENT_SYNC_LIMIT);
    const filed = found.flatMap((row) => {
      const kind = amuxDmOwnerSettlementKind({ openBinding: row.bindingId ? "review_draft" : null,
        engineeringInFlight: false });
      return kind ? [{ id: amuxDmOwnerSettlementId(row.escalationId), taskId: row.taskId,
        escalationId: row.escalationId, attemptId: row.attemptId, kind,
        taskStatus: row.taskStatus, bindingId: row.bindingId }] : [];
    });
    if (filed.length > 0) await tx.$executeRaw`
      INSERT INTO "AmuxDmOwnerSettlement" ("id", "taskId", "escalationId", "attemptId", "kind",
        "taskStatus", "bindingId", "updatedAt")
      SELECT x."id", x."taskId", x."escalationId", x."attemptId", x."kind", x."taskStatus",
        x."bindingId", (clock_timestamp() AT TIME ZONE 'UTC')
      FROM jsonb_to_recordset(${JSON.stringify(filed)}::jsonb) AS x("id" text, "taskId" text,
        "escalationId" text, "attemptId" text, "kind" text, "taskStatus" text, "bindingId" text)
      ON CONFLICT DO NOTHING`;
    pending = await tx.$queryRaw<PendingSettlement[]>`
      SELECT s."id" AS "settlementId", s."kind", s."taskId", s."attemptId", s."bindingId",
        s."taskStatus", e."reason", coalesce(w."displayKey", w."id") AS "taskLabel",
        w."taskRole" AS "role", w."executionGrade" AS "grade",
        w."title" AS "cardTitle", w."sourceSystem", w."sourceSnapshot",
        w."v4TitleCiphertext", w."v4TitleKeyId", w."v4TitleKeyVersion", w."v4TitleDigest",
        w."v4TitleDigestKeyId",
        w."v4BodyCiphertext" AS "bodyCiphertext", w."v4BodyKeyId" AS "bodyKeyId",
        w."v4BodyKeyVersion" AS "bodyKeyVersion", w."v4BodyDigest" AS "bodyDigest",
        w."v4BodyDigestKeyId" AS "bodyDigestKeyId",
        r."attemptId" IS NOT NULL AS "hasResult", r."ideaId" AS "resultIdeaId", r."ciphertext",
        r."keyId", r."keyVersion", r."digest", r."digestKeyId", r."sourceSha256", r."bodyPurgedAt",
        (SELECT count(*)::int FROM "AmuxV52ReviewRecord" v
          WHERE v."taskId" = s."taskId" AND v."verdict" = 'reject') AS "rejections"
      FROM "AmuxDmOwnerSettlement" s
      JOIN "AmuxWorkItem" w ON w."id" = s."taskId"
      JOIN "AmuxHumanEscalation" e ON e."id" = s."escalationId"
      LEFT JOIN "AmuxV22TaskResult" r ON r."attemptId" = s."attemptId" AND r."taskId" = s."taskId"
      WHERE s."state" = 'open' AND s."localCardId" IS NULL AND s."handoffAt" IS NULL
      ORDER BY s."createdAt", s."id"
      LIMIT ${AMUX_DM_OWNER_SETTLEMENT_PENDING_SCAN}`;
    const taskIds = [...new Set(pending.map((row) => row.taskId))];
    if (taskIds.length > 0) siblings = await tx.$queryRaw<SiblingRow[]>`
      SELECT * FROM (
        SELECT p."id" AS "forTaskId", o."id", coalesce(o."displayKey", o."id") AS "label",
          o."status", o."title" AS "cardTitle", o."sourceSystem", o."sourceSnapshot",
          o."v4TitleCiphertext", o."v4TitleKeyId", o."v4TitleKeyVersion", o."v4TitleDigest",
          o."v4TitleDigestKeyId",
          EXISTS (SELECT 1 FROM "AmuxWorkDependency" d
            WHERE d."taskId" = o."id" AND d."dependencyId" = p."id") AS "waitsOnThis",
          count(*) OVER (PARTITION BY p."id")::int AS "total",
          row_number() OVER (PARTITION BY p."id" ORDER BY EXISTS (SELECT 1 FROM "AmuxWorkDependency" d
            WHERE d."taskId" = o."id" AND d."dependencyId" = p."id") DESC,
            o."displayKey" NULLS LAST, o."id") AS "position"
        FROM "AmuxWorkItem" p
        JOIN "AmuxWorkItem" o ON o."id" <> p."id" AND o."archivedAt" IS NULL AND o."cardType" = 'task'
          AND ((p."parentStoryCardId" IS NOT NULL AND o."parentStoryCardId" = p."parentStoryCardId") OR
            (p."parentStoryCardId" IS NULL AND p."parentFeatureNodeId" IS NOT NULL AND
              o."parentStoryCardId" IS NULL AND o."parentFeatureNodeId" = p."parentFeatureNodeId"))
        WHERE p."id" = ANY(${taskIds})
      ) x WHERE x."position" <= ${SIBLINGS_READ}
      ORDER BY x."forTaskId", x."position"`;
    const bindingIds = pending.flatMap((row) => row.bindingId ? [row.bindingId] : []);
    pulls = await readAmuxDmOwnerSettlementPullEvidence(tx, bindingIds);
  }
  const closing = await tx.$queryRaw<Array<{ questionId: string; cardId: string }>>`
    SELECT s."id" AS "questionId", s."localCardId" AS "cardId"
    FROM "AmuxDmOwnerSettlement" s
    WHERE (s."state" <> 'open' OR s."handoffAt" IS NOT NULL) AND s."localCardId" IS NOT NULL
      AND s."localCardClosedAt" IS NULL
    ORDER BY s."updatedAt", s."id"
    LIMIT ${AMUX_DM_OWNER_SETTLEMENT_SYNC_LIMIT}`;
  return { pending, siblings, pulls, closing };
}

const sealedTitle = (row: SealedTitle & { id: string }) => readAmuxCardTitle({ id: row.id,
  title: row.cardTitle, sourceSystem: row.sourceSystem, sourceSnapshot: row.sourceSnapshot,
  v4TitleCiphertext: row.v4TitleCiphertext, v4TitleKeyId: row.v4TitleKeyId,
  v4TitleKeyVersion: row.v4TitleKeyVersion, v4TitleDigest: row.v4TitleDigest,
  v4TitleDigestKeyId: row.v4TitleDigestKeyId }).catch(() => null);

/**
 * The cards the relay files, opened outside the DB transaction. A settlement
 * whose evidence cannot be read -- its completion criteria, or a run result
 * that exists but cannot be opened -- or does not fit a card whole, is not put
 * to the Decision Maker and comes back in `unfilable`, to be handed to the
 * person, so it never holds back the ones behind it.
 */
export async function openAmuxDmOwnerSettlementCards(rows: Awaited<ReturnType<
  typeof readAmuxDmOwnerSettlementSyncRows>>) {
  const cards = [];
  const unfilable: string[] = [];
  for (const row of rows.pending) {
    if (cards.length >= AMUX_DM_OWNER_SETTLEMENT_SYNC_LIMIT) break;
    let card: ReturnType<typeof amuxDmOwnerSettlementCard> = null;
    try {
      const ideaId = v22TaskResultIdeaId(row.sourceSnapshot);
      const criteria = ideaId ? await openCompletionCriteria({ ideaId, taskId: row.taskId,
        bodyCiphertext: row.bodyCiphertext, bodyKeyId: row.bodyKeyId,
        bodyKeyVersion: row.bodyKeyVersion, bodyDigest: row.bodyDigest,
        bodyDigestKeyId: row.bodyDigestKeyId }) : null;
      let findings: string | null = null;
      let readable = criteria !== null;
      if (readable && row.hasResult) {
        const text = row.attemptId && row.resultIdeaId && row.digest && row.digestKeyId &&
          row.sourceSha256 ? await openAmuxV22TaskResultRow(row.attemptId, { ideaId: row.resultIdeaId,
            ciphertext: row.ciphertext, keyId: row.keyId, keyVersion: row.keyVersion,
            digest: row.digest, digestKeyId: row.digestKeyId, bodyPurgedAt: row.bodyPurgedAt,
            sourceSha256: row.sourceSha256 }) : null;
        // A result that was kept and is gone or unreadable now is missing evidence.
        if (text === null) readable = false;
        else findings = parseAmuxV22Conclusion(text)?.findings ?? text;
      }
      if (readable && criteria) {
        const mine = rows.siblings.filter((sibling) => sibling.forTaskId === row.taskId);
        const titles = await Promise.all([sealedTitle({ ...row, id: row.taskId }),
          ...mine.map((sibling) => sealedTitle(sibling))]);
        const pull = row.bindingId ? rows.pulls.find((entry) => entry.bindingId === row.bindingId) : null;
        card = amuxDmOwnerSettlementCard({ settlementId: row.settlementId, kind: row.kind,
          taskLabel: row.taskLabel, title: titles[0] ?? null, role: row.role, grade: row.grade,
          taskStatus: row.taskStatus, reason: row.reason, criteria, findings,
          rejections: row.rejections,
          siblings: mine.map((sibling, index) => ({ label: sibling.label, title: titles[index + 1] ?? null,
            status: sibling.status, waitsOnThis: sibling.waitsOnThis })),
          siblingTotal: mine[0]?.total ?? 0,
          pull: row.kind === "t2_pr" ? pull ? { number: pull.prNumber, patch: pull.patchBody } : null : null });
      }
    } catch { card = null; }
    if (card) cards.push(card);
    else unfilable.push(row.settlementId);
  }
  return { cards, unfilable };
}

/** Hands settlements the relay could not file to the person, once each, with
 * one system audit: the open escalation already waits for them. */
export async function recordAmuxDmOwnerSettlementsUnfilable(tx: Prisma.TransactionClient,
  input: { settlementIds: string[]; now: Date }) {
  const ids = input.settlementIds.filter(isAmuxDmOwnerSettlementId);
  if (ids.length === 0) return { recorded: 0 };
  await takeAuditChainLock(tx);
  const at = input.now.toISOString();
  const changed = await tx.$queryRaw<Array<{ id: string }>>`
    UPDATE "AmuxDmOwnerSettlement" SET "handoffReason" = 'evidence_unavailable',
      "handoffAt" = (${at}::timestamptz AT TIME ZONE 'UTC'),
      "updatedAt" = (${at}::timestamptz AT TIME ZONE 'UTC')
    WHERE "id" = ANY(${ids}) AND "state" = 'open' AND "handoffAt" IS NULL
    RETURNING "id"`;
  const handed = changed.map((row) => row.id).sort();
  if (handed.length > 0)
    await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
      action: AMUX_DM_OWNER_SETTLEMENT_HANDED_OFF_ACTION, targetType: "AmuxDmOwnerSettlement",
      targetId: handed[0]!,
      summary: "Left stopped v22 Tasks to a person: their evidence could not be read or did not fit a card whole.",
      metadata: { settlementIds: handed, reason: "evidence_unavailable" } });
  return { recorded: handed.length };
}

/** Names the local card of a settlement, once. Null when no such settlement exists. */
export async function recordAmuxDmOwnerSettlementLocalCard(tx: Prisma.TransactionClient,
  input: { questionId: string; cardId: string }) {
  if (!isAmuxDmOwnerSettlementId(input.questionId) || !CARD_ID.test(input.cardId)) return null;
  const changed = await tx.$executeRaw`
    UPDATE "AmuxDmOwnerSettlement" SET "localCardId" = ${input.cardId},
      "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
    WHERE "id" = ${input.questionId} AND "localCardId" IS NULL`;
  if (changed === 1) return { recorded: true as const };
  const rows = await tx.$queryRaw<Array<{ localCardId: string | null }>>`
    SELECT "localCardId" FROM "AmuxDmOwnerSettlement" WHERE "id" = ${input.questionId}`;
  if (rows.length === 0) return null;
  if (rows[0]!.localCardId !== input.cardId) throw new BoardImportError("card_conflict", 409);
  return { recorded: true as const };
}

/** Records that the relay closed a settlement's local card, once. Null when no such settlement exists. */
export async function recordAmuxDmOwnerSettlementLocalCardClosed(tx: Prisma.TransactionClient,
  input: { questionId: string; cardId: string; now: Date }) {
  if (!isAmuxDmOwnerSettlementId(input.questionId) || !CARD_ID.test(input.cardId)) return null;
  const at = input.now.toISOString();
  const changed = await tx.$executeRaw`
    UPDATE "AmuxDmOwnerSettlement" SET "localCardClosedAt" = (${at}::timestamptz AT TIME ZONE 'UTC'),
      "updatedAt" = (${at}::timestamptz AT TIME ZONE 'UTC')
    WHERE "id" = ${input.questionId} AND "localCardId" = ${input.cardId}
      AND ("state" <> 'open' OR "handoffAt" IS NOT NULL) AND "localCardClosedAt" IS NULL`;
  if (changed === 1) return { recorded: true as const };
  const rows = await tx.$queryRaw<Array<{ localCardId: string | null; closed: boolean }>>`
    SELECT "localCardId", "localCardClosedAt" IS NOT NULL AS "closed"
    FROM "AmuxDmOwnerSettlement" WHERE "id" = ${input.questionId}`;
  if (rows.length === 0) return null;
  if (rows[0]!.localCardId !== input.cardId || !rows[0]!.closed)
    throw new BoardImportError("not_closable", 409);
  return { recorded: true as const };
}

/** The open settlement of a local card, for the walk and the approver; one
 * handed to the person is not the Decision Maker's any more. One statement. */
export async function readOpenAmuxDmOwnerSettlementOfCard(tx: Prisma.TransactionClient,
  cardId: string) {
  const rows = await tx.$queryRaw<Array<{ id: string; kind: AmuxDmOwnerSettlementKind }>>`
    SELECT "id", "kind" FROM "AmuxDmOwnerSettlement"
    WHERE "localCardId" = ${cardId} AND "state" = 'open' AND "handoffAt" IS NULL LIMIT 1`;
  return rows[0] ?? null;
}

type LockedSettlement = AmuxStoppedCardLockedFacts & {
  settlementId: string; state: string; handedOff: boolean; kind: AmuxDmOwnerSettlementKind;
  taskId: string; escalationId: string; attemptId: string | null; bindingId: string | null;
  taskStatus: string; escalationOpen: boolean;
  lastAttempt: { id: string; attemptNumber: number; endedAt: string | null; outcome: string | null;
    reason: string | null } | null;
};

/** The settlement and its card, locked without waiting (a worker's writers
 * lock the card and then the chain), with the facts a settlement is judged on. */
async function lockSettlement(tx: Prisma.TransactionClient, settlementId: string) {
  const rows = await tx.$queryRaw<LockedSettlement[]>`
    SELECT s."id" AS "settlementId", s."state", s."handoffAt" IS NOT NULL AS "handedOff", s."kind",
      s."taskId", s."escalationId", s."attemptId", s."bindingId", s."taskStatus",
      w."id", w."displayKey", w."sourceSystem", w."cardType", w."status", w."revision", w."archivedAt",
      w."v22ReceiptId"::text AS "v22ReceiptId", w."taskRole", w."executionGrade",
      EXISTS (SELECT 1 FROM "AmuxWorkDelivery" d WHERE d."taskId" = w."id"
        AND d."status" IN ('queued', 'leased')) AS "activeDelivery",
      EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" a WHERE a."taskId" = w."id"
        AND a."endedAt" IS NULL) AS "liveAttempt",
      EXISTS (SELECT 1 FROM "AmuxHumanEscalation" e WHERE e."taskId" = w."id"
        AND e."status" IN ('open', 'acknowledged')) AS "openEscalation",
      EXISTS (SELECT 1 FROM "AmuxHumanEscalation" e WHERE e."id" = s."escalationId"
        AND e."status" IN ('open', 'acknowledged')) AS "escalationOpen",
      (SELECT json_build_object('id', a."id", 'attemptNumber', a."attemptNumber",
          'endedAt', a."endedAt", 'outcome', a."outcome", 'reason', a."reason")
        FROM "AmuxExecutionAttempt" a WHERE a."taskId" = w."id"
        ORDER BY a."taskRevision" DESC, a."startedAt" DESC, a."id" DESC LIMIT 1) AS "lastAttempt"
    FROM "AmuxDmOwnerSettlement" s
    JOIN "AmuxWorkItem" w ON w."id" = s."taskId"
    WHERE s."id" = ${settlementId}
    FOR UPDATE OF s, w NOWAIT`;
  return rows[0] ?? null;
}

export type AmuxDmOwnerSettlementOutcome =
  | "handed_off" | "cancelled" | "todo" | "done" | "closed" | "remade" | "approved";

/**
 * Applies a Decision Maker answer to a settlement: the audit chain lock, the
 * kill switch under it, then the settlement and its card locked together. A
 * Task that moved (its status, a new run, an archive, something running) or an
 * escalation a person resolved cancels the settlement instead. retry returns
 * the Task to todo within its attempt budget (a spent budget leaves it to the
 * person); complete and close are the owner's settlement done by the system
 * (legacyCardSystemService.ts); remake closes the card and the unstarted cards
 * waiting on it and names the idea the caller already filed for them; approve
 * records the pull request's verified head and diff digest and changes nothing
 * else. Every write past the judgment is audited once through the chain writer.
 * At most ten statements: lock, switches, the locked rows, the approval read
 * or the card and escalation writes, the settlement, canonical audit 4.
 */
export async function applyAmuxDmOwnerSettlementDecision(tx: Prisma.TransactionClient, input: {
  settlementId: string; answer: AmuxDmOwnerSettlementAnswer; source: "dm" | "dm_confirmed";
  requestId: string; now: Date;
  /** A remake's idea, filed before this transaction, or why it could not be. */
  remake?: { ideaId: string } | { refused: string };
}): Promise<{ applied: boolean; outcome: AmuxDmOwnerSettlementOutcome | null }> {
  await takeAuditChainLock(tx);
  let killSwitch: boolean | null;
  try { killSwitch = (await readDecisionMakerSwitchesOrThrow(tx)).killSwitch; }
  catch { killSwitch = null; }
  if (killSwitch !== false) return { applied: false, outcome: null };
  const row = await lockSettlement(tx, input.settlementId);
  if (!row || row.state !== "open") return { applied: false, outcome: null };
  // Handed to the person: no later Decision Maker answer decides it.
  if (row.handedOff) return { applied: false, outcome: "handed_off" };
  const at = input.now.toISOString();
  const cancel = async (reason: string) => {
    await tx.$executeRaw`
      UPDATE "AmuxDmOwnerSettlement" SET "state" = 'cancelled', "cancelReason" = ${reason},
        "remakeIdeaId" = ${input.remake && "ideaId" in input.remake ? input.remake.ideaId : null},
        "updatedAt" = (${at}::timestamptz AT TIME ZONE 'UTC')
      WHERE "id" = ${row.settlementId} AND "state" = 'open'`;
    return { applied: true, outcome: "cancelled" as const };
  };
  const handOff = async (reason: string) => {
    const handed = await tx.$executeRaw`
      UPDATE "AmuxDmOwnerSettlement" SET "handoffReason" = ${reason},
        "handoffAt" = (${at}::timestamptz AT TIME ZONE 'UTC'),
        "updatedAt" = (${at}::timestamptz AT TIME ZONE 'UTC')
      WHERE "id" = ${row.settlementId} AND "state" = 'open' AND "handoffAt" IS NULL`;
    if (handed === 1)
      await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
        action: AMUX_DM_OWNER_SETTLEMENT_HANDED_OFF_ACTION, targetType: "AmuxDmOwnerSettlement",
        targetId: row.settlementId,
        summary: "Left a stopped v22 Task to a person: the Decision Maker's answer could not be applied.",
        metadata: { taskId: row.taskId, requestId: input.requestId, reason,
          decision: input.answer.decision, source: input.source } });
    return { applied: false, outcome: "handed_off" as const };
  };
  if (row.status !== row.taskStatus || row.archivedAt !== null || !row.escalationOpen ||
      (row.lastAttempt?.id ?? null) !== row.attemptId || row.activeDelivery || row.liveAttempt ||
      row.sourceSystem !== "admin-idea-v4")
    return cancel(row.escalationOpen ? "task_moved" : "escalation_resolved");
  const { decision } = input.answer;
  if (!(AMUX_DM_OWNER_SETTLEMENT_DECISIONS[row.kind] as readonly string[]).includes(decision))
    return handOff("answer_unreadable");
  const audit = (summary: string, metadata: Record<string, unknown> = {}) => ({
    action: AMUX_DM_OWNER_SETTLEMENT_APPLIED_ACTION, summary,
    metadata: { settlementId: row.settlementId, kind: row.kind, decision, source: input.source,
      requestId: input.requestId, escalationId: row.escalationId, ...metadata } });
  const record = (extra: { approvedHeadSha?: string; approvedDiffDigest?: string;
    remakeIdeaId?: string } = {}) => tx.$executeRaw`
    UPDATE "AmuxDmOwnerSettlement" SET "state" = 'applied', "decision" = ${decision},
      "answerSource" = ${input.source}, "requestId" = ${input.requestId},
      "approvedHeadSha" = ${extra.approvedHeadSha ?? null},
      "approvedDiffDigest" = ${extra.approvedDiffDigest ?? null},
      "remakeIdeaId" = ${extra.remakeIdeaId ?? null},
      "decidedAt" = (${at}::timestamptz AT TIME ZONE 'UTC'),
      "updatedAt" = (${at}::timestamptz AT TIME ZONE 'UTC')
    WHERE "id" = ${row.settlementId} AND "state" = 'open' AND "handoffAt" IS NULL`;
  const resolution = `Decision Maker settlement (${input.source}): ${decision}`;

  if (decision === "approve") {
    const facts = row.bindingId && row.attemptId ?
      await readAmuxDmOwnerSettlementApprovalFacts(tx, { bindingId: row.bindingId, attemptId: row.attemptId }) :
      null;
    // The pull request it was asked about is no longer the open one of this run.
    if (!facts) return cancel("binding_moved");
    await record({ approvedHeadSha: facts.verifiedHeadSha, approvedDiffDigest: facts.diffDigest });
    const entry = audit("Recorded a Decision Maker approval of a v22 Task's review pull request for the merge lane; nothing else changed.",
      { bindingId: row.bindingId, approvedHeadSha: facts.verifiedHeadSha,
        approvedDiffDigest: facts.diffDigest, taskStatus: row.status, revision: row.revision });
    await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR, action: entry.action,
      targetType: "AmuxWorkItem", targetId: row.taskId, summary: entry.summary, metadata: entry.metadata });
    return { applied: true, outcome: "approved" };
  }

  if (decision === "retry") {
    if (settlementDestinationForBudget({ requested_status: "todo",
      attempt_number: row.lastAttempt?.attemptNumber ?? null }).to_status !== "todo")
      return handOff("attempt_budget_spent");
    const moved = await tx.amuxWorkItem.updateMany({
      where: { id: row.taskId, revision: row.revision, status: row.status, archivedAt: null },
      data: { status: "todo", owner: null, claimedAt: null, reviewPrNumber: null,
        revision: { increment: 1 } } });
    if (moved.count !== 1) return cancel("task_moved");
    const resolved = await tx.amuxHumanEscalation.updateMany({ where: { taskId: row.taskId,
      status: { in: ["open", "acknowledged"] } }, data: { status: "resolved",
      resolutionOutcome: "retry", resolution, resolvedById: AMUX_DM_OWNER_SETTLEMENT_RESOLVER,
      resolvedByEmail: null, resolvedAt: input.now } });
    await record();
    const entry = audit("Applied a Decision Maker settlement to a stopped v22 Task: it runs again.",
      { displayKey: row.displayKey, fromStatus: row.status, previousRevision: row.revision,
        toStatus: "todo", escalationsResolved: resolved.count });
    await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR, action: entry.action,
      targetType: "AmuxWorkItem", targetId: row.taskId, summary: entry.summary, metadata: entry.metadata });
    return { applied: true, outcome: "todo" };
  }

  if (decision === "complete") {
    const done = await completeAmuxStoppedCardAsSystemWithin(tx, { card: row, now: input.now, resolution,
      audit: audit("Applied a Decision Maker settlement to a stopped v22 Task: it is done.") });
    if (done.outcome !== "completed") return handOff("complete_refused");
    await record();
    return { applied: true, outcome: "done" };
  }

  // close, or remake: the card, and for a remake the unstarted cards waiting on it.
  const remake = decision === "remake";
  if (remake && !(input.remake && "ideaId" in input.remake))
    return handOff(input.remake && "refused" in input.remake ? "remake_refused" : "remake_unavailable");
  const ideaId = remake && input.remake && "ideaId" in input.remake ? input.remake.ideaId : null;
  const closed = await closeAmuxStoppedCardAsSystemWithin(tx, { card: row, now: input.now,
    resolution: ideaId ? `${resolution}; remade as AMUX idea ${ideaId}` : resolution, waitingToo: remake,
    audit: audit(remake ? "Applied a Decision Maker settlement to a stopped v22 Task: it and the unstarted cards waiting on it were closed for one new idea." :
      "Applied a Decision Maker settlement to a stopped v22 Task: its card was closed.",
    ideaId ? { remakeIdeaId: ideaId } : {}) });
  if (closed.outcome !== "closed") return handOff(`${decision}_refused`);
  await record(ideaId ? { remakeIdeaId: ideaId } : {});
  return { applied: true, outcome: remake ? "remade" : "closed" };
}

/** An answer that is none of the settlement's words changes nothing; the
 * settlement stays with the person's escalation, and this says why, once. */
export async function recordAmuxDmOwnerSettlementHandoff(tx: Prisma.TransactionClient,
  input: { settlementId: string; requestId: string; reason: string; now: Date }) {
  await takeAuditChainLock(tx);
  const at = input.now.toISOString();
  const changed = await tx.$executeRaw`
    UPDATE "AmuxDmOwnerSettlement" SET "handoffReason" = ${input.reason},
      "handoffAt" = (${at}::timestamptz AT TIME ZONE 'UTC'),
      "updatedAt" = (${at}::timestamptz AT TIME ZONE 'UTC')
    WHERE "id" = ${input.settlementId} AND "state" = 'open' AND "handoffAt" IS NULL`;
  if (changed !== 1) return { recorded: false as const };
  await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
    action: AMUX_DM_OWNER_SETTLEMENT_HANDED_OFF_ACTION, targetType: "AmuxDmOwnerSettlement",
    targetId: input.settlementId,
    summary: "Left a stopped v22 Task to a person: the Decision Maker's answer did not decide it.",
    metadata: { requestId: input.requestId, reason: input.reason } });
  return { recorded: true as const };
}
