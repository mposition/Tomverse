/** V22 is a separate, dark path. A v8 grant is never a v22 receipt. */

export const AMUX_V22_AUTO_PROMOTION_POLICY_VERSION = 22;
export const AMUX_V22_AUTO_PROMOTION_ENV = "TOMVERSE_AMUX_V22_AUTO_PROMOTE";
export const AMUX_V22_AUTO_PROMOTION_CODE_LATCH = false;
export const AMUX_V22_WORKER_QUEUE_MULTIPLIER = 3;
export const AMUX_V22_PARALLEL_RESERVED = 1;
export const AMUX_V22_SEV1_RESERVED = 1;

export const amuxV22AutoPromotionEnabled = (value: string | undefined) =>
  AMUX_V22_AUTO_PROMOTION_CODE_LATCH && value === "enabled";

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
}) {
  return input.scoreVersion === input.expectedVersion &&
    input.taskRevision === input.currentRevision &&
    input.sourceApprovalId === input.currentSourceApprovalId &&
    input.now.getTime() < input.activeStaleAt.getTime() &&
    input.now.getTime() < input.baselineStaleAt.getTime();
}

/** A newer owner-approved assessment invalidates the score immediately. */
export function amuxV22AssessmentIdsCurrent(
  scored: readonly string[], latest: readonly (string | null)[],
) {
  return (scored.length === 4 || scored.length === 5) &&
    latest.length === scored.length &&
    scored.every((id, index) => latest[index] === id);
}
