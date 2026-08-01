import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AiProvider } from "@/lib/models";
import {
  DEFAULT_RECOVERY_EVIDENCE_MAX_AGE_SECONDS,
  DEFAULT_VERIFICATION_COOLDOWN_SECONDS,
  LIVE_VERIFICATION_KIND,
  evaluateRecoveryEligibility,
  verificationCooldownRemainingSeconds,
  type RecoveryRejectionReason,
} from "@/lib/providerRecoveryCore";
import type { ProviderVerificationResult } from "@/lib/providerVerification";

// STG-R002: the durable side of administrator verification and verified
// recovery. Every state change here is either a single conditional UPDATE or
// wrapped in one transaction, so a duplicate submit, a concurrent operator or
// a mid-flight crash can never leave a provider half-recovered.
//
// The invariant: ProviderHealthState.lastSuccessAt is only ever written by
// real user traffic (recordProviderSuccess). Nothing in this file touches it.

const cooldownSeconds = () => {
  const parsed = Number(process.env.PROVIDER_VERIFICATION_COOLDOWN_SECONDS);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_VERIFICATION_COOLDOWN_SECONDS;
};

const recoveryEvidenceMaxAgeSeconds = () => {
  const parsed = Number(
    process.env.PROVIDER_RECOVERY_EVIDENCE_MAX_AGE_SECONDS
  );
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : DEFAULT_RECOVERY_EVIDENCE_MAX_AGE_SECONDS;
};

/** Signals that the provider block vanished between this transaction's read
 *  and its write, so the transaction must roll back rather than consume the
 *  verification evidence for a recovery that did not happen. */
class ProviderRecoveryConflictError extends Error {
  constructor() {
    super("Provider recovery conflicted with a concurrent state change.");
    this.name = "ProviderRecoveryConflictError";
  }
}

const providerLockKey = (provider: AiProvider) =>
  `tomverse-provider-verification:${provider}`;

const tryProviderLock = async (
  tx: Pick<typeof prisma, "$queryRaw">,
  provider: AiProvider
) => {
  const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`
    SELECT pg_try_advisory_xact_lock(hashtext(${providerLockKey(provider)})) AS "locked"
  `;
  return rows[0]?.locked === true;
};

export type VerificationClaim =
  | { ok: true; checkId: string; startedAt: Date }
  | {
      ok: false;
      reason: "in_progress" | "cooldown";
      retryAfterSeconds: number;
    };

/**
 * Reserves the right to run one live verification for a provider, and records
 * the attempt up front as a "running" ProviderHealthCheck row.
 *
 * Doing this before the provider call (rather than writing one row afterwards)
 * is what makes the cooldown real: two concurrent requests contend on the same
 * advisory lock, and the loser sees the winner's row. A provider call is far
 * too slow to hold a transaction open across, so the row is committed first
 * and completed by recordVerificationResult().
 */
export async function claimVerificationSlot({
  provider,
  modelId,
  traceId,
  actorId,
  actorEmail,
  now = new Date(),
}: {
  provider: AiProvider;
  modelId: string | null;
  traceId: string;
  actorId: string | null;
  actorEmail: string | null;
  now?: Date;
}): Promise<VerificationClaim> {
  const configuredCooldown = cooldownSeconds();
  return prisma.$transaction(async (tx) => {
    if (!(await tryProviderLock(tx, provider))) {
      return {
        ok: false as const,
        reason: "in_progress" as const,
        retryAfterSeconds: Math.min(configuredCooldown, 10),
      };
    }

    const lastAttempt = await tx.providerHealthCheck.findFirst({
      where: { provider, kind: LIVE_VERIFICATION_KIND },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    });
    const remaining = verificationCooldownRemainingSeconds({
      now,
      lastAttemptAt: lastAttempt?.createdAt ?? null,
      cooldownSeconds: configuredCooldown,
    });
    if (remaining > 0) {
      return {
        ok: false as const,
        reason: "cooldown" as const,
        retryAfterSeconds: remaining,
      };
    }

    const check = await tx.providerHealthCheck.create({
      data: {
        provider,
        modelId,
        kind: LIVE_VERIFICATION_KIND,
        status: "running",
        traceId,
        createdById: actorId,
        createdByEmail: actorEmail,
      },
      select: { id: true, createdAt: true },
    });
    return { ok: true as const, checkId: check.id, startedAt: check.createdAt };
  });
}

/**
 * Completes a claimed verification with its sanitized outcome, and records the
 * result as verification evidence on ProviderHealthState.
 *
 * lastVerificationSuccessAt is a separate column from lastSuccessAt on
 * purpose: an operator proving the API answers is not the same claim as "real
 * user traffic is being served", and conflating the two would let a synthetic
 * call masquerade as production health.
 */
