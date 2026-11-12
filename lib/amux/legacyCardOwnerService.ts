import "server-only";

import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { prisma } from "@/lib/prisma";
import { inspectAmuxIdeaInput } from "./ideaInputCore.ts";
import {
  amuxLegacyCardCloseRefusal, amuxLegacyCardIdeaText, amuxLegacyCardKind, amuxOwnerCompleteRefusal,
  type AmuxLegacyCardCloseRefusal, type AmuxLegacyCardFacts, type AmuxLegacyCardKind,
  type AmuxOwnerCompleteRefusal,
} from "./legacyCardCore.ts";
import { amuxDatabaseDiagnosticCode } from "./readFailureCore.ts";
import { AMUX_V22_USAGE_ACCEPTED_ACTION, amuxV22TaskUnknownUsageAttemptIds,
  recordAmuxV22UsageAcceptances } from "./v22AttemptUsageAcceptance.ts";

/**
 * The owner's actions on a card that stopped -- a legacy WORKBOARD card, a
 * pre-v22 Task, or any v22 Task stopped in blocked or review
 * (legacyCardCore.ts): remake it as a new owner idea, close it, and, for a
 * stopped v22 Task, complete it as done. Closing archives the card --
 * `archivedAt` and `revision` change, the status and every ledger stay -- and
 * resolves its open escalations, so it leaves the board and the owner queue.
 * Completing moves it to done on the database clock and resolves its
 * escalations as approved. One person's audit entry through the administrator
 * writer, in the same transaction. Undo of a close: `archivedAt = NULL`.
 *
 * A stopped v22 Task's ended runs whose CLI usage is unknown are accepted as
 * unknown by the same act (owner decision 2026-11-10 gives the owner that
 * acceptance; here it rides the settlement), so a settled card no longer holds
 * its worker in the usage gate. No cost changes: the reserved caps stay spent.
 */

export class AmuxLegacyCardOwnerError extends Error {
  constructor(readonly code: "forbidden" | "busy") {
    super(code);
    this.name = "AmuxLegacyCardOwnerError";
  }
}

const LEGACY_CARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

type CardFacts = AmuxLegacyCardFacts & {
  id: string; displayKey: string | null; revision: number; archivedAt: Date | null;
  activeDelivery: boolean; liveAttempt: boolean; openEscalation: boolean;
};

/**
 * The facts a close is judged on, in one statement; `lock` takes the card row
 * without waiting. The last attempt is ordered as lockRecoveryTask orders it.
 */
async function readCardFacts(client: Prisma.TransactionClient | typeof prisma, taskId: string, lock: boolean) {
  const rows = lock ? await client.$queryRaw<CardFacts[]>`
      SELECT w."id", w."displayKey", w."sourceSystem", w."cardType", w."status", w."revision",
        w."archivedAt", w."v22ReceiptId"::text AS "v22ReceiptId", w."taskRole", w."executionGrade",
        EXISTS (SELECT 1 FROM "AmuxWorkDelivery" d WHERE d."taskId" = w."id"
          AND d."status" IN ('queued', 'leased')) AS "activeDelivery",
        EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" a WHERE a."taskId" = w."id"
          AND a."endedAt" IS NULL) AS "liveAttempt",
        EXISTS (SELECT 1 FROM "AmuxHumanEscalation" e WHERE e."taskId" = w."id"
          AND e."status" IN ('open', 'acknowledged')) AS "openEscalation",
        (SELECT json_build_object('endedAt', a."endedAt", 'outcome', a."outcome", 'reason', a."reason")
          FROM "AmuxExecutionAttempt" a WHERE a."taskId" = w."id"
          ORDER BY a."taskRevision" DESC, a."startedAt" DESC, a."id" DESC LIMIT 1) AS "lastAttempt"
      FROM "AmuxWorkItem" w WHERE w."id" = ${taskId}
      FOR UPDATE OF w NOWAIT` :
    await client.$queryRaw<CardFacts[]>`
      SELECT w."id", w."displayKey", w."sourceSystem", w."cardType", w."status", w."revision",
        w."archivedAt", w."v22ReceiptId"::text AS "v22ReceiptId", w."taskRole", w."executionGrade",
        EXISTS (SELECT 1 FROM "AmuxWorkDelivery" d WHERE d."taskId" = w."id"
          AND d."status" IN ('queued', 'leased')) AS "activeDelivery",
        EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" a WHERE a."taskId" = w."id"
          AND a."endedAt" IS NULL) AS "liveAttempt",
        EXISTS (SELECT 1 FROM "AmuxHumanEscalation" e WHERE e."taskId" = w."id"
          AND e."status" IN ('open', 'acknowledged')) AS "openEscalation",
        (SELECT json_build_object('endedAt', a."endedAt", 'outcome', a."outcome", 'reason', a."reason")
          FROM "AmuxExecutionAttempt" a WHERE a."taskId" = w."id"
          ORDER BY a."taskRevision" DESC, a."startedAt" DESC, a."id" DESC LIMIT 1) AS "lastAttempt"
      FROM "AmuxWorkItem" w WHERE w."id" = ${taskId}`;
  return rows[0] ?? null;
}

