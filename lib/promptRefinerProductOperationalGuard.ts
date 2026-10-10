import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { PROMPT_REFINER_PRODUCT_TIMEOUT_MS } from
  "@/lib/promptRefinerProductContract";

export const PROMPT_REFINER_PRODUCT_AUTO_GUARD_ID = "auto";
export const PROMPT_REFINER_PRODUCT_OPERATIONAL_SAMPLE_SIZE = 100;
export const PROMPT_REFINER_PRODUCT_P90_LIMIT_MS = 6_000;
export const PROMPT_REFINER_PRODUCT_FALLBACK_LIMIT = 5;

export const PROMPT_REFINER_PRODUCT_AUTO_GUARD_STATES =
  ["active", "paused"] as const;
export const PROMPT_REFINER_PRODUCT_AUTO_STOP_REASONS = [
  "latency_p90_exceeded",
  "original_fallback_rate_exceeded",
  "critical_safety_failure",
  "unknown_dispatch_or_cost",
  "audit_failure",
] as const;

export type PromptRefinerProductAutoGuardState =
  typeof PROMPT_REFINER_PRODUCT_AUTO_GUARD_STATES[number];
export type PromptRefinerProductAutoStopReason =
  typeof PROMPT_REFINER_PRODUCT_AUTO_STOP_REASONS[number];
export type PromptRefinerProductImmediateAutoStopReason = Extract<
  PromptRefinerProductAutoStopReason,
  "critical_safety_failure" | "unknown_dispatch_or_cost" | "audit_failure"
>;

type Tx = Prisma.TransactionClient;
type GuardRow = Readonly<{
  id: string;
  state: PromptRefinerProductAutoGuardState;
  generation: number;
  baselineAt: Date;
  pausedAt: Date | null;
  reasonCode: PromptRefinerProductAutoStopReason | null;
  sampleSize: number;
  p90LatencyMs: number | null;
  fallbackCount: number | null;
  lastTransitionAuditLogId: string;
  transitionedAt: Date;
}>;
type Observation = Readonly<{
  reasonCode: PromptRefinerProductAutoStopReason;
  sampleSize: number;
  p90LatencyMs: number | null;
  fallbackCount: number | null;
}>;
type CurrentReceiptIds = Readonly<{
  executionReceiptId?: string;
  dispositionReceiptId?: string;
}>;

const options = { maxWait: 2_000, timeout: 10_000 };

async function lockGuard(tx: Tx): Promise<GuardRow | null> {
  const rows = await tx.$queryRaw<GuardRow[]>`
    SELECT "id", "state", "generation", "baselineAt", "pausedAt",
      "reasonCode", "sampleSize", "p90LatencyMs", "fallbackCount",
      "lastTransitionAuditLogId", "transitionedAt"
    FROM "PromptRefinerProductOperationalGuard"
    WHERE "id" = ${PROMPT_REFINER_PRODUCT_AUTO_GUARD_ID}
    FOR UPDATE
  `;
  return rows.length === 1 ? rows[0] : null;
}

export async function initializePromptRefinerProductAutoGuard(
  tx: Tx,
  activationAuditLogId: string,
) {
  await takeAuditChainLock(tx);
  const inserted = await tx.$executeRaw`
    INSERT INTO "PromptRefinerProductOperationalGuard" (
      "id", "state", "generation", "baselineAt", "pausedAt", "reasonCode",
      "sampleSize", "p90LatencyMs", "fallbackCount",
      "lastTransitionAuditLogId", "transitionedAt"
    ) VALUES (
      ${PROMPT_REFINER_PRODUCT_AUTO_GUARD_ID}, 'active', 1,
      clock_timestamp(), NULL, NULL, 0, NULL, NULL,
      ${activationAuditLogId}, clock_timestamp()
    ) ON CONFLICT ("id") DO NOTHING
  `;
  const row = await lockGuard(tx);
  if (!row) throw new Error("prompt_refiner_product_auto_guard_missing");
  return Object.freeze({ initialized: inserted === 1,
    active: row.state === "active", generation: row.generation });
}