export async function recordVerificationResult({
  checkId,
  result,
}: {
  checkId: string;
  result: ProviderVerificationResult;
}): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.providerHealthCheck.update({
      where: { id: checkId },
      data: {
        status: result.status === "success" ? "success" : result.status,
        modelId: result.modelId,
        latencyMs: result.latencyMs,
        errorCode: result.errorClassification,
        diagnosticCode: result.diagnosticCode,
        message: result.message,
      },
    });

    // "unavailable" means the call was never attempted (no key, no eligible
    // model), so it is evidence of a configuration gap, not of the provider's
    // behaviour -- it must not be written into either verification column.
    if (result.status === "success") {
      await tx.$executeRaw`
        INSERT INTO "ProviderHealthState" ("provider", "lastVerificationSuccessAt", "updatedAt")
        VALUES (${result.provider}, NOW(), NOW())
        ON CONFLICT ("provider")
        DO UPDATE SET
          "lastVerificationSuccessAt" = NOW(),
          "updatedAt" = NOW()
      `;
      return;
    }
    if (result.status === "failed") {
      await tx.$executeRaw`
        INSERT INTO "ProviderHealthState" ("provider", "lastVerificationFailureAt", "updatedAt")
        VALUES (${result.provider}, NOW(), NOW())
        ON CONFLICT ("provider")
        DO UPDATE SET
          "lastVerificationFailureAt" = NOW(),
          "updatedAt" = NOW()
      `;
    }
  });
}

export type RecoveryOutcome =
  | {
      ok: true;
      previousConsecutiveFailures: number;
      resultingConsecutiveFailures: 0;
      verifiedAt: Date;
    }
  | { ok: false; reason: RecoveryRejectionReason; detail: string };

/**
 * Clears a provider's blocking consecutive-failure counter, but only against a
 * successful, recent, not-yet-consumed live verification.
 *
 * The whole operation is one transaction:
 *
 *   1. take the provider's advisory lock, so two operators cannot both recover;
 *   2. re-read the evidence *inside* the transaction and re-run the same
 *      eligibility rules the UI used, because a disabled button is a courtesy
 *      and never the control;
 *   3. consume the evidence with a conditional UPDATE (recoveryApplied = false
 *      -> true), which is what makes a double submit a no-op rather than a
 *      second reset;
 *   4. zero consecutiveFailures with a conditional UPDATE of its own.
 *
 * lastSuccessAt is deliberately untouched. Clearing the block says "stop
 * treating stale failures as current evidence"; it does not fabricate a
 * success that never happened.
 */
export async function applyVerifiedRecovery({
  provider,
  checkId,
  now = new Date(),
}: {
  provider: AiProvider;
  checkId: string;
  now?: Date;
}): Promise<RecoveryOutcome> {
  const maxAgeSeconds = recoveryEvidenceMaxAgeSeconds();
  return prisma.$transaction(async (tx) => {
    if (!(await tryProviderLock(tx, provider))) {
      return {
        ok: false as const,
        reason: "VERIFICATION_ALREADY_CONSUMED" as const,
        detail:
          "Another recovery for this provider is already in progress. Refresh and check the result before retrying.",
      };
    }

    const [evidence, state] = await Promise.all([
      tx.providerHealthCheck.findUnique({
        where: { id: checkId },
        select: {
          provider: true,
          kind: true,
          status: true,
          createdAt: true,
          recoveryApplied: true,
        },
      }),
      tx.providerHealthState.findUnique({
        where: { provider },
        select: { consecutiveFailures: true },
      }),
    ]);

    const previousConsecutiveFailures = state?.consecutiveFailures ?? 0;
    const eligibility = evaluateRecoveryEligibility({
      now,
      provider,
      evidence,
      consecutiveFailures: previousConsecutiveFailures,
      maxEvidenceAgeSeconds: maxAgeSeconds,
    });
    if (!eligibility.allowed) {
      return {
        ok: false as const,
        reason: eligibility.reason,
        detail: eligibility.detail,
      };
    }

    const consumed = await tx.providerHealthCheck.updateMany({
      where: { id: checkId, recoveryApplied: false },
      data: {
        recoveryApplied: true,
        recoveryAppliedAt: now,
        previousConsecutiveFailures,
      },
    });
    if (consumed.count !== 1) {
      return {
        ok: false as const,
        reason: "VERIFICATION_ALREADY_CONSUMED" as const,
        detail:
          "This verification was consumed by another recovery request. Run a new verification first.",
      };
    }

    const cleared = await tx.providerHealthState.updateMany({
      where: { provider, consecutiveFailures: { gt: 0 } },
      data: {
        consecutiveFailures: 0,
        lastRecoveryAt: now,
        lastRecoveryCheckId: checkId,
      },
    });
    if (cleared.count !== 1) {
      // The block disappeared between the read and the write (a real success
      // landed, or another recovery won). Rolling back keeps the evidence
      // unconsumed so it can still authorise a recovery if one is needed.
      throw new ProviderRecoveryConflictError();
    }

    return {
      ok: true as const,
      previousConsecutiveFailures,
      resultingConsecutiveFailures: 0 as const,
      verifiedAt: evidence!.createdAt,
    };
  }).catch((error: unknown) => {
    if (error instanceof ProviderRecoveryConflictError) {
      return {
        ok: false as const,
        reason: "NOT_BLOCKED" as const,
        detail:
          "The provider block was cleared by another request before this recovery could apply.",
      };
    }
    throw error;
  });
}

