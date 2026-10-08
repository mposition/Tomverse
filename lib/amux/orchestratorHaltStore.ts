import "server-only";

import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  AMUX_ORCHESTRATOR_AUDIT_ACTIONS,
  AMUX_ORCHESTRATOR_DEADLINE_GRACE_MS,
  AMUX_ORCHESTRATOR_RECEIPT_TARGET_KINDS,
  amuxOrchestratorAuditMetadata,
  amuxOrchestratorHaltKeyPrefixMatches,
  decideAmuxOrchestratorAck,
  judgeAmuxOrchestratorWrite,
  type AmuxOrchestratorAckDecision,
  type AmuxOrchestratorAckKind,
  type AmuxOrchestratorCallKind,
  type AmuxOrchestratorHaltReasonCode,
  type AmuxOrchestratorHaltRecord,
  type AmuxOrchestratorJudgement,
  type AmuxOrchestratorReceiptTargetKind,
} from "@/lib/amux/orchestratorHaltCore";
import { writeAmuxOrchestratorSystemAudit } from "@/lib/amux/orchestratorHaltSystemAudit";
import { prisma } from "@/lib/prisma";

/**
 * The one module that writes `AmuxOrchestratorWrite`,
 * `AmuxOrchestratorWriteReceipt` and `AmuxOrchestratorHalt` (orchestration
 * policy version 20). `tests/amuxOrchestratorHaltStore.test.mjs` fails on a
 * reference to those tables anywhere else in the application.
 *
 * Every function that takes `tx` runs inside a transaction its caller owns:
 * the bounded AMUX boundaries in lib/amux/dbBoundary.ts and
 * lib/amux/orchestratorHaltService.ts, or the automatic promotion
 * transaction. The Admin clear opens its own. Nothing here imports the
 * boundary, so the boundary can import this.
 *
 * No title, brief, source key, free text or error body is written to these
 * tables or to their audit entries.
 */

export type AmuxOrchestratorReceipt = {
  targetKind: AmuxOrchestratorReceiptTargetKind;
  targetId: string | null;
  rowCount: number;
};

const epochMs = (value: unknown): number => {
  const number =
    typeof value === "bigint" || typeof value === "number" ? Number(value) : Number.NaN;
  if (!Number.isSafeInteger(number)) {
    throw new Error("AMUX orchestrator write clock is not a safe integer");
  }
  return number;
};

/**
 * Section 4: the admission, as the first transaction of the route. Both
 * instants come from one clock_timestamp() (the trigger re-anchors them on the
 * insert's own clock as well). A second admission of the same request id
 * inserts nothing and is reported as not admitted.
 */
export async function insertAmuxOrchestratorAdmission(
  tx: Prisma.TransactionClient,
  input: {
    requestId: string;
    instanceId: string;
    callKind: AmuxOrchestratorCallKind;
    budgetMs: number;
  },
): Promise<{ admitted: true; deadlineAt: Date } | { admitted: false }> {
  if (!Number.isSafeInteger(input.budgetMs) || input.budgetMs <= 0) {
    throw new Error("AMUX orchestrator admission budget must be a positive integer");
  }
  const rows = await tx.$queryRaw<Array<{ deadlineAtEpochMs: bigint }>>`
    WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS "now")
    INSERT INTO "AmuxOrchestratorWrite"
      ("requestId", "instanceId", "callKind", "admittedAt", "deadlineAt")
    SELECT
      ${input.requestId},
      ${input.instanceId},
      ${input.callKind},
      clock."now",
      clock."now" + ${input.budgetMs} * INTERVAL '1 millisecond'
    FROM clock
    ON CONFLICT ("requestId") DO NOTHING
    RETURNING floor(extract(epoch FROM "deadlineAt") * 1000)::bigint AS "deadlineAtEpochMs"
  `;
  const row = rows[0];
  if (!row) return { admitted: false };
  return { admitted: true, deadlineAt: new Date(epochMs(row.deadlineAtEpochMs)) };
}

/**
 * Section 4: the lock every state-changing transaction of an admitted request
 * takes before it changes anything, held to its COMMIT. A resolver or an
 * acknowledgement takes the same row lock, so neither can look at the
 * receipts while such a transaction is running. Returns null when the row
 * does not exist.
 */
