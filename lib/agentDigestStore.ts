import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
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
 * A caller's check inside the transaction, returning a refusal code or null
 * to proceed.
 *
 * As `admit` it runs after the audit chain lock and before anything is
 * written. Every writer of state the caller depends on (an operator control
 * revision, for one) takes the same lock first, so the check and the write
 * cannot interleave with a change to it.
 *
 * As `confirm` it runs last, after the row and its audit entry, and only
 * when a row was created (a replay or a conflict writes nothing to roll
 * back); a refusal rolls both writes back.
 */
export type AgentDigestAdmission = (tx: Prisma.TransactionClient) => Promise<string | null>;

/** Carries a caller's last-statement refusal out of the transaction it rolls back. */
class AgentDigestNotAdmitted extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

type Db = Pick<typeof prisma, "$transaction">;

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
        // A created record is LIMITS.statements (policy section 10, A = 9)
        // statements: these limits, the chain lock, the caller's admission,
        // the insert, the four of the audit append (lock, clock, previous
        // entry, insert) and the caller's confirmation.
        //
        // First the database-enforced limits, local to this transaction
        // (transaction_timeout only where PostgreSQL 17+ has it). They arm
        // for the statements after this one, which is why the lock is not
        // folded in here.
        await tx.$executeRaw`SELECT
          set_config('statement_timeout', ${String(LIMITS.statementMs)}, true),
          set_config('idle_in_transaction_session_timeout', ${String(LIMITS.idleMs)}, true),
          CASE WHEN current_setting('server_version_num')::int >= 170000
            THEN set_config('transaction_timeout', ${String(LIMITS.transactionMs)}, true)
          END`;
        // The audit chain's lock before any row lock, under the statement
        // limit: a transaction that holds the chain and then touches this row
        // must never wait on one that holds the row and waits for the chain.
        await takeAuditChainLock(tx);
        if (admit) {
          const refusal = await admit(tx);
          if (refusal !== null) return { status: "not_admitted", reason: refusal } as const;
        }
        // The id is chosen here, so a created row needs no read back.
        const id = crypto.randomUUID();
        const inserted = await tx.agentDigestItem.createMany({
          data: [
            {
              id,
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
        if (inserted.count === 0) {
          // Another submission holds the key: read it to tell a replay from a conflict.
          const stored = await tx.agentDigestItem.findUniqueOrThrow({
            where: { agentKey_idempotencyKey: { agentKey: row.agentKey, idempotencyKey: row.idempotencyKey } },
            select: { id: true, kind: true, schemaVersion: true, payloadSha256: true },
          });
          return classifyAgentDigestRepeat(stored, row) === "replayed"
            ? ({ status: "replayed", id: stored.id, payloadSha256: stored.payloadSha256 } as const)
            : ({ status: "conflict", id: stored.id } as const);
        }

        const auditLogId = await writeSystemAuditLog({
          tx,
          systemActor: INTAKE_ACTOR[row.agentKey],
          action: "agent_digest.recorded",
          targetType: "AgentDigestItem",
          targetId: id,
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
          id,
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
