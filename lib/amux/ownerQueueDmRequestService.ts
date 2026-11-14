import "server-only";

import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { amuxDmOwnerSettlementId, amuxDmOwnerSettlementKind, isAmuxDmOwnerSettlementId }
  from "./dmOwnerSettlementCore.ts";
import { scanAmuxDmOwnerSettlementCandidates } from "./dmOwnerSettlementRead.ts";
import {
  AMUX_OWNER_QUEUE_DM_REQUESTED_ACTION, AMUX_OWNER_QUEUE_DM_RESENDABLE_HANDOFF, AMUX_OWNER_QUEUE_DM_RESENT_ACTION,
} from "./ownerQueueDmCore.ts";

/**
 * The owner's "ask the Decision Maker" button on a card in the owner queue
 * (owner decision 2026-11-14). It never asks the Decision Maker itself: the
 * relay files every card on its next tick, through the paths that already
 * exist. The button only takes away what keeps a card from being filed:
 *
 * - `resend`: a result review or a settlement whose evidence could not be
 *   read once (`evidence_unavailable`) and that has no card yet goes back to
 *   being pending. A review or settlement whose card was filed, or that was
 *   handed over for any other reason, is refused.
 * - `request`: a stopped Task's escalation with no settlement yet is filed as
 *   one, if the settlement scan would file it (no other path holds the Task,
 *   nothing runs); while TOMVERSE_AMUX_DM_OWNER_SETTLEMENT is off, the tick
 *   files only the settlements requested this way. An open settlement with no
 *   card is marked requested.
 *
 * Each press is one transaction: the audit chain lock, the change, and the
 * person's hash-chained audit entry. A failure whose outcome is unknown is
 * read back from the owner queue, never sent again blindly. The Decision
 * Maker's answer stays a proposal the owner confirms, as for every other card.
 */

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export type AmuxOwnerQueueDmRequestInput = {
  session: Session; request: Request; taskId: string;
  source: "result_review" | "settlement"; action: "resend" | "request"; sourceId: string;
};

export type AmuxOwnerQueueDmRequestResult =
  | { outcome: "done"; settlementId: string | null }
  | { outcome: "refused"; reason: "not_resendable" | "not_eligible" | "invalid" };

export async function requestAmuxOwnerQueueDm(input: AmuxOwnerQueueDmRequestInput):
  Promise<AmuxOwnerQueueDmRequestResult> {
  if (!ID.test(input.taskId) || !ID.test(input.sourceId)) return { outcome: "refused", reason: "invalid" };
  if (input.source === "result_review" && input.action !== "resend") return { outcome: "refused", reason: "invalid" };
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      SELECT set_config('statement_timeout', '5000', true),
             set_config('idle_in_transaction_session_timeout', '10000', true)`;
    await takeAuditChainLock(tx);
    const audit = (action: string, targetType: string, targetId: string, summary: string,
      metadata: Record<string, unknown>) => writeAdminAuditLog({ tx, session: input.session,
      request: input.request, action, targetType, targetId, summary,
      metadata: { taskId: input.taskId, ...metadata } });

    if (input.source === "result_review") {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "AmuxV22ResultReview" SET "handoffAt" = NULL, "handoffReason" = NULL,
          "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
        WHERE "id" = ${input.sourceId} AND "taskId" = ${input.taskId} AND "state" = 'open'
          AND "localCardId" IS NULL AND "handoffReason" = ${AMUX_OWNER_QUEUE_DM_RESENDABLE_HANDOFF}
        RETURNING "id"`;
      if (rows.length !== 1) return { outcome: "refused" as const, reason: "not_resendable" as const };
      await audit(AMUX_OWNER_QUEUE_DM_RESENT_ACTION, "AmuxV22ResultReview", input.sourceId,
        "Sent a v22 result review back to the Decision Maker relay from the owner queue.",
        { previousHandoffReason: AMUX_OWNER_QUEUE_DM_RESENDABLE_HANDOFF });
      return { outcome: "done" as const, settlementId: null };
    }

    if (input.action === "resend") {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "AmuxDmOwnerSettlement" SET "handoffAt" = NULL, "handoffReason" = NULL,
          "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
        WHERE "id" = ${input.sourceId} AND "taskId" = ${input.taskId} AND "state" = 'open'
          AND "localCardId" IS NULL AND "handoffReason" = ${AMUX_OWNER_QUEUE_DM_RESENDABLE_HANDOFF}
        RETURNING "id"`;
      if (rows.length !== 1) return { outcome: "refused" as const, reason: "not_resendable" as const };
      // Requested too, so the tick files it while the settlement switch is off.
      await audit(AMUX_OWNER_QUEUE_DM_REQUESTED_ACTION, "AmuxDmOwnerSettlement", input.sourceId,
        "Sent an owner queue settlement back to the Decision Maker relay from the owner queue.",
        { resend: true, previousHandoffReason: AMUX_OWNER_QUEUE_DM_RESENDABLE_HANDOFF });
      return { outcome: "done" as const, settlementId: input.sourceId };
    }

    // An open settlement with no card yet: mark it requested.
    if (isAmuxDmOwnerSettlementId(input.sourceId)) {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT "id" FROM "AmuxDmOwnerSettlement"
        WHERE "id" = ${input.sourceId} AND "taskId" = ${input.taskId} AND "state" = 'open'
          AND "localCardId" IS NULL AND "handoffAt" IS NULL`;
      if (rows.length !== 1) return { outcome: "refused" as const, reason: "not_eligible" as const };
      await audit(AMUX_OWNER_QUEUE_DM_REQUESTED_ACTION, "AmuxDmOwnerSettlement", input.sourceId,
        "Asked the Decision Maker about a stopped AMUX Task from the owner queue.", { resend: false });
      return { outcome: "done" as const, settlementId: input.sourceId };
    }

    // An escalation with no settlement: file one, as the tick would.
    const [found] = await scanAmuxDmOwnerSettlementCandidates(tx, 1, [input.sourceId]);
    if (!found || found.taskId !== input.taskId) return { outcome: "refused" as const, reason: "not_eligible" as const };
    const kind = amuxDmOwnerSettlementKind({ openBinding: found.bindingId ? "review_draft" : null,
      engineeringInFlight: false });
    if (!kind) return { outcome: "refused" as const, reason: "not_eligible" as const };
    const settlementId = amuxDmOwnerSettlementId(found.escalationId);
    const inserted = await tx.$executeRaw`
      INSERT INTO "AmuxDmOwnerSettlement" ("id", "taskId", "escalationId", "attemptId", "kind",
        "taskStatus", "bindingId", "updatedAt")
      VALUES (${settlementId}, ${found.taskId}, ${found.escalationId}, ${found.attemptId}, ${kind},
        ${found.taskStatus}, ${found.bindingId}, (clock_timestamp() AT TIME ZONE 'UTC'))
      ON CONFLICT DO NOTHING`;
    if (inserted !== 1) return { outcome: "refused" as const, reason: "not_eligible" as const };
    await audit(AMUX_OWNER_QUEUE_DM_REQUESTED_ACTION, "AmuxDmOwnerSettlement", settlementId,
      "Asked the Decision Maker about a stopped AMUX Task from the owner queue.",
      { resend: false, escalationId: found.escalationId, kind });
    return { outcome: "done" as const, settlementId };
  }, { maxWait: 5_000, timeout: 15_000 });
}