export async function readPromptRefinerProductAutoGuard(tx: Tx) {
  const rows = await tx.$queryRaw<GuardRow[]>`
    SELECT "id", "state", "generation", "baselineAt", "pausedAt",
      "reasonCode", "sampleSize", "p90LatencyMs", "fallbackCount",
      "lastTransitionAuditLogId", "transitionedAt"
    FROM "PromptRefinerProductOperationalGuard"
    WHERE "id" = ${PROMPT_REFINER_PRODUCT_AUTO_GUARD_ID}
  `;
  const row = rows.length === 1 ? rows[0] : null;
  return Object.freeze({ active: row?.state === "active",
    generation: row?.generation ?? null,
    reasonCode: row?.reasonCode ?? null,
    transitionAuditLogId: row?.lastTransitionAuditLogId ?? null });
}

async function observe(
  tx: Tx,
  guard: GuardRow,
  current: CurrentReceiptIds,
): Promise<Observation | null> {
  const currentExecution = current.executionReceiptId
    ? await tx.$queryRaw<Array<{
      failureCode: string | null;
      attemptState: string | null;
      auditCount: number;
    }>>`
      SELECT r."failureCode", attempt."state" AS "attemptState",
        audit."count" AS "auditCount"
      FROM "PromptRefinerProductExecutionReceipt" r
      JOIN "PromptRefinerProductExecutionContext" c
        ON c."executionReceiptId" = r."id"
      LEFT JOIN "PromptRefinerProductAttempt" attempt
        ON attempt."id" = r."requestId"
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS "count" FROM "AdminAuditLog" l
        WHERE l."action" = 'prompt_refiner.product_execution_recorded'
          AND l."targetType" = 'PromptRefinerProductExecutionReceipt'
          AND l."targetId" = r."id"
      ) audit
      WHERE r."id" = ${current.executionReceiptId}
    ` : [];
  if (current.executionReceiptId && currentExecution.length !== 1) {
    return Object.freeze({ reasonCode: "audit_failure", sampleSize: 0,
      p90LatencyMs: null, fallbackCount: null });
  }
  if (currentExecution.some(row =>
    row.failureCode === "execution_contract_mismatch")) {
    return Object.freeze({ reasonCode: "critical_safety_failure", sampleSize: 0,
      p90LatencyMs: null, fallbackCount: null });
  }

  // Each product writer evaluates this guard in the same transaction that
  // inserts its receipt and audit. Keeping the observation window identical
  // to the approved latest-100 quality denominator bounds both receipt work
  // and per-receipt audit verification.
  const recent = await tx.$queryRaw<Array<{
    outcome: string;
    preparationLatencyMs: number;
    failureCode: string | null;
    attemptState: string | null;
    auditCount: number;
  }>>`
    SELECT recent."outcome", recent."preparationLatencyMs",
      recent."failureCode", attempt."state" AS "attemptState",
      audit."count" AS "auditCount"
    FROM (
      SELECT r."id", r."requestId", r."outcome", r."preparationLatencyMs",
        r."failureCode", r."completedAt"
      FROM "PromptRefinerProductExecutionReceipt" r
      JOIN "PromptRefinerProductExecutionContext" c
        ON c."executionReceiptId" = r."id"
      WHERE r."completedAt" >= ${guard.baselineAt}
      ORDER BY r."completedAt" DESC, r."id" DESC
      LIMIT ${PROMPT_REFINER_PRODUCT_OPERATIONAL_SAMPLE_SIZE}
    ) recent
    LEFT JOIN "PromptRefinerProductAttempt" attempt
      ON attempt."id" = recent."requestId"
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS "count" FROM "AdminAuditLog" l
      WHERE l."action" = 'prompt_refiner.product_execution_recorded'
        AND l."targetType" = 'PromptRefinerProductExecutionReceipt'
        AND l."targetId" = recent."id"
    ) audit
    ORDER BY recent."completedAt" DESC, recent."id" DESC
  `;
  if (recent.some(row =>
    row.failureCode === "execution_contract_mismatch")) {
    return Object.freeze({
    reasonCode: "critical_safety_failure", sampleSize: 0,
    p90LatencyMs: null, fallbackCount: null,
  });
  }

  const [unknownHold] = await tx.$queryRaw<Array<{ present: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "PromptRefinerAutoBudgetHold" h
      WHERE h."status" = 'unknown' AND h."createdAt" >= ${guard.baselineAt}
      UNION ALL
      SELECT 1 FROM "PromptRefinerAutoBudgetHold" h
      WHERE h."status" = 'dispatching'
        AND h."createdAt" >= ${guard.baselineAt}
        AND h."dispatchedAt" <= clock_timestamp() -
          ${PROMPT_REFINER_PRODUCT_TIMEOUT_MS} * INTERVAL '1 millisecond'
    ) AS "present"
  `;
  const [unknownAttempt] = await tx.$queryRaw<Array<{ present: boolean }>>`
    SELECT EXISTS (
      SELECT 1 FROM "PromptRefinerProductAttempt" attempt
      WHERE attempt."state" = 'unknown'
        AND attempt."createdAt" >=
          (${guard.baselineAt}::timestamptz AT TIME ZONE 'UTC')
      LIMIT 1
    ) AS "present"
  `;
  if (unknownHold?.present || unknownAttempt?.present || currentExecution.some(row =>
    row.attemptState === "unknown" ||
    row.failureCode === "unknown_after_dispatch") || recent.some(row =>
    row.attemptState === "unknown" ||
    row.failureCode === "unknown_after_dispatch")) return Object.freeze({
    reasonCode: "unknown_dispatch_or_cost", sampleSize: 0,
    p90LatencyMs: null, fallbackCount: null,
  });

  // expiresAt is the durable five-minute attempt lifetime created by the
  // admission writer. Once that existing boundary has passed, a preparing
  // attempt without its required receipt cannot still be normal cleanup,
  // whether the process stopped before or after reserving product budget.
  // The indexed EXISTS probe distinguishes that abandoned audit gap from an
  // unexpired writer waiting for the global audit lock.
  const [expiredReceiptGap] = await tx.$queryRaw<Array<{ present: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM "PromptRefinerProductAttempt" attempt
      WHERE attempt."state" = 'preparing'
        AND attempt."createdAt" >=
          (${guard.baselineAt}::timestamptz AT TIME ZONE 'UTC')
        AND attempt."expiresAt" <=
          (clock_timestamp() AT TIME ZONE 'UTC')
        AND NOT EXISTS (
          SELECT 1 FROM "PromptRefinerProductExecutionReceipt" receipt
          WHERE receipt."requestId" = attempt."id"
        )
      LIMIT 1
    ) AS "present"
  `;
  if (expiredReceiptGap?.present) return Object.freeze({
    reasonCode: "audit_failure", sampleSize: 0,
    p90LatencyMs: null, fallbackCount: null,
  });

  const currentDispositionAudit = current.dispositionReceiptId
    ? await tx.$queryRaw<Array<{ auditCount: number }>>`
      SELECT audit."count" AS "auditCount"
      FROM "PromptRefinerProductDispositionReceipt" d
      CROSS JOIN LATERAL (
        SELECT count(*)::int AS "count" FROM "AdminAuditLog" l
        WHERE l."action" = 'prompt_refiner.product_disposition_recorded'
          AND l."targetType" = 'PromptRefinerProductDispositionReceipt'
          AND l."targetId" = d."id"
      ) audit
      WHERE d."id" = ${current.dispositionReceiptId}
    ` : [];
  const recentDispositionAudits = await tx.$queryRaw<Array<{
    auditCount: number;
  }>>`
    SELECT audit."count" AS "auditCount"
    FROM (
      SELECT d."id", d."observedAt"
      FROM "PromptRefinerProductDispositionReceipt" d
      WHERE d."observedAt" >= ${guard.baselineAt}
      ORDER BY d."observedAt" DESC, d."id" DESC
      LIMIT ${PROMPT_REFINER_PRODUCT_OPERATIONAL_SAMPLE_SIZE}
    ) recent
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS "count" FROM "AdminAuditLog" l
      WHERE l."action" = 'prompt_refiner.product_disposition_recorded'
        AND l."targetType" = 'PromptRefinerProductDispositionReceipt'
        AND l."targetId" = recent."id"
    ) audit
  `;
  if ((current.executionReceiptId && currentExecution[0]?.auditCount !== 1) ||
      (current.dispositionReceiptId &&
        currentDispositionAudit[0]?.auditCount !== 1) ||
      recent.some(row => row.auditCount !== 1) ||
      recentDispositionAudits.some(row => row.auditCount !== 1)) {
    return Object.freeze({
    reasonCode: "audit_failure", sampleSize: 0,
    p90LatencyMs: null, fallbackCount: null,
  });
  }

  // docs/policy/prompt-refiner-vnext-full-auto-release-exception-v1.md §3
  // says the latest completed Refiner requests, not Auto-only requests.
  // Explicit and Auto share this operational quality denominator;
  // only Auto admission is stopped.
  // docs/policy/prompt-refiner-observability.md §1,
  // docs/policy/prompt-refiner-observability.md §4 and
  // docs/policy/prompt-refiner-observability.md §5 define kept_original as a
  // distinct explicit-choice disposition. It is not an execution fallback.
  // The fallback numerator is the non-suggested execution receipts that
  // caused the product service to retain the authored prompt.
  if (recent.length < PROMPT_REFINER_PRODUCT_OPERATIONAL_SAMPLE_SIZE) return null;
  const latencies = recent.map(row => row.preparationLatencyMs)
    .sort((left, right) => left - right);
  const p90LatencyMs = latencies[89] ?? 0;
  const fallbackCount = recent.filter(row => row.outcome !== "suggested").length;
  if (p90LatencyMs > PROMPT_REFINER_PRODUCT_P90_LIMIT_MS) {
    return Object.freeze({ reasonCode: "latency_p90_exceeded",
      sampleSize: recent.length, p90LatencyMs, fallbackCount });
  }
  if (fallbackCount > PROMPT_REFINER_PRODUCT_FALLBACK_LIMIT) {
    return Object.freeze({ reasonCode: "original_fallback_rate_exceeded",
      sampleSize: recent.length, p90LatencyMs, fallbackCount });
  }
  return null;
}

