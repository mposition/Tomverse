/** V22 has its own explicit environment gate. A v8 grant is never a v22 receipt. */

export const AMUX_V22_AUTO_PROMOTION_POLICY_VERSION = 22;
export const AMUX_V22_AUTO_PROMOTION_ENV = "TOMVERSE_AMUX_V22_AUTO_PROMOTE";
export const AMUX_V22_AUTO_PROMOTION_CODE_LATCH = true;
export const AMUX_V22_GRADUATION_EXCEPTION_ENV = "TOMVERSE_AMUX_V22_GRADUATION_EXCEPTION";
export const AMUX_V22_GRADUATION_EXCEPTION_ID = "owner-bootstrap-2026-10-11";
export const AMUX_V22_GRADUATION_EXCEPTION_POLICY_VERSION = 30;
export const AMUX_V22_WORKER_QUEUE_MULTIPLIER = 3;
export const AMUX_V22_PARALLEL_RESERVED = 1;
export const AMUX_V22_SEV1_RESERVED = 1;

/**
 * Promotion folded into the claim (owner decision 2026-11-14, AMUX process
 * audit bundle 3, AMUXFLOW/B3). With TOMVERSE_AMUX_V22_PROMOTION_FLOW=enabled:
 * the score only orders candidates -- an expired window or a newer assessment
 * above the Task no longer takes it out (backlog -> todo is reversible and a
 * v22 receipt costs 0); readiness no longer waits for an idle worker of the
 * grade; and a tick whose claim assigned nothing promotes up to
 * AMUX_V22_PROMOTIONS_PER_TICK ready Tasks instead of one, for the next
 * tick's claim (the claim stays first, so no promotion write can turn a later
 * transient claim error into an unknown outcome). The
 * score's version, revision and approval binding are still checked, and the
 * capacity reservation is unchanged (its database check pins it). Off by default.
 */
export const AMUX_V22_PROMOTION_FLOW_ENV = "TOMVERSE_AMUX_V22_PROMOTION_FLOW";
export const amuxV22PromotionFlowEnabled = (
  value: string | undefined = process.env[AMUX_V22_PROMOTION_FLOW_ENV],
) => value?.trim() === "enabled";
export const AMUX_V22_PROMOTIONS_PER_TICK = 4;

export const amuxV22AutoPromotionEnabled = (value: string | undefined) =>
  AMUX_V22_AUTO_PROMOTION_CODE_LATCH && value === "enabled";

export const amuxV22GraduationExceptionEnabled = (value: string | undefined) =>
  value === AMUX_V22_GRADUATION_EXCEPTION_ID;

/** This accepts a separately authorized exception, never changes graduation
 * measurements. The caller must first verify the canonical owner audit binding. */
export function amuxV22GraduationPermitted(input: {
  graduated: boolean; environmentValue: string | undefined;
  authorization: unknown;
}) {
  if (input.graduated) return true;
  const metadata = input.authorization;
  return amuxV22GraduationExceptionEnabled(input.environmentValue) &&
    metadata !== null && typeof metadata === "object" &&
    !Array.isArray(metadata) &&
    "graduationExceptionId" in metadata &&
    metadata.graduationExceptionId === AMUX_V22_GRADUATION_EXCEPTION_ID &&
    "graduationExceptionPolicyVersion" in metadata &&
    metadata.graduationExceptionPolicyVersion ===
      AMUX_V22_GRADUATION_EXCEPTION_POLICY_VERSION;
}

/** The two lanes are held empty until their owner-declared classification and
 * worker-claim contract ships. Never lend an unclassified slot to a normal
 * task. The limit includes existing legacy todo/doing cards. */
export function amuxV22Capacity(input: {
  wipLimit: number | null; active: boolean; verifiedWorkerCount: number;
  occupied: number;
}) {
  const { wipLimit, active, verifiedWorkerCount, occupied } = input;
  if (!active || !Number.isSafeInteger(wipLimit) || wipLimit === null ||
      wipLimit < 1 || !Number.isSafeInteger(verifiedWorkerCount) ||
      verifiedWorkerCount < 1 || !Number.isSafeInteger(occupied) || occupied < 0) {
    return { allowed: false as const, reason: "capacity_unconfigured" as const,
      queueLimit: 0, normalLimit: 0 };
  }
  const queueLimit = Math.min(wipLimit,
    verifiedWorkerCount * AMUX_V22_WORKER_QUEUE_MULTIPLIER);
  const normalLimit = Math.max(0, queueLimit -
    AMUX_V22_PARALLEL_RESERVED - AMUX_V22_SEV1_RESERVED);
  if (occupied >= normalLimit) {
    return { allowed: false as const, reason: "capacity_full" as const,
      queueLimit, normalLimit };
  }
  return { allowed: true as const, reason: null, queueLimit, normalLimit };
}

export function amuxV22ScoreCurrent(input: {
  scoreVersion: string; expectedVersion: string; taskRevision: number;
  currentRevision: number; sourceApprovalId: string;
  currentSourceApprovalId: string; activeStaleAt: Date;
  baselineStaleAt: Date; now: Date;
  /** The score orders only: its window is not checked (AMUXFLOW/B3). */
  orderOnly?: boolean;
}) {
  return input.scoreVersion === input.expectedVersion &&
    input.taskRevision === input.currentRevision &&
    input.sourceApprovalId === input.currentSourceApprovalId &&
    (input.orderOnly === true || input.now.getTime() < input.activeStaleAt.getTime() &&
    input.now.getTime() < input.baselineStaleAt.getTime());
}

/** A newer owner-approved assessment invalidates the score immediately. */
export function amuxV22AssessmentIdsCurrent(
  scored: readonly string[], latest: readonly (string | null)[],
) {
  return (scored.length === 4 || scored.length === 5) &&
    latest.length === scored.length &&
    scored.every((id, index) => latest[index] === id);
}