export type AmuxLegacyCardView = {
  /** Which kind of stopped card this is (legacyCardCore.ts). */
  kind: AmuxLegacyCardKind;
  /** Null when the owner can complete it as done now; only a stopped v22 Task ever can. */
  completeRefusal: AmuxOwnerCompleteRefusal | null;
  /**
   * Null when it can be closed now. `changed`: the card moved on between the
   * body this view was built from and its facts, so nothing is saved from it.
   */
  closeRefusal: Exclude<AmuxLegacyCardCloseRefusal, "not_legacy"> | null;
  /** Archived already: a close only resolves its open escalation. */
  alreadyArchived: boolean;
  /** The idea a recreate would save, or why it would refuse. */
  idea: { state: "ready"; title: string; text: string; truncated: boolean } |
    { state: "refused"; code: string };
};

/**
 * What the card detail shows for a card the owner can only remake: its kind,
 * whether it closes now, and the idea a recreate would save, checked by the
 * same input gate the save uses. `body` and `brief` are the card's readable
 * assigned work (a v4 Task's decrypted body). Null for any other card. Read only.
 */
export async function readAmuxLegacyCardView(card: {
  id: string; revision: number; displayKey: string | null; sourceSystem: string | null;
  title: string | null; body: string | null; brief: string | null;
}): Promise<AmuxLegacyCardView | null> {
  if (card.sourceSystem !== "admin-idea-v4" && card.sourceSystem !== "tomverse_private_workboard") return null;
  const facts = await readCardFacts(prisma, card.id, false);
  const kind = facts ? amuxLegacyCardKind(facts) : null;
  if (!facts || !kind) return null;
  const refusal = amuxLegacyCardCloseRefusal(facts, card.revision);
  return { kind,
    completeRefusal: amuxOwnerCompleteRefusal(facts, card.revision),
    closeRefusal: refusal === "not_legacy" ? null : refusal,
    alreadyArchived: facts.archivedAt !== null,
    idea: legacyIdea({ id: card.id, displayKey: card.displayKey, title: card.title, description: card.body,
      executionBrief: card.brief, kind, taskRole: facts.taskRole }) };
}

/** The idea text of a card and the input gate's verdict on it. */
function legacyIdea(card: Parameters<typeof amuxLegacyCardIdeaText>[0]): AmuxLegacyCardView["idea"] {
  const built = amuxLegacyCardIdeaText(card);
  if (!built.ok) return { state: "refused", code: built.code };
  const inspected = inspectAmuxIdeaInput(JSON.stringify({ version: 1, idea: built.text,
    repositories: [], pullRequests: [] }));
  if (!inspected.ok) return { state: "refused", code: inspected.code };
  return { state: "ready", title: built.title, text: built.text, truncated: built.truncated };
}

export type AmuxLegacyCardCloseResult =
  | { outcome: "closed"; archivedAt: string; alreadyArchived: boolean; escalationsResolved: number; auditId: string }
  | { outcome: "not_found" }
  | { outcome: "refused"; reason: AmuxLegacyCardCloseRefusal };

export type AmuxOwnerCompleteResult =
  | { outcome: "completed"; revision: number; escalationsResolved: number; auditId: string }
  | { outcome: "not_found" }
  | { outcome: "refused"; reason: AmuxOwnerCompleteRefusal };

/** Owner role and recent re-authentication, before anything is read. */
export async function assertAmuxLegacyCardOwner(session: Session) {
  if (!session.user?.id || !isAdminSession(session) || getAdminRole(session) !== "owner")
    throw new AmuxLegacyCardOwnerError("forbidden");
  await assertRecentAdminAuthentication(session);
}

const KIND_LABELS: Record<AmuxLegacyCardKind, string> = {
  workboard: "a legacy WORKBOARD card",
  pre_v22_task: "a pre-v22 Task with no recovery path",
  stopped_task: "a stopped v22 Task",
};