async function pause(tx: Tx, guard: GuardRow, observation: Observation) {
  const auditLogId = await writeSystemAuditLog({ tx,
    systemActor: "prompt-refiner-product-execution",
    action: "prompt_refiner.product_auto_paused",
    targetType: "PromptRefinerProductOperationalGuard",
    targetId: PROMPT_REFINER_PRODUCT_AUTO_GUARD_ID,
    summary: "Paused Prompt Refiner Auto on a content-free operational guard.",
    metadata: { generation: guard.generation,
      reasonCode: observation.reasonCode, sampleSize: observation.sampleSize,
      p90LatencyMs: observation.p90LatencyMs,
      fallbackCount: observation.fallbackCount },
  });
  const changed = await tx.$executeRaw`
    UPDATE "PromptRefinerProductOperationalGuard"
    SET "state" = 'paused', "pausedAt" = clock_timestamp(),
      "reasonCode" = ${observation.reasonCode},
      "sampleSize" = ${observation.sampleSize},
      "p90LatencyMs" = ${observation.p90LatencyMs},
      "fallbackCount" = ${observation.fallbackCount},
      "lastTransitionAuditLogId" = ${auditLogId},
      "transitionedAt" = clock_timestamp()
    WHERE "id" = ${PROMPT_REFINER_PRODUCT_AUTO_GUARD_ID}
      AND "state" = 'active' AND "generation" = ${guard.generation}
  `;
  if (changed !== 1) {
    throw new Error("prompt_refiner_product_auto_guard_pause_conflict");
  }
  return Object.freeze({ active: false, generation: guard.generation,
    reasonCode: observation.reasonCode });
}

