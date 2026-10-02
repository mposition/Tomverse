import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import type { SystemAuditActor } from "@/lib/adminAuditSystemActors";
import type { AgentDigestAgentKey } from "@/lib/agentDigestContract";
import {
  classifyAgentDigestRepeat,
  prepareAgentDigestItem,
  type AgentDigestRefusal,
  type AgentDigestSubmission,
} from "@/lib/agentDigestStoreCore";
import type { SecretRuleId } from "@/lib/engineeringAgentSecretPatterns";
import { prisma } from "@/lib/prisma";

/**
 * The only writer of AgentDigestItem (scripts/check-protected-table-writers-core.mjs
 * names this file). Shared contract items 1-9: a row is born with its body, in
 * the same transaction as its system audit entry, and is never edited by the
 * application -- body expiry and the meta purge are the database's two allowed
 * changes and get their own functions here when a job needs them.
 *
 * Idempotency: the insert is ON CONFLICT DO NOTHING on (agentKey,
 * idempotencyKey), so two concurrent submissions cannot both write; the loser
 * reads the winner's row and answers replayed (same bytes) or conflict.
 * Neither writes an audit entry: nothing changed.
 */

/** Which listed system actor records each agent's intake. */
const INTAKE_ACTOR: Readonly<Record<AgentDigestAgentKey, SystemAuditActor>> = Object.freeze({
  "qa-release": "qa-release-intake",
});

export type AgentDigestRecordResult =
  | { status: "created"; id: string; auditLogId: string; sizeBytes: number; payloadSha256: string }
  | { status: "replayed"; id: string; payloadSha256: string }
  | { status: "conflict"; id: string }
  | { status: "refused"; reason: AgentDigestRefusal; secretRuleIds?: SecretRuleId[] };

type Db = Pick<typeof prisma, "$transaction">;

export async function recordAgentDigestItem(
  submission: AgentDigestSubmission,
  db: Db = prisma,
): Promise<AgentDigestRecordResult> {
  const prepared = prepareAgentDigestItem(submission);
  if (!prepared.ok) {
    return prepared.secretRuleIds
      ? { status: "refused", reason: prepared.reason, secretRuleIds: prepared.secretRuleIds }
      : { status: "refused", reason: prepared.reason };
  }
  const row = prepared.row;

  return db.$transaction(
    async (tx) => {
      const inserted = await tx.agentDigestItem.createMany({
        data: [
          {
            id: crypto.randomUUID(),
            agentKey: row.agentKey,
            kind: row.kind,
            schemaVersion: row.schemaVersion,
            idempotencyKey: row.idempotencyKey,
            payload: row.payload as Prisma.InputJsonValue,
            payloadSha256: row.payloadSha256,
            sizeBytes: row.sizeBytes,
          },
        ],
        skipDuplicates: true,
      });
      const stored = await tx.agentDigestItem.findUniqueOrThrow({
        where: { agentKey_idempotencyKey: { agentKey: row.agentKey, idempotencyKey: row.idempotencyKey } },
        select: { id: true, kind: true, schemaVersion: true, payloadSha256: true },
      });

      if (inserted.count === 0) {
        return classifyAgentDigestRepeat(stored, row) === "replayed"
          ? ({ status: "replayed", id: stored.id, payloadSha256: stored.payloadSha256 } as const)
          : ({ status: "conflict", id: stored.id } as const);
      }

      const auditLogId = await writeSystemAuditLog({
        tx,
        systemActor: INTAKE_ACTOR[row.agentKey],
        action: "agent_digest.recorded",
        targetType: "AgentDigestItem",
        targetId: stored.id,
        summary: "Recorded an agent digest item.",
        // Identity, size and hash only: the payload stays in its own row.
        metadata: {
          agentKey: row.agentKey,
          kind: row.kind,
          schemaVersion: row.schemaVersion,
          idempotencyKey: row.idempotencyKey,
          payloadSha256: row.payloadSha256,
          sizeBytes: row.sizeBytes,
        },
      });
      return {
        status: "created",
        id: stored.id,
        auditLogId,
        sizeBytes: row.sizeBytes,
        payloadSha256: row.payloadSha256,
      } as const;
    },
    // Explicit budget: the audit chain lock queues every other audit write.
    { maxWait: 5_000, timeout: 10_000 },
  );
}
