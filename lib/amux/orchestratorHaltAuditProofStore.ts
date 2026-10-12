import "server-only";

import { Prisma } from "@prisma/client";

import { AMUX_ORCHESTRATOR_AUDIT_ACTIONS } from "@/lib/amux/orchestratorHaltCore";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/adminAuditSystemActors";

/**
 * Read-only canonical audit-chain fragments used by the halt store's single
 * state query. Keeping the reserved marker and audit table name here prevents
 * an administrator audit call site from naming either while preserving the
 * original one-statement snapshot and database-call ceiling.
 */

export const AMUX_ORCHESTRATOR_HALT_AUDIT_JOINS_SQL = Prisma.sql`
  LEFT JOIN "AdminAuditLog" clear_audit ON clear_audit."id" = h."clearAuditLogId"
  LEFT JOIN "AdminAuditLog" evidence_audit ON evidence_audit."id" = h."clearEvidenceAuditLogId"
`;

export const AMUX_ORCHESTRATOR_HUMAN_CLEAR_AUDIT_PROOF_SQL = Prisma.sql`
  clear_audit."id" IS NOT NULL
  AND clear_audit."action" = ${AMUX_ORCHESTRATOR_AUDIT_ACTIONS.haltCleared}
  AND clear_audit."targetId" = h."id"
  AND clear_audit."actorUserId" = h."clearedByUserId"
`;

export const AMUX_ORCHESTRATOR_SYSTEM_CLEAR_AUDIT_PROOF_SQL = Prisma.sql`
  clear_audit."id" IS NOT NULL
  AND clear_audit."action" = ${AMUX_ORCHESTRATOR_AUDIT_ACTIONS.haltAutoCleared}
  AND clear_audit."targetId" = h."id"
  AND clear_audit."actorUserId" IS NULL
  AND clear_audit."metadata"->>'systemActor' = ${AMUX_SYSTEM_AUDIT_ACTOR}
  AND clear_audit."metadata"->>'request_id' = h."requestId"
  AND clear_audit."metadata"->>'halt_id' = h."id"
  AND clear_audit."metadata"->>'halt_key' = h."haltKey"
  AND clear_audit."metadata"->>'reason_code' = h."reasonCode"
  AND clear_audit."metadata"->>'call_kind' = w."callKind"
  AND clear_audit."metadata"->>'resolution' = 'no_commit'
  AND clear_audit."metadata"->>'clear_kind' = 'system_no_commit'
  AND clear_audit."metadata"->>'evidence_audit_id' = h."clearEvidenceAuditLogId"
  AND evidence_audit."id" IS NOT NULL
  AND evidence_audit."action" = ${AMUX_ORCHESTRATOR_AUDIT_ACTIONS.writeResolved}
  AND evidence_audit."targetId" = h."requestId"
  AND evidence_audit."actorUserId" IS NULL
  AND evidence_audit."metadata"->>'systemActor' = ${AMUX_SYSTEM_AUDIT_ACTOR}
  AND evidence_audit."metadata"->>'request_id' = h."requestId"
  AND evidence_audit."metadata"->>'call_kind' = w."callKind"
  AND evidence_audit."metadata"->>'resolution' = 'no_commit'
`;

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

