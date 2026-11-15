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
 * On unless TOMVERSE_AMUX_INFRA_FAILURE_ROUTING is `disabled`, which restores
 * the earlier behaviour: every attempt counts, no worker is quarantined.
 *
 * Pure and dependency-free.
 */

export const AMUX_INFRA_FAILURE_ROUTING_ENV = "TOMVERSE_AMUX_INFRA_FAILURE_ROUTING";

export function amuxInfraFailureRoutingEnabled(
  value: string | undefined = process.env[AMUX_INFRA_FAILURE_ROUTING_ENV],
): boolean {
  return value?.trim() !== "disabled";
}

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
 * The most infrastructure failures one card may collect. A card that keeps
 * failing the same way on every worker (a tree the CLIs refuse, a prompt that
 * crashes them) is then blocked for a person instead of circling for ever.
 * The workers' own quarantine (workerCircuitCore.ts) keeps this from filling
 * up during an ordinary outage.
 */
export const AMUX_MAX_INFRA_FAILURES_PER_TASK = 12;

/** The escalation and attempt reason of a card that reached that bound. */
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

/** Sidecar failures that mean the worker did the card's work: they count. */
const RESULT_FAILURES = new Set(["deadline", "output_limit"]);

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
  enabled: boolean;
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
  if (!input.enabled || input.outcome !== "blocked" || input.budgetBound ||
      input.apiReceipt || input.receiptsComplete || input.knownCliFailure ||
      input.resultStored || input.patchStored) return null;
  if (input.failure) {
    const kind = classifyAmuxSidecarFailure(input.failure);
    return kind === "result" ? null : kind;
  }
  return input.usageEventCount === 0 ? "no_result" : "usage_unreported";
}