export async function lockAmuxOrchestratorAdmission(
  tx: Prisma.TransactionClient,
  requestId: string,
): Promise<{ acked: boolean; resolved: boolean } | null> {
  const rows = await tx.$queryRaw<Array<{ acked: boolean; resolved: boolean }>>`
    SELECT
      ("ackedAt" IS NOT NULL) AS "acked",
      ("resolvedAt" IS NOT NULL) AS "resolved"
    FROM "AmuxOrchestratorWrite"
    WHERE "requestId" = ${requestId}
    FOR UPDATE
  `;
  const row = rows[0];
  return row ? { acked: row.acked === true, resolved: row.resolved === true } : null;
}

const RECEIPT_TARGET_ID_MAX = 191;
const RECEIPT_ROW_COUNT_MAX = 100_000;

const validReceipt = (receipt: AmuxOrchestratorReceipt): boolean =>
  (AMUX_ORCHESTRATOR_RECEIPT_TARGET_KINDS as readonly string[]).includes(
    receipt.targetKind,
  ) &&
  Number.isSafeInteger(receipt.rowCount) &&
  receipt.rowCount >= 1 &&
  receipt.rowCount <= RECEIPT_ROW_COUNT_MAX &&
  (receipt.targetKind === "quota_observation_batch"
    ? receipt.targetId === null
    : typeof receipt.targetId === "string" &&
      receipt.targetId.length >= 1 &&
      receipt.targetId.length <= RECEIPT_TARGET_ID_MAX);

/**
 * Section 4: the receipts of one transaction, as one more data-modifying CTE of
 * that transaction's commit fence -- its last statement, so a receipt exists
 * exactly when the rest of the transaction commits, and the fence costs no
 * extra Prisma call. `committedAt` is the database clock at the fence, the
 * closest instant before COMMIT a statement can read.
 */
export function amuxOrchestratorReceiptInsertSql(
  requestId: string,
  receipts: readonly AmuxOrchestratorReceipt[],
): Prisma.Sql {
  if (receipts.length === 0) return Prisma.empty;
  if (!receipts.every(validReceipt)) {
    throw new Error("AMUX orchestrator receipt refused before the fence");
  }
  const rows = JSON.stringify(
    receipts.map((receipt) => ({
      id: randomUUID(),
      targetKind: receipt.targetKind,
      targetId: receipt.targetId,
      rowCount: receipt.rowCount,
    })),
  );
  return Prisma.sql`, "orchestratorReceipts" AS (
      INSERT INTO "AmuxOrchestratorWriteReceipt"
        ("id", "requestId", "targetKind", "targetId", "rowCount", "committedAt")
      SELECT r."id", ${requestId}, r."targetKind", r."targetId", r."rowCount", clock_timestamp()
      FROM jsonb_to_recordset(${rows}::jsonb)
        AS r("id" text, "targetKind" text, "targetId" text, "rowCount" integer)
      RETURNING 1
    )`;
}

/**
 * Section 4, the acknowledgement, under the admission's row lock. The lock and
 * the count are two statements on purpose: under READ COMMITTED a second
 * statement reads what a transaction the lock waited for has committed, while
 * a subquery of the locking statement would still read the snapshot taken
 * before the wait.
 */
export async function acknowledgeAmuxOrchestratorWriteLocked(
  tx: Prisma.TransactionClient,
  input: { requestId: string; kind: AmuxOrchestratorAckKind },
): Promise<AmuxOrchestratorAckDecision> {
  const admission = await lockAmuxOrchestratorAdmission(tx, input.requestId);
  const receiptCount =
    admission === null ? 0 : await countAmuxOrchestratorReceipts(tx, input.requestId);
  const decision = decideAmuxOrchestratorAck({
    kind: input.kind,
    admission: admission === null ? null : { receiptCount },
  });
  if (decision.acked && decision.write === "set_acked") {
    await tx.$executeRaw`
      UPDATE "AmuxOrchestratorWrite"
      SET "ackedAt" = clock_timestamp()
      WHERE "requestId" = ${input.requestId} AND "ackedAt" IS NULL
    `;
  }
  return decision;
}

async function countAmuxOrchestratorReceipts(
  tx: Prisma.TransactionClient,
  requestId: string,
): Promise<number> {
  const rows = await tx.$queryRaw<Array<{ receiptCount: bigint }>>`
    SELECT count(*)::bigint AS "receiptCount"
    FROM "AmuxOrchestratorWriteReceipt"
    WHERE "requestId" = ${requestId}
  `;
  return Number(rows[0]?.receiptCount ?? 0);
}