type Settlement = { session: Session; request: Request; taskId: string; revision: number };

async function settlementClock(tx: Prisma.TransactionClient): Promise<Date> {
  const clock = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT set_config('statement_timeout', '5000', true),
           set_config('idle_in_transaction_session_timeout', '10000', true),
           date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "now"`;
  const now = clock[0]?.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("clock_unavailable");
  return now;
}

/**
 * The owner's settlement accepts that the card's ended runs with unknown CLI
 * usage stay unknown: one audit entry per attempt, as the owner's own
 * acceptance writes it (v22AttemptUsageAcceptance.ts), bound by the database.
 */
async function acceptUnknownUsage(tx: Prisma.TransactionClient, input: Settlement & {
  actorUserId: string; now: Date; via: "owner_close" | "owner_complete" }): Promise<string[]> {
  const attemptIds = await amuxV22TaskUnknownUsageAttemptIds(tx, input.taskId);
  for (const attemptId of attemptIds) {
    const auditLogId = await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: AMUX_V22_USAGE_ACCEPTED_ACTION, targetType: "AmuxExecutionAttempt", targetId: attemptId,
      summary: "Accepted that one ended v22 attempt's CLI usage stays unknown; its reserved cap and cost are unchanged.",
      metadata: { taskId: input.taskId, attemptId, via: input.via, costChanged: false } });
    await recordAmuxV22UsageAcceptances(tx, { taskId: input.taskId, attemptIds: [attemptId],
      source: "owner_accept", acceptedByUserId: input.actorUserId, auditLogId, now: input.now });
  }
  return attemptIds;
}

/**
 * Closes one stopped card inside the caller's transaction: the audit chain
 * lock first, the card row without waiting (a worker's writers lock the card
 * and then the chain, so waiting here would deadlock with them), the judgment
 * again under the lock, then the archive, the escalations and the audit entry.
 * `ideaId` names the idea a recreate saved for it.
 */
export async function closeAmuxLegacyCardWithin(tx: Prisma.TransactionClient,
  input: Settlement & { ideaId: string | null }): Promise<AmuxLegacyCardCloseResult> {
  const actorUserId = input.session.user!.id!;
  const now = await settlementClock(tx);
  await takeAuditChainLock(tx);
  const card = await readCardFacts(tx, input.taskId, true);
  if (!card) return { outcome: "not_found" as const };
  const refusal = amuxLegacyCardCloseRefusal(card, input.revision);
  if (refusal) return { outcome: "refused" as const, reason: refusal };
  // A card archived elsewhere keeps its archive and revision; only its open
  // escalation is resolved (an archived card is no longer in the owner queue).
  const alreadyArchived = card.archivedAt !== null;
  if (!alreadyArchived) {
    const moved = await tx.amuxWorkItem.updateMany({
      where: { id: card.id, revision: card.revision, archivedAt: null },
      data: { archivedAt: now, revision: { increment: 1 } },
    });
    if (moved.count !== 1) return { outcome: "refused" as const, reason: "changed" as const };
  }
  const kind = amuxLegacyCardKind(card)!;
  const label = KIND_LABELS[kind];
  const closedAs = alreadyArchived ? `Resolved on ${label} that was already archived` : `Closed as ${label}`;
  const resolution = input.ideaId ?
    `${closedAs}; recreated as AMUX idea ${input.ideaId}.` :
    `${closedAs} by the owner.`;
  const resolved = await tx.amuxHumanEscalation.updateMany({
    where: { taskId: card.id, status: { in: ["open", "acknowledged"] } },
    data: { status: "resolved", resolutionOutcome: "block", resolution,
      resolvedById: actorUserId, resolvedByEmail: input.session.user?.email ?? null, resolvedAt: now },
  });
  // None left to resolve: another path resolved it first, so nothing is written.
  if (alreadyArchived && resolved.count === 0) return { outcome: "refused" as const, reason: "already_closed" as const };
  const acceptedUsage = kind === "stopped_task" ?
    await acceptUnknownUsage(tx, { ...input, actorUserId, now, via: "owner_close" }) : [];
  const archivedAt = (card.archivedAt ?? now).toISOString();
  const auditId = await writeAdminAuditLog({ tx, session: input.session, request: input.request,
    action: "amux.legacy_card.closed", targetType: "AmuxWorkItem", targetId: card.id,
    summary: `${alreadyArchived ? `Resolved the open escalation of archived ${label.replace(/^an? /, "")}` :
      `Closed ${label}`}${input.ideaId ? " after recreating it as a new AMUX idea" : ""}.`,
    metadata: { kind, displayKey: card.displayKey, status: card.status, revision: card.revision,
      archivedAt, alreadyArchived, escalationsResolved: resolved.count,
      ...(acceptedUsage.length ? { acceptedUnknownUsageAttemptIds: acceptedUsage } : {}),
      ...(input.ideaId ? { recreatedIdeaId: input.ideaId } : {}) } });
  return { outcome: "closed" as const, archivedAt, alreadyArchived, escalationsResolved: resolved.count, auditId };
}

/**
 * Completes one stopped v22 Task as done inside the caller's transaction
 * (owner decision 2026-11-12): the same locks and judgment as a close, then
 * the card to done -- terminal on the database clock, as an approved review
 * makes it (reviewApproval.ts) -- its escalations resolved as approved, its
 * unknown usage accepted, and the audit entry carrying the owner's reason.
 */
export async function completeAmuxStoppedCardWithin(tx: Prisma.TransactionClient,
  input: Settlement & { reason: string }): Promise<AmuxOwnerCompleteResult> {
  const actorUserId = input.session.user!.id!;
  const now = await settlementClock(tx);
  await takeAuditChainLock(tx);
  const card = await readCardFacts(tx, input.taskId, true);
  if (!card) return { outcome: "not_found" as const };
  const refusal = amuxOwnerCompleteRefusal(card, input.revision);
  if (refusal) return { outcome: "refused" as const, reason: refusal };
  const moved = await tx.amuxWorkItem.updateMany({
    where: { id: card.id, revision: card.revision, archivedAt: null, status: { in: ["blocked", "review"] } },
    data: { status: "done", v4TerminalAt: now, owner: null, claimedAt: null, revision: { increment: 1 } },
  });
  if (moved.count !== 1) return { outcome: "refused" as const, reason: "changed" as const };
  const resolved = await tx.amuxHumanEscalation.updateMany({
    where: { taskId: card.id, status: { in: ["open", "acknowledged"] } },
    data: { status: "resolved", resolutionOutcome: "approve",
      resolution: `Completed by the owner: ${input.reason}`,
      resolvedById: actorUserId, resolvedByEmail: input.session.user?.email ?? null, resolvedAt: now },
  });
  const acceptedUsage = await acceptUnknownUsage(tx, { ...input, actorUserId, now, via: "owner_complete" });
  const auditId = await writeAdminAuditLog({ tx, session: input.session, request: input.request,
    action: "amux.owner_settlement.completed", targetType: "AmuxWorkItem", targetId: card.id,
    summary: "Completed a stopped AMUX v22 Task as done by the owner's own judgment.",
    metadata: { displayKey: card.displayKey, fromStatus: card.status, previousRevision: card.revision,
      nextRevision: card.revision + 1, reason: input.reason, escalationsResolved: resolved.count,
      lastAttempt: card.lastAttempt ? { outcome: card.lastAttempt.outcome, reason: card.lastAttempt.reason } : null,
      ...(acceptedUsage.length ? { acceptedUnknownUsageAttemptIds: acceptedUsage } : {}) } });
  return { outcome: "completed" as const, revision: card.revision + 1, escalationsResolved: resolved.count, auditId };
}

const inSettlementTransaction = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) =>
  prisma.$transaction(work, { maxWait: 5_000, timeout: 15_000 }).catch((error: unknown) => {
    if (amuxDatabaseDiagnosticCode(error) === "55P03") throw new AmuxLegacyCardOwnerError("busy");
    throw error;
  });

export async function closeAmuxLegacyCardForOwner(input: {
  session: Session; request: Request; taskId: string; revision: number; ideaId: string | null;
}): Promise<AmuxLegacyCardCloseResult> {
  await assertAmuxLegacyCardOwner(input.session);
  if (!LEGACY_CARD_ID.test(input.taskId)) return { outcome: "not_found" };
  return inSettlementTransaction((tx) => closeAmuxLegacyCardWithin(tx, input));
}

export async function completeAmuxStoppedCardForOwner(input: {
  session: Session; request: Request; taskId: string; revision: number; reason: string;
}): Promise<AmuxOwnerCompleteResult> {
  await assertAmuxLegacyCardOwner(input.session);
  if (!LEGACY_CARD_ID.test(input.taskId)) return { outcome: "not_found" };
  return inSettlementTransaction((tx) => completeAmuxStoppedCardWithin(tx, input));
}
