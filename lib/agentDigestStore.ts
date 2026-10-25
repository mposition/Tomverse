import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import type { SystemAuditActor } from "@/lib/adminAuditSystemActors";
import { AGENT_DIGEST_META_RETENTION_DAYS, type AgentDigestAgentKey } from "@/lib/agentDigestContract";
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
 * changes, and expireAgentDigestBodies and purgeAgentDigestMeta below are their
 * only callers.
 *
 * Idempotency: the insert is ON CONFLICT DO NOTHING on (agentKey,
 * idempotencyKey), so two concurrent submissions cannot both write; the loser
 * reads the winner's row and answers replayed (same bytes) or conflict.
 * Neither writes an audit entry: nothing changed.
 */

/** Which listed system actor records each agent's intake. */
const INTAKE_ACTOR: Readonly<Record<AgentDigestAgentKey, SystemAuditActor>> = Object.freeze({
  "qa-release": "qa-release-intake",
  "billing-finance-ops": "billing-finance-ops-intake",
  // The agent's one listed actor; its digest intake is a different action from
  // the state advance the trust check binds (docs/policy/sre-ops.md §3 rule 10).
  "sre-ops": "ops-observer",
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

/**
 * A caller's own transaction limits, for an agent whose policy fixes them
 * (docs/policy/sre-ops.md §6): `arm` replaces the default limits as the
 * transaction's first statement, and `prismaTimeoutMs` replaces the default
 * Prisma timeout. It must still be one statement, so the statement count is
 * unchanged. Absent, the shared defaults apply as before.
 */
export type AgentDigestTransactionLimits = {
  arm: (tx: Prisma.TransactionClient) => Promise<void>;
  prismaTimeoutMs: number;
};

export async function recordAgentDigestItem(
  submission: AgentDigestSubmission,
  db: Db = prisma,
  admit?: AgentDigestAdmission,
  confirm?: AgentDigestAdmission,
  limits?: AgentDigestTransactionLimits,
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
        if (limits) await limits.arm(tx);
        else await tx.$executeRaw`SELECT
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
      { maxWait: 5_000, timeout: limits?.prismaTimeoutMs ?? LIMITS.prismaMs },
    );
  } catch (error) {
    if (error instanceof AgentDigestNotAdmitted) return { status: "not_admitted", reason: error.reason };
    throw error;
  }
}

/** Rows one retention batch touches. Each batch is its own transaction and audit entry. */
export const AGENT_DIGEST_RETENTION_BATCH = 200;

type RetentionRow = { id: string; agentKey: string };

const countByAgent = (rows: readonly RetentionRow[]) =>
  rows.reduce<Record<string, number>>((counts, row) => {
    counts[row.agentKey] = (counts[row.agentKey] ?? 0) + 1;
    return counts;
  }, {});

/**
 * Body expiry, the first of the table's two allowed changes (shared contract
 * items 4-5; docs/policy/billing-finance-ops.md §1.4). One batch of rows past
 * their `retentionUntil`, for every agent: the payload becomes NULL and the
 * update trigger stamps `bodyDeletedAt` from the database clock. The trigger
 * refuses the update for any row still inside its retention, so this function
 * cannot remove a body early even if its WHERE were wrong.
 *
 * Irreversible by design: the payload is gone. What remains is the row's
 * identity, size and hash, and the `agent_digest.recorded` audit entry that
 * already carries the same hash.
 */
export async function expireAgentDigestBodies(db: Db = prisma): Promise<{ expired: number }> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT
        set_config('statement_timeout', ${String(LIMITS.statementMs)}, true),
        set_config('idle_in_transaction_session_timeout', ${String(LIMITS.idleMs)}, true),
        CASE WHEN current_setting('server_version_num')::int >= 170000
          THEN set_config('transaction_timeout', ${String(LIMITS.transactionMs)}, true)
        END`;
      await takeAuditChainLock(tx);
      const rows = await tx.$queryRaw<RetentionRow[]>`
        UPDATE "AgentDigestItem" SET "payload" = NULL
        WHERE "id" IN (
          SELECT "id" FROM "AgentDigestItem"
          WHERE "payload" IS NOT NULL AND "retentionUntil" < clock_timestamp()
          ORDER BY "retentionUntil"
          LIMIT ${AGENT_DIGEST_RETENTION_BATCH}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING "id"::text AS "id", "agentKey"`;
      if (rows.length === 0) return { expired: 0 };
      await writeSystemAuditLog({
        tx,
        systemActor: "agent-digest-retention",
        action: "agent_digest.bodies_expired",
        targetType: "AgentDigestItem",
        targetId: null,
        summary: `Expired the bodies of ${rows.length} agent digest items past their retention.`,
        // Counts only: the rows keep their identity and hash, and the bodies are gone.
        metadata: { expired: rows.length, byAgent: countByAgent(rows) },
      });
      return { expired: rows.length };
    },
    { maxWait: 5_000, timeout: LIMITS.prismaMs },
  );
}

/**
 * The meta purge, the second allowed change: one batch of rows whose body is
 * already gone and whose `createdAt` is past the shared 365-day meta retention.
 * The delete trigger refuses any other row.
 */
export async function purgeAgentDigestMeta(db: Db = prisma): Promise<{ purged: number }> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT
        set_config('statement_timeout', ${String(LIMITS.statementMs)}, true),
        set_config('idle_in_transaction_session_timeout', ${String(LIMITS.idleMs)}, true),
        CASE WHEN current_setting('server_version_num')::int >= 170000
          THEN set_config('transaction_timeout', ${String(LIMITS.transactionMs)}, true)
        END`;
      await takeAuditChainLock(tx);
      const rows = await tx.$queryRaw<RetentionRow[]>`
        DELETE FROM "AgentDigestItem"
        WHERE "id" IN (
          SELECT "id" FROM "AgentDigestItem"
          WHERE "bodyDeletedAt" IS NOT NULL
            AND "createdAt" < clock_timestamp() - make_interval(days => ${AGENT_DIGEST_META_RETENTION_DAYS}::int)
          ORDER BY "createdAt"
          LIMIT ${AGENT_DIGEST_RETENTION_BATCH}
          FOR UPDATE SKIP LOCKED
        )
        RETURNING "id"::text AS "id", "agentKey"`;
      if (rows.length === 0) return { purged: 0 };
      await writeSystemAuditLog({
        tx,
        systemActor: "agent-digest-retention",
        action: "agent_digest.meta_purged",
        targetType: "AgentDigestItem",
        targetId: null,
        summary: `Purged ${rows.length} agent digest items past the meta retention.`,
        metadata: { purged: rows.length, byAgent: countByAgent(rows) },
      });
      return { purged: rows.length };
    },
    { maxWait: 5_000, timeout: LIMITS.prismaMs },
  );
}