export type ProviderVerificationSummary = {
  provider: string;
  lastCheck: {
    id: string;
    status: string;
    modelId: string | null;
    latencyMs: number | null;
    diagnosticCode: string | null;
    errorCode: string | null;
    message: string | null;
    createdAt: string;
    createdByEmail: string | null;
    recoveryApplied: boolean;
  } | null;
  recentRecoveries: Array<{
    id: string;
    modelId: string | null;
    previousConsecutiveFailures: number | null;
    recoveryAppliedAt: string | null;
    createdByEmail: string | null;
  }>;
};

/**
 * Last verification result and recent recovery history per provider, for the
 * admin console. Reads only columns that are public-safe by contract -- there
 * is no raw provider response or credential anywhere in this table.
 */
export async function getProviderVerificationSummaries(
  providers: AiProvider[]
): Promise<Map<string, ProviderVerificationSummary>> {
  if (providers.length === 0) return new Map();

  const [latestChecks, recoveries] = await Promise.all([
    // DISTINCT ON gives exactly one row per provider -- the newest. A plain
    // "order by createdAt desc, take N" would silently drop a provider whose
    // last verification is older than N other providers' checks, which is
    // precisely the provider an operator is most likely to be looking at.
    prisma.$queryRaw<
      Array<{
        id: string;
        provider: string;
        status: string;
        modelId: string | null;
        latencyMs: number | null;
        diagnosticCode: string | null;
        errorCode: string | null;
        message: string | null;
        createdAt: Date;
        createdByEmail: string | null;
        recoveryApplied: boolean;
      }>
    >`
      SELECT DISTINCT ON ("provider")
        "id", "provider", "status", "modelId", "latencyMs", "diagnosticCode",
        "errorCode", "message", "createdAt", "createdByEmail", "recoveryApplied"
      FROM "ProviderHealthCheck"
      WHERE "kind" = ${LIVE_VERIFICATION_KIND}
        AND "provider" IN (${Prisma.join(providers)})
      ORDER BY "provider", "createdAt" DESC
    `,
    prisma.providerHealthCheck.findMany({
      where: {
        provider: { in: providers },
        kind: LIVE_VERIFICATION_KIND,
        recoveryApplied: true,
      },
      orderBy: { recoveryAppliedAt: "desc" },
      take: 100,
      select: {
        id: true,
        provider: true,
        modelId: true,
        previousConsecutiveFailures: true,
        recoveryAppliedAt: true,
        createdByEmail: true,
      },
    }),
  ]);

  const summaries = new Map<string, ProviderVerificationSummary>();
  for (const provider of providers) {
    const lastCheck = latestChecks.find((row) => row.provider === provider);
    summaries.set(provider, {
      provider,
      lastCheck: lastCheck
        ? {
            id: lastCheck.id,
            status: lastCheck.status,
            modelId: lastCheck.modelId,
            latencyMs: lastCheck.latencyMs,
            diagnosticCode: lastCheck.diagnosticCode,
            errorCode: lastCheck.errorCode,
            message: lastCheck.message,
            createdAt: lastCheck.createdAt.toISOString(),
            createdByEmail: lastCheck.createdByEmail,
            recoveryApplied: lastCheck.recoveryApplied,
          }
        : null,
      recentRecoveries: recoveries
        .filter((row) => row.provider === provider)
        .slice(0, 3)
        .map((row) => ({
          id: row.id,
          modelId: row.modelId,
          previousConsecutiveFailures: row.previousConsecutiveFailures,
          recoveryAppliedAt: row.recoveryAppliedAt?.toISOString() ?? null,
          createdByEmail: row.createdByEmail,
        })),
    });
  }
  return summaries;
}
