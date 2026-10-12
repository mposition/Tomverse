import "server-only";

import { Prisma } from "@prisma/client";

import { AMUX_ORCHESTRATOR_AUDIT_ACTIONS } from "@/lib/amux/orchestratorHaltCore";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/adminAuditSystemActors";

/**
 * Read-only access to the canonical audit chain evidence used by the AMUX
 * orchestrator halt read model. Keeping these reads separate from the human
 * audit writer prevents an administrator call site from ever naming the
 * reserved system-actor marker.
 */

export type AmuxOrchestratorHaltAuditProof = {
  id: string;
  action: string;
  targetId: string | null;
  actorUserId: string | null;
  actorMatches: boolean;
  requestId: string | null;
  haltId: string | null;
  haltKey: string | null;
  reasonCode: string | null;
  callKind: string | null;
  resolution: string | null;
  clearKind: string | null;
  evidenceAuditId: string | null;
};

export async function findAmuxNoCommitResolutionAuditId(
  tx: Prisma.TransactionClient,
  requestId: string,
): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id"
    FROM "AdminAuditLog"
    WHERE "action" = ${AMUX_ORCHESTRATOR_AUDIT_ACTIONS.writeResolved}
      AND "targetId" = ${requestId}
      AND "actorUserId" IS NULL
      AND "metadata"->>'systemActor' = ${AMUX_SYSTEM_AUDIT_ACTOR}
      AND "metadata"->>'request_id' = ${requestId}
      AND "metadata"->>'resolution' = 'no_commit'
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

export async function readAmuxOrchestratorHaltAuditProofs(
  tx: Prisma.TransactionClient,
  auditIds: readonly string[],
): Promise<AmuxOrchestratorHaltAuditProof[]> {
  const uniqueIds = [...new Set(auditIds)];
  if (uniqueIds.length === 0) return [];
  return tx.$queryRaw<AmuxOrchestratorHaltAuditProof[]>`
    SELECT
      "id",
      "action",
      "targetId",
      "actorUserId",
      COALESCE("metadata"->>'systemActor' = ${AMUX_SYSTEM_AUDIT_ACTOR}, false) AS "actorMatches",
      "metadata"->>'request_id' AS "requestId",
      "metadata"->>'halt_id' AS "haltId",
      "metadata"->>'halt_key' AS "haltKey",
      "metadata"->>'reason_code' AS "reasonCode",
      "metadata"->>'call_kind' AS "callKind",
      "metadata"->>'resolution' AS "resolution",
      "metadata"->>'clear_kind' AS "clearKind",
      "metadata"->>'evidence_audit_id' AS "evidenceAuditId"
    FROM "AdminAuditLog"
    WHERE "id" IN (${Prisma.join(uniqueIds)})
  `;
}
