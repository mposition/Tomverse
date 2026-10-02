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
  | { status: "refused"; reason: AgentDigestRefusal; secretRuleIds?: SecretRuleId[] }
  | { status: "not_admitted"; reason: string };

/**
 * A caller's last check, run inside the transaction after the audit chain
 * lock and before anything is written. Every writer of state the caller
 * depends on (an operator control revision, for one) takes the same lock
 * first, so the check and the write cannot interleave with a change to it.
 * It returns a refusal code, or null to proceed.
 */
export type AgentDigestAdmission = (tx: Prisma.TransactionClient) => Promise<string | null>;

/** Carries a caller's last-statement refusal out of the transaction it rolls back. */
class AgentDigestNotAdmitted extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

type Db = Pick<typeof prisma, "$transaction">;

/**
 * Statements of a created record, which the policy's transaction budget
 * counts (docs/policy/qa-release-agent.md section 10, digest submission
 * A = 9): setup with the chain lock, the caller's admission, insert, read
 * back, the four of the audit append (lock, clock, previous entry, insert),
 * and the caller's confirmation as the last statement.
 */
export const AGENT_DIGEST_CREATED_STATEMENTS = 9;

export async function recordAgentDigestItem(
  submission: AgentDigestSubmission,
  db: Db = prisma,
  admit?: AgentDigestAdmission,
  confirm?: AgentDigestAdmission,
): Promise<AgentDigestRecordResult> {
  const prepared = prepareAgentDigestItem(submission);
  if (!prepared.ok) {
    return prepared.secretRuleIds
      ? { status: "refused", reason: prepared.reason, secretRuleIds: prepared.secretRuleIds }
      : { status: "refused", reason: prepared.reason };
  }
  const row = prepared.row;

  try {
    return await db.$transaction(
      async (tx) => {
        // First statement: the database-enforced limits, local to this
        // transaction (transaction_timeout only where PostgreSQL 17+ has it),
        // and the audit chain's lock before any row lock -- a transaction that
        // holds the chain and then touches this row must never wait on one
        // that holds the row and waits for the chain. The lock key is
        // lib/adminAudit.ts's, which tests/agentDigestStoreCore.test.mjs pins.
        await tx.$executeRaw`SELECT
          set_config('statement_timeout', ${String(LIMITS.statementMs)}, true),
          set_config('idle_in_transaction_session_timeout', ${String(LIMITS.idleMs)}, true),
          CASE WHEN current_setting('server_version_num')::int >= 170000
            THEN set_config('transaction_timeout', ${String(LIMITS.transactionMs)}, true)
          END,
          pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'))`;
        if (admit) {
          const refusal = await admit(tx);
          if (refusal !== null) return { status: "not_admitted", reason: refusal } as const;
        }
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
        // The caller's confirmation is the transaction's last statement; a
        // refusal here rolls the row and its audit entry back together.
        if (confirm) {
          const refusal = await confirm(tx);
          if (refusal !== null) throw new AgentDigestNotAdmitted(refusal);
        }
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
  } catch (error) {
    if (error instanceof AgentDigestNotAdmitted) return { status: "not_admitted", reason: error.reason };
    throw error;
  }
}