/**
 * Admissions the resolver may decide now: neither acknowledged nor resolved,
 * past their deadline plus the grace on the database clock, and with no
 * committed receipt -- one with a receipt can only ever need a person, so it
 * is not a candidate and cannot crowd out the ones that can be decided.
 * Oldest deadline first. A receipt that commits after this list is read is
 * still counted: the resolver counts again under the row lock.
 */
export async function listAmuxOrchestratorResolveCandidates(
  tx: Prisma.TransactionClient,
  limit: number,
): Promise<string[]> {
  const rows = await tx.$queryRaw<Array<{ requestId: string }>>`
    SELECT w."requestId"
    FROM "AmuxOrchestratorWrite" w
    WHERE w."ackedAt" IS NULL
      AND w."resolvedAt" IS NULL
      AND w."deadlineAt" + ${AMUX_ORCHESTRATOR_DEADLINE_GRACE_MS} * INTERVAL '1 millisecond'
        <= clock_timestamp()
      AND NOT EXISTS (
        SELECT 1 FROM "AmuxOrchestratorWriteReceipt" r WHERE r."requestId" = w."requestId"
      )
    ORDER BY w."deadlineAt" ASC, w."requestId" ASC
    LIMIT ${limit}
  `;
  return rows.map((row) => row.requestId);
}

/**
 * Section 4, the resolver for one admission, under its row lock and on the
 * database clock. The lock serialises the judgement with every state-changing
 * transaction of the request: one that is committing holds the row, so the
 * receipts are counted after it has committed or rolled back. A rollback
 * confirmed by the evidence writes `no_commit` and the system audit
 * `amux.orchestrator.write_resolved` in this transaction; a receipt leaves the
 * row for a person. Writes nothing otherwise.
 */
export async function resolveAmuxOrchestratorWriteLocked(
  tx: Prisma.TransactionClient,
  requestId: string,
): Promise<AmuxOrchestratorJudgement | "closed"> {
  const locked = await tx.$queryRaw<
    Array<{
      callKind: string;
      open: boolean;
      deadlineAtEpochMs: bigint;
    }>
  >`
    SELECT
      "callKind",
      ("ackedAt" IS NULL AND "resolvedAt" IS NULL) AS "open",
      floor(extract(epoch FROM "deadlineAt") * 1000)::bigint AS "deadlineAtEpochMs"
    FROM "AmuxOrchestratorWrite"
    WHERE "requestId" = ${requestId}
    FOR UPDATE
  `;
  const row = locked[0];
  if (!row || row.open !== true) return "closed";
  // A second statement, after the lock: it reads what the transaction the
  // lock waited for committed (see acknowledgeAmuxOrchestratorWriteLocked).
  const counted = await tx.$queryRaw<
    Array<{ receiptCount: bigint; dbNowEpochMs: bigint }>
  >`
    SELECT
      (SELECT count(*) FROM "AmuxOrchestratorWriteReceipt" WHERE "requestId" = ${requestId})::bigint
        AS "receiptCount",
      floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS "dbNowEpochMs"
  `;
  const judgement = judgeAmuxOrchestratorWrite({
    dbNowMs: epochMs(counted[0]?.dbNowEpochMs),
    deadlineAtMs: epochMs(row.deadlineAtEpochMs),
    receiptCount: Number(counted[0]?.receiptCount ?? 0),
  });
  if (judgement !== "no_commit") return judgement;
  await writeAmuxOrchestratorSystemAudit(tx, {
    action: AMUX_ORCHESTRATOR_AUDIT_ACTIONS.writeResolved,
    targetType: "AmuxOrchestratorWrite",
    targetId: requestId,
    summary: "Resolved an AMUX orchestrator write as committing nothing.",
    metadata: amuxOrchestratorAuditMetadata({
      request_id: requestId,
      call_kind: row.callKind,
      resolution: "no_commit",
    }),
  });
  const updated = await tx.$executeRaw`
    UPDATE "AmuxOrchestratorWrite"
    SET "resolution" = 'no_commit', "resolvedAt" = clock_timestamp()
    WHERE "requestId" = ${requestId} AND "ackedAt" IS NULL AND "resolvedAt" IS NULL
  `;
  if (updated !== 1) {
    throw new Error("AMUX orchestrator write changed under its own row lock");
  }
  return "no_commit";
}