export async function evaluatePromptRefinerProductAutoGuardInTransaction(
  tx: Tx,
  currentReceipts: CurrentReceiptIds = {},
) {
  const current = await readPromptRefinerProductAutoGuard(tx);
  if (!current.active) return current;
  await takeAuditChainLock(tx);
  const guard = await lockGuard(tx);
  if (!guard || guard.state !== "active") return Object.freeze({ active: false,
    generation: guard?.generation ?? null, reasonCode: guard?.reasonCode ?? null });
  const observation = await observe(tx, guard, currentReceipts);
  return observation ? pause(tx, guard, observation) : Object.freeze({
    active: true, generation: guard.generation, reasonCode: null });
}

export async function requirePromptRefinerProductAutoAdmission() {
  const result = await prisma.$transaction(
    (tx) => evaluatePromptRefinerProductAutoGuardInTransaction(tx), options);
  if (!result.active) {
    throw new Error("prompt_refiner_product_auto_operationally_paused");
  }
  return result;
}

export async function latchPromptRefinerProductAutoAuditFailure() {
  return prisma.$transaction(async (tx) => {
    return latchPromptRefinerProductAutoStopInTransaction(tx, "audit_failure");
  }, options);
}

export async function latchPromptRefinerProductAutoStopInTransaction(
  tx: Tx,
  reasonCode: PromptRefinerProductImmediateAutoStopReason,
) {
  const current = await readPromptRefinerProductAutoGuard(tx);
  if (!current.active) return current;
  await takeAuditChainLock(tx);
  const guard = await lockGuard(tx);
  if (!guard || guard.state !== "active") return Object.freeze({
    active: false, generation: guard?.generation ?? null,
    reasonCode: guard?.reasonCode ?? null });
  return pause(tx, guard, Object.freeze({ reasonCode,
    sampleSize: 0, p90LatencyMs: null, fallbackCount: null }));
}

