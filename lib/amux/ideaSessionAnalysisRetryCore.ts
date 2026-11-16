/**
 * When a subscription (v19 session) analysis claims its next invocation.
 *
 * Operator, 2026-11-16: an analysis whose newest claim failed, or closed
 * without a result (an unknown outcome the system closed at zero, or one the
 * owner released or closed in Admin), is queued again on its own after a wait
 * that doubles with each such claim in a row: 5 minutes, 10, 20, ... at most
 * 24 hours, the idea lane's pace (ideaLaneCore.ts). The next claim takes the
 * next invocation ordinal and asks for the same page again.
 *
 * Never queued again on its own: a paid (bounded) claim, which may spend
 * money, and a claim the owner stopped, which is the owner's decision. An
 * in-flight claim is still running.
 *
 * Pure: the queue (ideaSessionAnalysisQueueService.ts) and the claim writer
 * (ideaSessionAnalysisBudgetClaimService.ts) read the claims and decide here.
 * The database repeats which closed claim may be followed by another
 * (amux_v19_session_budget_claim_guard); the wait is this file's alone.
 */
export const AMUX_SESSION_RETRY_BASE_MS = 5 * 60_000;
export const AMUX_SESSION_RETRY_MAX_MS = 24 * 60 * 60_000;
/** Closed without a result the next page could build on. */
export const AMUX_SESSION_RETRYABLE_STATUSES: readonly string[] = Object.freeze([
  "failed", "owner_consumed", "released"]);

/** The wait after `failuresInARow` claims in a row ended without a result. */
export const amuxSessionRetryDelayMs = (failuresInARow: number): number =>
  failuresInARow < 1 ? 0 : Math.min(AMUX_SESSION_RETRY_MAX_MS,
    AMUX_SESSION_RETRY_BASE_MS * 2 ** Math.min(failuresInARow - 1, 30));

export type AmuxSessionClaimFact = {
  status: string; budgetMode: string; closedAt: Date | null;
  /** The owner stopped this claim (its stop audit exists). */
  ownerStopped: boolean;
};

/** `claims` newest first. `afterFailure` marks a claim that redoes a page. */
export function amuxSessionNextClaimDue(claims: readonly AmuxSessionClaimFact[],
  now: Date): { due: true; afterFailure: boolean } | { due: false; retryAt: Date | null } {
  const latest = claims[0];
  if (!latest || latest.status === "succeeded") return { due: true, afterFailure: false };
  if (!AMUX_SESSION_RETRYABLE_STATUSES.includes(latest.status) ||
      latest.budgetMode !== "max_shadow" || latest.ownerStopped ||
      !(latest.closedAt instanceof Date) || !Number.isFinite(latest.closedAt.getTime())) {
    return { due: false, retryAt: null };
  }
  let failures = 0;
  for (const claim of claims) {
    if (claim.status === "succeeded") break;
    failures += 1;
  }
  const retryAt = new Date(latest.closedAt.getTime() + amuxSessionRetryDelayMs(failures));
  return now.getTime() >= retryAt.getTime()
    ? { due: true, afterFailure: true } : { due: false, retryAt };
}