export type AmuxOrchestratorHaltRow = {
  haltId: string;
  haltKey: string;
  reasonCode: AmuxOrchestratorHaltReasonCode;
  requestId: string | null;
  openedAt: string;
  cleared: boolean;
};

type RawHaltRow = {
  id: string;
  haltKey: string;
  reasonCode: string;
  requestId: string | null;
  openedAtEpochMs: bigint;
  cleared: boolean;
};

const haltRow = (row: RawHaltRow): AmuxOrchestratorHaltRow => ({
  haltId: row.id,
  haltKey: row.haltKey,
  reasonCode: row.reasonCode as AmuxOrchestratorHaltReasonCode,
  requestId: row.requestId,
  openedAt: new Date(epochMs(row.openedAtEpochMs)).toISOString(),
  cleared: row.cleared === true,
});

/**
 * A halt counts as cleared only when all three clear columns are written and
 * the audit entry they name is the human `amux.orchestrator.halt_cleared`
 * (section 6: "사람 감사 amux.orchestrator.halt_cleared가 있을 때만").
 */
const selectHaltsByKeys = (tx: Prisma.TransactionClient, haltKeys: readonly string[]) =>
  tx.$queryRaw<RawHaltRow[]>`
    SELECT
      h."id",
      h."haltKey",
      h."reasonCode",
      h."requestId",
      floor(extract(epoch FROM h."openedAt") * 1000)::bigint AS "openedAtEpochMs",
      (
        h."clearedAt" IS NOT NULL
        AND h."clearedByUserId" IS NOT NULL
        AND a."id" IS NOT NULL
      ) AS "cleared"
    FROM "AmuxOrchestratorHalt" h
    LEFT JOIN "AdminAuditLog" a
      ON a."id" = h."clearAuditLogId"
     AND a."action" = ${AMUX_ORCHESTRATOR_AUDIT_ACTIONS.haltCleared}
     AND a."actorUserId" = h."clearedByUserId"
    WHERE h."haltKey" IN (${Prisma.join([...haltKeys])})
  `;

/**
 * Section 5: opens one halt, or returns the halt already recorded under the
 * same key. An advisory lock on the key serialises two openings of it, so the
 * second finds the first instead of failing on the unique index; the system
 * audit `amux.orchestrator.halted` comes before the row, which the trigger
 * requires. The call kind is copied from the admission when there is one.
 */
export async function openAmuxOrchestratorHaltLocked(
  tx: Prisma.TransactionClient,
  record: AmuxOrchestratorHaltRecord,
): Promise<{ halt: AmuxOrchestratorHaltRow; created: boolean }> {
  await tx.$executeRaw`
    SELECT pg_advisory_xact_lock(hashtext(${`tomverse-amux-orchestrator-halt:${record.haltKey}`}))
  `;
  const existing = await selectHaltsByKeys(tx, [record.haltKey]);
  if (existing[0]) return { halt: haltRow(existing[0]), created: false };

  const callKind =
    record.requestId === null
      ? null
      : ((
          await tx.$queryRaw<Array<{ callKind: string }>>`
            SELECT "callKind" FROM "AmuxOrchestratorWrite"
            WHERE "requestId" = ${record.requestId}
          `
        )[0]?.callKind ?? null);
  const haltId = randomUUID();
  await writeAmuxOrchestratorSystemAudit(tx, {
    action: AMUX_ORCHESTRATOR_AUDIT_ACTIONS.halted,
    targetType: "AmuxOrchestratorHalt",
    targetId: haltId,
    summary: "Recorded an AMUX orchestrator halt.",
    metadata: amuxOrchestratorAuditMetadata({
      halt_id: haltId,
      halt_key: record.haltKey,
      reason_code: record.reasonCode,
      request_id: record.requestId,
      call_kind: callKind,
    }),
  });
  const inserted = await tx.$queryRaw<RawHaltRow[]>`
    INSERT INTO "AmuxOrchestratorHalt" ("id", "haltKey", "reasonCode", "requestId", "openedAt")
    VALUES (${haltId}, ${record.haltKey}, ${record.reasonCode}, ${record.requestId}, clock_timestamp())
    RETURNING
      "id",
      "haltKey",
      "reasonCode",
      "requestId",
      floor(extract(epoch FROM "openedAt") * 1000)::bigint AS "openedAtEpochMs",
      false AS "cleared"
  `;
  const row = inserted[0];
  if (!row) throw new Error("AMUX orchestrator halt insert returned no row");
  return { halt: haltRow(row), created: true };
}

