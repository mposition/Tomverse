/** Pure AMUX v4 retention clocks. Callers must pass a DB-observed time and
 * immutable DB timestamps; this module does not read a host clock or write. */

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export const AMUX_ANALYSIS_MAX_AGE_MS = 7 * DAY_MS;
export const AMUX_RAW_PURGE_WINDOW_MS = 24 * HOUR_MS;
export const AMUX_UNDECIDED_DRAFT_WINDOW_MS = 30 * DAY_MS;
export const AMUX_DECIDED_DRAFT_RETENTION_MS = 30 * DAY_MS;
export const AMUX_BRIEF_RETENTION_MS = 90 * DAY_MS;
export const AMUX_HOLD_MAX_MS = 90 * DAY_MS;
export const AMUX_HOLD_NOTICE_LEAD_MS = 7 * DAY_MS;

const timestamp = (value: Date): number => {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error("AMUX retention timestamp is invalid");
  }
  return value.getTime();
};

const after = (base: Date, intervalMs: number): Date => {
  const result = new Date(timestamp(base) + intervalMs);
  if (!Number.isFinite(result.getTime())) {
    throw new Error("AMUX retention deadline is invalid");
  }
  return result;
};

const reached = (dbNow: Date, dueAt: Date) => timestamp(dbNow) >= timestamp(dueAt);

export const analysisDeadlineAt = (submittedAt: Date) =>
  after(submittedAt, AMUX_ANALYSIS_MAX_AGE_MS);

type AnalysisClock = {
  submittedAt: Date;
  analysisCompletedAt: Date | null;
  cancelledAt: Date | null;
};

/** The policy terminates an unfinished analysis at day seven even if a
 * cleanup worker records its cancellation later. Never anchor purge to that
 * late write. */
export function effectiveAnalysisTerminationAt(input: AnalysisClock & { dbNow: Date }): Date | null {
  const deadline = timestamp(analysisDeadlineAt(input.submittedAt));
  const ends = [input.analysisCompletedAt, input.cancelledAt]
    .filter((value): value is Date => value !== null)
    .map(timestamp);
  if (ends.length === 0 && timestamp(input.dbNow) < deadline) return null;
  return new Date(Math.min(deadline, ...ends));
}

/** Eligibility begins at effective termination. Purge workers should act from
 * this time, not wait until the 24-hour SLA deadline below. */
export const rawPurgeEligibleAt = (input: AnalysisClock & { dbNow: Date }): Date | null =>
  effectiveAnalysisTerminationAt(input);

/** Latest compliant completion time for monitoring/escalation, not a queue
 * eligibility time. */
export function rawPurgeBy(input: AnalysisClock & { dbNow: Date }): Date | null {
  const eligibleAt = rawPurgeEligibleAt(input);
  return eligibleAt === null ? null : after(eligibleAt, AMUX_RAW_PURGE_WINDOW_MS);
}

export const undecidedDraftExpiresAt = (analysisCompletedAt: Date) =>
  after(analysisCompletedAt, AMUX_UNDECIDED_DRAFT_WINDOW_MS);

export const decidedDraftPurgeAt = (finalDecisionAt: Date) =>
  after(finalDecisionAt, AMUX_DECIDED_DRAFT_RETENTION_MS);

export const executionBriefPurgeAt = (ownerTerminalAt: Date) =>
  after(ownerTerminalAt, AMUX_BRIEF_RETENTION_MS);

/** Use this at dispatch and completion as well as when scheduling cleanup:
 * a delayed cleanup job must not make an expired analysis runnable again. */
export function analysisCanContinue(input: {
  submittedAt: Date;
  analysisCompletedAt: Date | null;
  cancelledAt: Date | null;
  dbNow: Date;
}): boolean {
  return input.analysisCompletedAt === null && input.cancelledAt === null &&
    !reached(input.dbNow, analysisDeadlineAt(input.submittedAt));
}

/** Activity and worker restarts must not extend the absolute seven-day limit. */
export function shouldAutoCancelAnalysis(input: {
  submittedAt: Date;
  analysisCompletedAt: Date | null;
  cancelledAt: Date | null;
  dbNow: Date;
}): boolean {
  return input.analysisCompletedAt === null && input.cancelledAt === null &&
    reached(input.dbNow, analysisDeadlineAt(input.submittedAt));
}

/** Check at the decision/registration transaction. An expiry job running
 * late must not leave the draft open for an extra decision. */
export function draftDecisionAllowed(input: {
  analysisCompletedAt: Date;
  finalDecisionAt: Date | null;
  alreadyExpired: boolean;
  dbNow: Date;
}): boolean {
  return input.finalDecisionAt === null && !input.alreadyExpired &&
    !reached(input.dbNow, undecidedDraftExpiresAt(input.analysisCompletedAt));
}

/** Expiry prevents new registration. It is not consent or a deletion clock. */
export function shouldExpireUndecidedDraft(input: {
  analysisCompletedAt: Date;
  finalDecisionAt: Date | null;
  alreadyExpired: boolean;
  dbNow: Date;
}): boolean {
  const expiresAt = undecidedDraftExpiresAt(input.analysisCompletedAt);
  const decidedInTime = input.finalDecisionAt !== null && !reached(input.finalDecisionAt, expiresAt);
  return !decidedInTime && !input.alreadyExpired && reached(input.dbNow, expiresAt);
}

/** The current approved policy does not define when the body of an
 * automatically expired, undecided draft is deleted. Never infer it from the
 * explicit human-decision clock above. */
export const EXPIRED_UNDECIDED_DRAFT_BODY_PURGE = "policy_decision_required" as const;

/** Hold validity is a separate owner/audit gate; this only checks time bounds.
 * Holds of seven days or less receive their notice at creation. */
export function holdTimeWindow(input: { createdAt: Date; expiresAt: Date }): {
  valid: boolean;
  notifyAt: Date | null;
} {
  const created = timestamp(input.createdAt);
  const expires = timestamp(input.expiresAt);
  if (expires <= created || expires > created + AMUX_HOLD_MAX_MS) {
    return { valid: false, notifyAt: null };
  }
  return {
    valid: true,
    notifyAt: new Date(Math.max(created, expires - AMUX_HOLD_NOTICE_LEAD_MS)),
  };
}

/** A due purge remains due after a hold ends; holds do not reset its clock.
 * With multiple active holds, pass the latest valid expiry from the DB. */
export function purgeDisposition(input: {
  purgeAt: Date | null;
  purgedAt: Date | null;
  activeHoldExpiresAt: Date | null;
  dbNow: Date;
}): "not_scheduled" | "already_purged" | "not_due" | "held" | "due" {
  if (input.purgedAt !== null) return "already_purged";
  if (input.purgeAt === null) return "not_scheduled";
  if (!reached(input.dbNow, input.purgeAt)) return "not_due";
  if (input.activeHoldExpiresAt !== null && !reached(input.dbNow, input.activeHoldExpiresAt)) {
    return "held";
  }
  return "due";
}
