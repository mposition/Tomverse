import "server-only";

import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import type { SystemAuditActor } from "@/lib/adminAuditSystemActors";
import type { AgentDigestAgentKey } from "@/lib/agentDigestContract";
import {
  AGENT_DIGEST_STORE_TIMEOUTS as LIMITS,
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
      // First statement: the database-enforced limits, local to this
      // transaction. transaction_timeout exists only on PostgreSQL 17+, so it
      // is set only where the server has it.
      await tx.$executeRaw`SELECT
        set_config('statement_timeout', ${String(LIMITS.statementMs)}, true),
        set_config('idle_in_transaction_session_timeout', ${String(LIMITS.idleMs)}, true),
        CASE WHEN current_setting('server_version_num')::int >= 170000
          THEN set_config('transaction_timeout', ${String(LIMITS.transactionMs)}, true)
        END`;
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
    // Policy section 10: Prisma's timeout is the transaction maximum plus five
    // seconds, never its default.
    { maxWait: 5_000, timeout: LIMITS.prismaMs },
  );
}
