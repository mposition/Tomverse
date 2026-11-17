/** A v8 grant is never a v22 receipt. */

export const AMUX_V22_AUTO_PROMOTION_POLICY_VERSION = 22;
export const AMUX_V22_WORKER_QUEUE_MULTIPLIER = 3;
export const AMUX_V22_PARALLEL_RESERVED = 1;
export const AMUX_V22_SEV1_RESERVED = 1;

/**
 * Promotion is folded into the claim (owner decision 2026-11-14, AMUX process
 * audit bundle 3, AMUXFLOW/B3; always on since 2026-11-16): the score only
 * orders candidates -- an expired window or a newer assessment above the Task
 * no longer takes it out (backlog -> todo is reversible and a v22 receipt
 * costs 0); readiness no longer waits for an idle worker of the grade; and a
 * tick whose claim assigned nothing promotes up to AMUX_V22_PROMOTIONS_PER_TICK
 * ready Tasks instead of one, for the next tick's claim (the claim stays
 * first, so no promotion write can turn a later transient claim error into an
 * unknown outcome). The score's version, revision and approval binding are
 * still checked, and the capacity reservation is unchanged (its database check
 * pins it).
 */
export const AMUX_V22_PROMOTIONS_PER_TICK = 4;

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

/** The score orders only: its window and a newer assessment do not take a
 * Task out (AMUXFLOW/B3); its version, revision and approval binding decide. */
export function amuxV22ScoreCurrent(input: {
  scoreVersion: string; expectedVersion: string; taskRevision: number;
  currentRevision: number; sourceApprovalId: string;
  currentSourceApprovalId: string;
}) {
  return input.scoreVersion === input.expectedVersion &&
    input.taskRevision === input.currentRevision &&
    input.sourceApprovalId === input.currentSourceApprovalId;
}
