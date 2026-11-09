import "server-only";

import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { AmuxLegacyCardOwnerError, assertAmuxLegacyCardOwner } from "./legacyCardOwnerService.ts";
import { amuxDatabaseDiagnosticCode } from "./readFailureCore.ts";
import {
  amuxSettledCardEscalationRefusal, type AmuxSettledCardEscalationRefusal,
} from "./settledCardEscalationCore.ts";

/**
 * The owner closes the escalations a done card still holds
 * (settledCardEscalationCore.ts). Only the escalations change: they are
 * resolved as superseded by the later attempt (`retry`); the card's status,
 * revision, archive and every ledger stay. One person's audit entry through
 * the administrator writer in the same transaction, the way the legacy card
 * close writes its own (legacyCardOwnerService.ts).
 */

const CARD_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type AmuxSettledCardEscalationCloseResult =
  | { outcome: "closed"; escalationsResolved: number; auditId: string }
  | { outcome: "not_found" }
  | { outcome: "refused"; reason: AmuxSettledCardEscalationRefusal };

type CardRow = {
  id: string; displayKey: string | null; status: string; revision: number;
  activeDelivery: boolean; liveAttempt: boolean; openEscalationIds: string[];
};

/**
 * The audit chain lock first, then the card row without waiting (a worker's
 * writers lock the card and then the chain, so waiting here would deadlock
 * with them), the judgment under the lock, the escalations and the audit.
 */
export async function closeAmuxSettledCardEscalationsForOwner(input: {
  session: Session; request: Request; taskId: string; escalationId: string;
}): Promise<AmuxSettledCardEscalationCloseResult> {
  await assertAmuxLegacyCardOwner(input.session);
  if (!CARD_ID.test(input.taskId) || !CARD_ID.test(input.escalationId)) return { outcome: "not_found" };
  const actorUserId = input.session.user!.id!;
  return prisma.$transaction(async (tx) => {
    const clock = await tx.$queryRaw<Array<{ now: Date }>>`
      SELECT set_config('statement_timeout', '5000', true),
             set_config('idle_in_transaction_session_timeout', '10000', true),
             date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC') AS "now"`;
    await takeAuditChainLock(tx);
    const now = clock[0]?.now;
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("clock_unavailable");
    const rows = await tx.$queryRaw<CardRow[]>`
      SELECT w."id", w."displayKey", w."status", w."revision",
        EXISTS (SELECT 1 FROM "AmuxWorkDelivery" d WHERE d."taskId" = w."id"
          AND d."status" IN ('queued', 'leased')) AS "activeDelivery",
        EXISTS (SELECT 1 FROM "AmuxExecutionAttempt" a WHERE a."taskId" = w."id"
          AND a."endedAt" IS NULL) AS "liveAttempt",
        COALESCE((SELECT array_agg(e."id" ORDER BY e."createdAt", e."id") FROM "AmuxHumanEscalation" e
          WHERE e."taskId" = w."id" AND e."status" IN ('open', 'acknowledged')), ARRAY[]::text[])
          AS "openEscalationIds"
      FROM "AmuxWorkItem" w WHERE w."id" = ${input.taskId}
      FOR UPDATE OF w NOWAIT`;
    const card = rows[0];
    if (!card) return { outcome: "not_found" as const };
    const refusal = amuxSettledCardEscalationRefusal(card, input.escalationId);
    if (refusal) return { outcome: "refused" as const, reason: refusal };
    const resolved = await tx.amuxHumanEscalation.updateMany({
      where: { id: { in: card.openEscalationIds }, taskId: card.id, status: { in: ["open", "acknowledged"] } },
      data: { status: "resolved", resolutionOutcome: "retry",
        resolution: "Closed by the owner on a done Task: a later attempt finished it, so this escalation from an earlier attempt was left open.",
        resolvedById: actorUserId, resolvedByEmail: input.session.user?.email ?? null, resolvedAt: now },
    });
    // A row that left open or acknowledged between the read and the write
    // rolls the whole close back rather than resolving part of what was read.
    if (resolved.count !== card.openEscalationIds.length) throw new Error("escalations_changed");
    const auditId = await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: "amux.settled_card.escalation_closed", targetType: "AmuxWorkItem", targetId: card.id,
      summary: "Closed the escalations an earlier attempt left open on a done AMUX Task.",
      metadata: { displayKey: card.displayKey, status: card.status, revision: card.revision,
        escalationIds: card.openEscalationIds, escalationsResolved: resolved.count } });
    return { outcome: "closed" as const, escalationsResolved: resolved.count, auditId };
  }, { maxWait: 5_000, timeout: 15_000 }).catch((error: unknown) => {
    if (amuxDatabaseDiagnosticCode(error) === "55P03") throw new AmuxLegacyCardOwnerError("busy");
    throw error;
  });
}
