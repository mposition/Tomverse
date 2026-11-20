import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import {
  amuxLegacyCardCloseRefusal, amuxOwnerCompleteRefusal,
  type AmuxLegacyCardCloseRefusal, type AmuxLegacyCardFacts, type AmuxOwnerCompleteRefusal,
} from "./legacyCardCore.ts";

/**
 * The owner's close and complete of a stopped v22 Task
 * (legacyCardOwnerService.ts), as the system does them for the Decision Maker
 * (owner decision 2026-11-13, dmOwnerSettlementService.ts). The same judgment
 * (legacyCardCore.ts) on the same facts, the same writes -- close archives the
 * card, its status and every ledger kept; complete moves it to done, terminal
 * on the database clock -- and the open escalations resolved, by a system
 * resolver instead of a person, with one system entry through the
 * hash-chained audit writer in the caller's transaction.
 *
 * Unlike the owner's, neither accepts the card's unknown CLI usage: that
 * acceptance is the owner's (owner decision 2026-11-10) and stays with a
 * person.
 *
 * The caller holds the audit chain lock and the card row, read with
 * `lockedFacts`; each function is then its card write, its escalation write
 * and the audit entry.
 */

/** Who resolves an escalation the Decision Maker settled: never a person's id. */
export const AMUX_DM_OWNER_SETTLEMENT_RESOLVER = "system:amux-dm-owner-settlement";

export type AmuxStoppedCardLockedFacts = AmuxLegacyCardFacts & {
  id: string; displayKey: string | null; revision: number; archivedAt: Date | null;
  activeDelivery: boolean; liveAttempt: boolean; openEscalation: boolean;
};

type SystemAudit = { action: string; summary: string; metadata: Record<string, unknown> };

export type AmuxSystemCloseResult =
  | { outcome: "closed"; closedTaskIds: string[]; escalationsResolved: number; auditId: string }
  | { outcome: "refused"; reason: AmuxLegacyCardCloseRefusal };

/**
 * Closes one stopped card, and with `waitingToo` the cards under the same
 * parent that wait on it -- directly or through each other -- and have not
 * started: backlog or todo, unassigned, never run. One UPDATE archives them
 * all, its WHERE judging each row again as it locks it.
 */