export async function resumePromptRefinerProductAutoGuardInTransaction(
  tx: Tx,
  input: { expectedGeneration: number; resumeAuditLogId: string },
) {
  await takeAuditChainLock(tx);
  const guard = await lockGuard(tx);
  if (!guard || guard.state !== "paused" ||
      guard.generation !== input.expectedGeneration) {
    throw new Error("prompt_refiner_product_auto_resume_stale");
  }
  const changed = await tx.$executeRaw`
    UPDATE "PromptRefinerProductOperationalGuard"
    SET "state" = 'active', "generation" = "generation" + 1,
      "baselineAt" = transition_clock."at", "pausedAt" = NULL,
      "reasonCode" = NULL, "sampleSize" = 0,
      "p90LatencyMs" = NULL, "fallbackCount" = NULL,
      "lastTransitionAuditLogId" = ${input.resumeAuditLogId},
      "transitionedAt" = transition_clock."at"
    FROM (SELECT clock_timestamp() AS "at") transition_clock
    WHERE "id" = ${PROMPT_REFINER_PRODUCT_AUTO_GUARD_ID}
      AND "state" = 'paused' AND "generation" = ${input.expectedGeneration}
  `;
  if (changed !== 1) throw new Error("prompt_refiner_product_auto_resume_stale");
  const resumed = await lockGuard(tx);
  if (!resumed || resumed.state !== "active" ||
      resumed.generation !== input.expectedGeneration + 1 ||
      resumed.lastTransitionAuditLogId !== input.resumeAuditLogId) {
    throw new Error("prompt_refiner_product_auto_resume_readback_invalid");
  }
  return Object.freeze({ active: true, generation: resumed.generation });
}