export const AMUX_ORCHESTRATOR_STATE_LIST_LIMIT = 50;

export type AmuxOrchestratorHaltState = {
  openHaltCount: number;
  openHalts: AmuxOrchestratorHaltRow[];
  pendingCount: number;
  latestDeadlineAt: string | null;
  retryAfterMs: number | null;
  humanRequiredCount: number;
  humanRequired: Array<{
    requestId: string;
    callKind: AmuxOrchestratorCallKind;
    receiptCount: number;
  }>;
  halts: Array<{ haltKey: string; haltId: string; cleared: boolean }>;
};

/**
 * Section 5, the halt state, read after the resolver has run. Undecided means
 * neither acknowledged nor resolved and either before its deadline plus the
 * grace, or after it with no receipt yet decided (the resolver left it for a
 * later read). Needing a person means after it with a receipt. Lists are
 * bounded; the counts are not.
 */
export async function readAmuxOrchestratorHaltState(
  tx: Prisma.TransactionClient,
  haltKeys: readonly string[],
): Promise<AmuxOrchestratorHaltState> {
  const open = await tx.$queryRaw<RawHaltRow[]>`
    SELECT
      "id",
      "haltKey",
      "reasonCode",
      "requestId",
      floor(extract(epoch FROM "openedAt") * 1000)::bigint AS "openedAtEpochMs",
      false AS "cleared"
    FROM "AmuxOrchestratorHalt"
    WHERE "clearedAt" IS NULL
    ORDER BY "openedAt" ASC, "id" ASC
    LIMIT ${AMUX_ORCHESTRATOR_STATE_LIST_LIMIT}
  `;
  const summary = await tx.$queryRaw<
    Array<{
      openHaltCount: bigint;
      pendingCount: bigint;
      latestDeadlineEpochMs: bigint | null;
      humanRequiredCount: bigint;
      dbNowEpochMs: bigint;
    }>
  >`
    WITH clock AS MATERIALIZED (SELECT clock_timestamp() AS "now"),
    unsettled AS MATERIALIZED (
      SELECT
        w."deadlineAt",
        (
          w."deadlineAt" + ${AMUX_ORCHESTRATOR_DEADLINE_GRACE_MS} * INTERVAL '1 millisecond'
            <= (SELECT "now" FROM clock)
        ) AS "pastGrace",
        EXISTS (
          SELECT 1 FROM "AmuxOrchestratorWriteReceipt" r WHERE r."requestId" = w."requestId"
        ) AS "hasReceipt"
      FROM "AmuxOrchestratorWrite" w
      WHERE w."ackedAt" IS NULL AND w."resolvedAt" IS NULL
    )
    SELECT
      (SELECT count(*) FROM "AmuxOrchestratorHalt" WHERE "clearedAt" IS NULL)::bigint
        AS "openHaltCount",
      (SELECT count(*) FROM unsettled WHERE NOT "pastGrace" OR NOT "hasReceipt")::bigint
        AS "pendingCount",
      (
        SELECT floor(extract(epoch FROM max("deadlineAt")) * 1000)::bigint
        FROM unsettled
        WHERE NOT "pastGrace" OR NOT "hasReceipt"
      ) AS "latestDeadlineEpochMs",
      (SELECT count(*) FROM unsettled WHERE "pastGrace" AND "hasReceipt")::bigint
        AS "humanRequiredCount",
      floor(extract(epoch FROM (SELECT "now" FROM clock)) * 1000)::bigint AS "dbNowEpochMs"
  `;
  const human = await tx.$queryRaw<
    Array<{ requestId: string; callKind: string; receiptCount: bigint }>
  >`
    SELECT
      w."requestId",
      w."callKind",
      (SELECT count(*) FROM "AmuxOrchestratorWriteReceipt" r WHERE r."requestId" = w."requestId")::bigint
        AS "receiptCount"
    FROM "AmuxOrchestratorWrite" w
    WHERE w."ackedAt" IS NULL
      AND w."resolvedAt" IS NULL
      AND w."deadlineAt" + ${AMUX_ORCHESTRATOR_DEADLINE_GRACE_MS} * INTERVAL '1 millisecond'
        <= clock_timestamp()
      AND EXISTS (
        SELECT 1 FROM "AmuxOrchestratorWriteReceipt" r WHERE r."requestId" = w."requestId"
      )
    ORDER BY w."deadlineAt" ASC, w."requestId" ASC
    LIMIT ${AMUX_ORCHESTRATOR_STATE_LIST_LIMIT}
  `;
  const keyed = haltKeys.length === 0 ? [] : await selectHaltsByKeys(tx, haltKeys);

  const totals = summary[0];
  const dbNowMs = epochMs(totals?.dbNowEpochMs);
  const pendingCount = Number(totals?.pendingCount ?? 0);
  const latestDeadlineMs =
    totals?.latestDeadlineEpochMs === null || totals?.latestDeadlineEpochMs === undefined
      ? null
      : epochMs(totals.latestDeadlineEpochMs);
  return {
    openHaltCount: Number(totals?.openHaltCount ?? 0),
    openHalts: open.map(haltRow),
    pendingCount,
    latestDeadlineAt:
      pendingCount > 0 && latestDeadlineMs !== null
        ? new Date(latestDeadlineMs).toISOString()
        : null,
    retryAfterMs:
      pendingCount > 0 && latestDeadlineMs !== null
        ? Math.max(0, latestDeadlineMs + AMUX_ORCHESTRATOR_DEADLINE_GRACE_MS - dbNowMs)
        : null,
    humanRequiredCount: Number(totals?.humanRequiredCount ?? 0),
    humanRequired: human.map((row) => ({
      requestId: row.requestId,
      callKind: row.callKind as AmuxOrchestratorCallKind,
      receiptCount: Number(row.receiptCount),
    })),
    halts: keyed.map((row) => ({
      haltKey: row.haltKey,
      haltId: row.id,
      cleared: row.cleared === true,
    })),
  };
}

