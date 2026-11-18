/**
 * Infrastructure failures do not spend a card's attempts (owner decision
 * 2026-11-15).
 *
 * Production 2026-11-15: both Cursor workers' CLIs exited at once with no
 * result (their usage had expired) and AMUX-SCHEDJOBS-003 spent all five
 * attempts in twenty minutes. The run never did the card's work, yet each one
 * counted against the card as if the card had failed.
 *
 * A run fails the card only when the worker actually did the work and its
 * result failed: a test, a review, a scope check, the CLI's own named failure
 * (turn limit), or a run that worked past its deadline. Everything else is the
 * platform's failure -- no result, an exit right after start, a refused
 * sign-in, an exhausted quota, the network, an expired lease, the sidecar --
 * and it is retried on another worker without spending an attempt.
 *
 * A paid (budget-bound) route is never classified here: its every gate stays.
 * The unknown usage of an infrastructure failure stays unknown in the ledger;
 * it is never read as zero (lib/amux/v22WorkerUsageGate.ts only stops counting
 * it against the worker).
 *
 * Always on (the TOMVERSE_AMUX_INFRA_FAILURE_ROUTING kill switch that restored
 * the earlier behaviour was removed, owner decision 2026-11-16).
 *
 * Pure and dependency-free.
 */

export const AMUX_INFRA_FAILURE_KINDS = [
  "no_result",
  "early_exit",
  "auth_refused",
  "quota_exhausted",
  "network",
  "lease_expired",
  "sidecar_error",
  "usage_unreported",
] as const;
export type AmuxInfraFailureKind = (typeof AMUX_INFRA_FAILURE_KINDS)[number];

/** The attempt reason an infrastructure failure is stored under. */
export const amuxInfraFailureReason = (kind: AmuxInfraFailureKind) => `infra_${kind}` as const;
export type AmuxInfraFailureReason = ReturnType<typeof amuxInfraFailureReason>;
export const AMUX_INFRA_FAILURE_REASONS: readonly AmuxInfraFailureReason[] =
  AMUX_INFRA_FAILURE_KINDS.map(amuxInfraFailureReason);

const KIND_BY_REASON = new Map<string, AmuxInfraFailureKind>(
  AMUX_INFRA_FAILURE_KINDS.map((kind) => [amuxInfraFailureReason(kind), kind]));

export function amuxInfraFailureKindOfReason(reason: string | null | undefined):
  AmuxInfraFailureKind | null {
  return reason ? KIND_BY_REASON.get(reason) ?? null : null;
}

export const amuxIsInfraFailureReason = (reason: string | null | undefined) =>
  amuxInfraFailureKindOfReason(reason) !== null;

/**
 * An infrastructure failure never hands a card to a person (owner decision
 * 2026-11-16: no fixed count of platform failures stops a card; it was 12). The
 * card goes back to the queue and waits before a worker takes it again: none
 * for the first two failures, then a minute that doubles up to an hour, counted
 * from the failures since a person last sent the card back. A card that fails
 * the same way on every worker is slowed to one try an hour, never parked, and
 * the workers' own quarantine (workerCircuitCore.ts) still keeps an ordinary
 * outage from filling the queue.
 */
export const AMUX_INFRA_RETRY_BASE_MS = 60_000;
export const AMUX_INFRA_RETRY_MAX_MS = 60 * 60_000;
export const amuxInfraRetryDelayMs = (failures: number): number => {
  if (!Number.isFinite(failures) || failures <= 2) return 0;
  return Math.min(AMUX_INFRA_RETRY_MAX_MS,
    AMUX_INFRA_RETRY_BASE_MS * 2 ** Math.min(Math.trunc(failures) - 3, 20));
};

/**
 * The escalation reason cards carried when they reached the earlier bound of
 * 12. Nothing opens it now; rows that carry it stay readable.
 */
export const AMUX_INFRA_ATTEMPTS_EXHAUSTED_REASON = "infra_attempts_exhausted";

/** Below this, an unreadable result right after start is an early exit. */
export const AMUX_INFRA_EARLY_EXIT_MS = 120_000;

/** What the sidecar said about a run that produced no verified result. */
export type AmuxSidecarFailureReport = {
  /** The sidecar's failure code (lib/amux/v22OneShotSidecar.mjs). */
  code: string;
  cliStarted?: boolean | null;
  exitCode?: number | null;
  elapsedMs?: number | null;
};

/**
 * Sidecar failures that mean the worker did the card's work: they count.
 * `stalled` was the local CLI flow's stop of a run that showed no sign of life
 * for three hours, the worker's own run as the old deadline was. The flow no
 * longer stops a quiet run (owner decision 2026-11-18); attempts that already
 * ended that way keep the reason and still count
 * (AMUX_V22_RETIRED_STOP_REASONS, lib/amux/v22LocalCliFlowCore.ts). The flow's
 * other stop reasons are not the worker's
 * doing and stay infrastructure (an unknown code below): `operator_stop` (a
 * person stopped it) and `transcript_write_failed` (the sidecar could not
 * write its record).
 */
const RESULT_FAILURES = new Set(["deadline", "output_limit", "stalled"]);

/**
 * The kind of infrastructure failure a sidecar code names, or `"result"` when
 * the code means the run did the work (it then counts as an attempt).
 * An unknown code is the sidecar's own failure.
 */
export function classifyAmuxSidecarFailure(report: AmuxSidecarFailureReport):
  AmuxInfraFailureKind | "result" {
  const code = report.code;
  if (RESULT_FAILURES.has(code)) return "result";
  if (code === "channel_auth_refused" || code.startsWith("auth_") ||
      code === "login_required") return "auth_refused";
  if (code.startsWith("quota_") || code === "usage_limit") return "quota_exhausted";
  if (code === "base_sync_develop_unavailable" || code === "network" ||
      code.startsWith("network_")) return "network";
  if (code === "usage_receipt_missing") return "usage_unreported";
  if (code === "invalid_result") {
    const quick = report.elapsedMs !== null && report.elapsedMs !== undefined &&
      Number.isFinite(report.elapsedMs) && report.elapsedMs >= 0 &&
      report.elapsedMs < AMUX_INFRA_EARLY_EXIT_MS;
    return quick ? "early_exit" : "no_result";
  }
  return "sidecar_error";
}

/**
 * Whether a v22 settlement is an infrastructure failure, and which.
 *
 * Only an unverified settlement (outcome `blocked`, the bridge had no
 * verified CLI result) can be one, and only on a route that spends no money.
 * A run whose receipt is complete, whose CLI named its failure, or that
 * stored a result or a patch did the work and is judged as before.
 *
 * Without the sidecar's report (a bridge from before 2026-11-15) the stored
 * usage tells the two cases apart: none at all is a run with no result, a
 * partial one is a run whose usage was never reported.
 */
export function amuxV22InfraFailureKind(input: {
  outcome: "succeeded" | "failed" | "blocked";
  budgetBound: boolean;
  apiReceipt: boolean;
  receiptsComplete: boolean;
  knownCliFailure: boolean;
  resultStored: boolean;
  patchStored: boolean;
  usageEventCount: number;
  failure?: AmuxSidecarFailureReport | null;
}): AmuxInfraFailureKind | null {
  if (input.outcome !== "blocked" || input.budgetBound ||
      input.apiReceipt || input.receiptsComplete || input.knownCliFailure ||
      input.resultStored || input.patchStored) return null;
  if (input.failure) {
    const kind = classifyAmuxSidecarFailure(input.failure);
    return kind === "result" ? null : kind;
  }
  return input.usageEventCount === 0 ? "no_result" : "usage_unreported";
}