export async function closeAmuxStoppedCardAsSystemWithin(tx: Prisma.TransactionClient, input: {
  card: AmuxStoppedCardLockedFacts; now: Date; resolution: string; waitingToo: boolean;
  audit: SystemAudit;
}): Promise<AmuxSystemCloseResult> {
  const { card } = input;
  const refusal = amuxLegacyCardCloseRefusal(card, card.revision);
  if (refusal) return { outcome: "refused", reason: refusal };
  if (card.archivedAt !== null) return { outcome: "refused", reason: "already_closed" };
  const at = input.now.toISOString();
  const archived = await tx.$queryRaw<Array<{ id: string }>>`
    WITH RECURSIVE parent AS (
      SELECT "parentStoryCardId" AS "story", "parentFeatureNodeId" AS "feature"
      FROM "AmuxWorkItem" WHERE "id" = ${card.id}
    ), unstarted AS (
      SELECT o."id" FROM "AmuxWorkItem" o, parent p
      WHERE ${input.waitingToo}::boolean AND o."id" <> ${card.id}
        AND o."sourceSystem" = 'admin-idea-v4' AND o."cardType" = 'task'
        AND o."archivedAt" IS NULL AND o."status" IN ('backlog', 'todo')
        AND o."owner" IS NULL AND o."claimedAt" IS NULL AND o."v22AssignmentId" IS NULL
        AND NOT EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" a WHERE a."taskId" = o."id")
        AND ((p."story" IS NOT NULL AND o."parentStoryCardId" = p."story") OR
          (p."story" IS NULL AND p."feature" IS NOT NULL AND o."parentStoryCardId" IS NULL AND
            o."parentFeatureNodeId" = p."feature"))
    ), waiting AS (
      SELECT d."taskId" AS "id" FROM "AmuxWorkDependency" d
      JOIN unstarted u ON u."id" = d."taskId" WHERE d."dependencyId" = ${card.id}
      UNION
      SELECT d."taskId" FROM "AmuxWorkDependency" d
      JOIN waiting x ON d."dependencyId" = x."id"
      JOIN unstarted u ON u."id" = d."taskId"
    )
    UPDATE "AmuxWorkItem" w SET "archivedAt" = (${at}::timestamptz AT TIME ZONE 'UTC'),
      "revision" = w."revision" + 1, "updatedAt" = (${at}::timestamptz AT TIME ZONE 'UTC')
    WHERE w."archivedAt" IS NULL AND (
      (w."id" = ${card.id} AND w."revision" = ${card.revision} AND w."status" = ${card.status}) OR
      (w."id" IN (SELECT "id" FROM waiting) AND w."status" IN ('backlog', 'todo') AND
        w."owner" IS NULL AND w."claimedAt" IS NULL AND w."v22AssignmentId" IS NULL))
    RETURNING w."id"`;
  const closedTaskIds = archived.map((row) => row.id).sort();
  // The card itself moved between its lock and this write: nothing else may close.
  if (!closedTaskIds.includes(card.id)) throw new AmuxStoppedCardChanged();
  const resolved = await tx.amuxHumanEscalation.updateMany({
    where: { taskId: { in: closedTaskIds }, status: { in: ["open", "acknowledged"] } },
    data: { status: "resolved", resolutionOutcome: "block", resolution: input.resolution,
      resolvedById: AMUX_DM_OWNER_SETTLEMENT_RESOLVER, resolvedByEmail: null, resolvedAt: input.now },
  });
  const auditId = await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
    action: input.audit.action, targetType: "AmuxWorkItem", targetId: card.id,
    summary: input.audit.summary,
    metadata: { ...input.audit.metadata, displayKey: card.displayKey, fromStatus: card.status,
      previousRevision: card.revision, closedTaskIds, escalationsResolved: resolved.count } });
  return { outcome: "closed", closedTaskIds, escalationsResolved: resolved.count, auditId };
}

export type AmuxSystemCompleteResult =
  | { outcome: "completed"; revision: number; escalationsResolved: number; auditId: string }
  | { outcome: "refused"; reason: AmuxOwnerCompleteRefusal };

/** Completes one stopped v22 Task as done, as the owner's complete does. */
export async function completeAmuxStoppedCardAsSystemWithin(tx: Prisma.TransactionClient, input: {
  card: AmuxStoppedCardLockedFacts; now: Date; resolution: string; audit: SystemAudit;
}): Promise<AmuxSystemCompleteResult> {
  const { card } = input;
  const refusal = amuxOwnerCompleteRefusal(card, card.revision);
  if (refusal) return { outcome: "refused", reason: refusal };
  const moved = await tx.amuxWorkItem.updateMany({
    where: { id: card.id, revision: card.revision, archivedAt: null, status: card.status },
    data: { status: "done", v4TerminalAt: input.now, owner: null, claimedAt: null, revision: { increment: 1 } },
  });
  if (moved.count !== 1) throw new AmuxStoppedCardChanged();
  const resolved = await tx.amuxHumanEscalation.updateMany({
    where: { taskId: card.id, status: { in: ["open", "acknowledged"] } },
    data: { status: "resolved", resolutionOutcome: "approve", resolution: input.resolution,
      resolvedById: AMUX_DM_OWNER_SETTLEMENT_RESOLVER, resolvedByEmail: null, resolvedAt: input.now },
  });
  const auditId = await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
    action: input.audit.action, targetType: "AmuxWorkItem", targetId: card.id,
    summary: input.audit.summary,
    metadata: { ...input.audit.metadata, displayKey: card.displayKey, fromStatus: card.status,
      previousRevision: card.revision, nextRevision: card.revision + 1, toStatus: "done",
      escalationsResolved: resolved.count } });
  return { outcome: "completed", revision: card.revision + 1, escalationsResolved: resolved.count, auditId };
}

/** The card changed under its own lock: the caller's transaction rolls back. */
export class AmuxStoppedCardChanged extends Error {
  constructor() {
    super("amux_stopped_card_changed");
    this.name = "AmuxStoppedCardChanged";
  }
}