export class AmuxOrchestratorHaltClearError extends Error {
  readonly code: "not_found" | "already_cleared" | "halt_key_mismatch";
  readonly httpStatus: number;

  constructor(code: AmuxOrchestratorHaltClearError["code"], httpStatus: number) {
    super(code);
    this.name = "AmuxOrchestratorHaltClearError";
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

const CLEAR_STATEMENT_TIMEOUT_MS = 5_000;

/**
 * Section 7: a person clears one halt. The caller has already checked the
 * owner role and a recent step-up. In one transaction, in this lock order
 * (halt row, then the admission, then the audit chain): the typed halt key
 * prefix is compared, the human audit `amux.orchestrator.halt_cleared` is
 * written, the three clear columns are written once, and the related
 * admission, if it exists and is not resolved, is closed `human_confirmed`,
 * which closes its receipts with it. Nothing here claims, recovers or ticks:
 * the original operation is never run again.
 */
export async function clearAmuxOrchestratorHalt(input: {
  session: Session;
  request: Request;
  haltId: string;
  haltKeyPrefix: unknown;
}): Promise<{ haltId: string; admissionClosed: boolean }> {
  const userId = input.session.user?.id;
  if (!userId) throw new AmuxOrchestratorHaltClearError("not_found", 404);
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(CLEAR_STATEMENT_TIMEOUT_MS)}, true)`;
      const halts = await tx.$queryRaw<
        Array<{
          id: string;
          haltKey: string;
          reasonCode: string;
          requestId: string | null;
          cleared: boolean;
        }>
      >`
        SELECT "id", "haltKey", "reasonCode", "requestId", ("clearedAt" IS NOT NULL) AS "cleared"
        FROM "AmuxOrchestratorHalt"
        WHERE "id" = ${input.haltId}
        FOR UPDATE
      `;
      const halt = halts[0];
      if (!halt) throw new AmuxOrchestratorHaltClearError("not_found", 404);
      if (halt.cleared) throw new AmuxOrchestratorHaltClearError("already_cleared", 409);
      if (!amuxOrchestratorHaltKeyPrefixMatches(halt.haltKey, input.haltKeyPrefix)) {
        throw new AmuxOrchestratorHaltClearError("halt_key_mismatch", 409);
      }
      const admission =
        halt.requestId === null
          ? null
          : ((
              await tx.$queryRaw<Array<{ resolved: boolean }>>`
                SELECT ("resolvedAt" IS NOT NULL) AS "resolved"
                FROM "AmuxOrchestratorWrite"
                WHERE "requestId" = ${halt.requestId}
                FOR UPDATE
              `
            )[0] ?? null);
      const closesAdmission = admission !== null && admission.resolved !== true;
      const auditId = await writeAdminAuditLog({
        session: input.session,
        request: input.request,
        action: AMUX_ORCHESTRATOR_AUDIT_ACTIONS.haltCleared,
        targetType: "AmuxOrchestratorHalt",
        targetId: halt.id,
        summary: "Cleared an AMUX orchestrator halt.",
        metadata: amuxOrchestratorAuditMetadata({
          halt_id: halt.id,
          halt_key: halt.haltKey,
          reason_code: halt.reasonCode,
          request_id: halt.requestId,
          resolution: closesAdmission ? "human_confirmed" : null,
        }),
        tx,
      });
      const cleared = await tx.$executeRaw`
        UPDATE "AmuxOrchestratorHalt"
        SET
          "clearedAt" = clock_timestamp(),
          "clearedByUserId" = ${userId},
          "clearAuditLogId" = ${auditId}
        WHERE "id" = ${halt.id} AND "clearedAt" IS NULL
      `;
      if (cleared !== 1) throw new Error("AMUX orchestrator halt changed under its own row lock");
      if (closesAdmission && halt.requestId !== null) {
        const closed = await tx.$executeRaw`
          UPDATE "AmuxOrchestratorWrite"
          SET "resolution" = 'human_confirmed', "resolvedAt" = clock_timestamp()
          WHERE "requestId" = ${halt.requestId} AND "resolvedAt" IS NULL
        `;
        if (closed !== 1) {
          throw new Error("AMUX orchestrator write changed under its own row lock");
        }
      }
      return { haltId: halt.id, admissionClosed: closesAdmission };
    },
    { maxWait: 2_000, timeout: CLEAR_STATEMENT_TIMEOUT_MS * 2 },
  );
}

/** The Execution tab and sidebar badge: halts no person has cleared yet. */
export const countOpenAmuxOrchestratorHalts = (): Promise<number> =>
  prisma.amuxOrchestratorHalt.count({ where: { clearedAt: null } });

/** Admission paths use this store-owned read in their existing transaction. */
export const findOpenAmuxOrchestratorHalt = (tx: Prisma.TransactionClient) =>
  tx.amuxOrchestratorHalt.findFirst({
    where: { clearedAt: null }, select: { id: true },
  });

export const AMUX_ORCHESTRATOR_ADMIN_OPEN_LIMIT = 50;
export const AMUX_ORCHESTRATOR_ADMIN_CLEARED_LIMIT = 20;
export const AMUX_ORCHESTRATOR_ADMIN_RECEIPT_LIMIT = 20;

export type AmuxOrchestratorAdminReceipt = {
  targetKind: AmuxOrchestratorReceiptTargetKind;
  targetId: string | null;
  rowCount: number;
  committedAt: string;
};

export type AmuxOrchestratorAdminWrite = {
  requestId: string;
  callKind: AmuxOrchestratorCallKind;
  admittedAt: string;
  deadlineAt: string;
  ackedAt: string | null;
  resolvedAt: string | null;
  resolution: string | null;
  receiptCount: number;
  receipts: AmuxOrchestratorAdminReceipt[];
};

export type AmuxOrchestratorAdminHalt = {
  haltId: string;
  haltKey: string;
  reasonCode: AmuxOrchestratorHaltReasonCode;
  requestId: string | null;
  openedAt: string;
  clearedAt: string | null;
  write: AmuxOrchestratorAdminWrite | null;
};

export type AmuxOrchestratorAdminView = {
  openCount: number;
  clearedCount: number;
  open: AmuxOrchestratorAdminHalt[];
  cleared: AmuxOrchestratorAdminHalt[];
  humanRequired: AmuxOrchestratorAdminWrite[];
  humanRequiredCount: number;
};

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

/**
 * The halts tab. Reads only: the judgement of which requests need a person is
 * computed here from the same rule as the resolver, and nothing is resolved
 * or written from the Admin console's read.
 */
export async function readAmuxOrchestratorHaltsForAdmin(): Promise<AmuxOrchestratorAdminView> {
  const graceCutoffSql = Prisma.sql`clock_timestamp() - ${AMUX_ORCHESTRATOR_DEADLINE_GRACE_MS} * INTERVAL '1 millisecond'`;
  const [openCount, clearedCount, open, cleared, humanIds, humanCount] = await Promise.all([
    prisma.amuxOrchestratorHalt.count({ where: { clearedAt: null } }),
    prisma.amuxOrchestratorHalt.count({ where: { clearedAt: { not: null } } }),
    prisma.amuxOrchestratorHalt.findMany({
      where: { clearedAt: null },
      orderBy: [{ openedAt: "desc" }, { id: "asc" }],
      take: AMUX_ORCHESTRATOR_ADMIN_OPEN_LIMIT,
    }),
    prisma.amuxOrchestratorHalt.findMany({
      where: { clearedAt: { not: null } },
      orderBy: [{ clearedAt: "desc" }, { id: "asc" }],
      take: AMUX_ORCHESTRATOR_ADMIN_CLEARED_LIMIT,
    }),
    prisma.$queryRaw<Array<{ requestId: string }>>`
      SELECT w."requestId"
      FROM "AmuxOrchestratorWrite" w
      WHERE w."ackedAt" IS NULL
        AND w."resolvedAt" IS NULL
        AND w."deadlineAt" <= ${graceCutoffSql}
        AND EXISTS (SELECT 1 FROM "AmuxOrchestratorWriteReceipt" r WHERE r."requestId" = w."requestId")
      ORDER BY w."deadlineAt" ASC, w."requestId" ASC
      LIMIT ${AMUX_ORCHESTRATOR_ADMIN_OPEN_LIMIT}
    `,
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT count(*)::bigint AS "count"
      FROM "AmuxOrchestratorWrite" w
      WHERE w."ackedAt" IS NULL
        AND w."resolvedAt" IS NULL
        AND w."deadlineAt" <= ${graceCutoffSql}
        AND EXISTS (SELECT 1 FROM "AmuxOrchestratorWriteReceipt" r WHERE r."requestId" = w."requestId")
    `,
  ]);
  const requestIds = [
    ...new Set([
      ...open.map((row) => row.requestId),
      ...cleared.map((row) => row.requestId),
      ...humanIds.map((row) => row.requestId),
    ].filter((value): value is string => value !== null)),
  ];
  const writes =
    requestIds.length === 0
      ? []
      : await prisma.amuxOrchestratorWrite.findMany({
          where: { requestId: { in: requestIds } },
          include: {
            receipts: {
              orderBy: [{ committedAt: "asc" }, { id: "asc" }],
              take: AMUX_ORCHESTRATOR_ADMIN_RECEIPT_LIMIT,
            },
            _count: { select: { receipts: true } },
          },
        });
  const byRequest = new Map<string, AmuxOrchestratorAdminWrite>(
    writes.map((write) => [
      write.requestId,
      {
        requestId: write.requestId,
        callKind: write.callKind as AmuxOrchestratorCallKind,
        admittedAt: write.admittedAt.toISOString(),
        deadlineAt: write.deadlineAt.toISOString(),
        ackedAt: iso(write.ackedAt),
        resolvedAt: iso(write.resolvedAt),
        resolution: write.resolution,
        receiptCount: write._count.receipts,
        receipts: write.receipts.map((receipt) => ({
          targetKind: receipt.targetKind as AmuxOrchestratorReceiptTargetKind,
          targetId: receipt.targetId,
          rowCount: receipt.rowCount,
          committedAt: receipt.committedAt.toISOString(),
        })),
      },
    ]),
  );
  const adminHalt = (row: (typeof open)[number]): AmuxOrchestratorAdminHalt => ({
    haltId: row.id,
    haltKey: row.haltKey,
    reasonCode: row.reasonCode as AmuxOrchestratorHaltReasonCode,
    requestId: row.requestId,
    openedAt: row.openedAt.toISOString(),
    clearedAt: iso(row.clearedAt),
    write: row.requestId ? (byRequest.get(row.requestId) ?? null) : null,
  });
  return {
    openCount,
    clearedCount,
    open: open.map(adminHalt),
    cleared: cleared.map(adminHalt),
    humanRequired: humanIds
      .map((row) => byRequest.get(row.requestId))
      .filter((value): value is AmuxOrchestratorAdminWrite => value !== undefined),
    humanRequiredCount: Number(humanCount[0]?.count ?? 0),
  };
}
