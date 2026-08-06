// Per-model health for Router candidate filtering (G2 in
// docs/policy/tomverse-chat-model-capability-inventory.md).
//
// The gap this closes: ProviderHealthState is keyed by provider, while
// ProviderProbeResult is per (provider, modelId) and Router filtering is per
// model. With only the provider-level signal the Router can only over-block --
// one degraded model takes its whole provider out -- or under-block, leaving a
// broken model eligible because its provider still looks healthy.
//
// Derived, never a new evidence stream. The provider verdict arrives already
// computed by the existing health path, and the model verdict comes from the
// probe rows that path already writes. The routing policy is explicit that the
// Router must not treat its own failures as health truth without going through
// the same recording path, so nothing here consumes routing outcomes.
//
// Unknown is a real answer. A model with no recent probe is not healthy and is
// not broken; saying so lets Auto exclude it while a deliberate manual choice
// still goes through -- the same discipline lib/webSearchCapability.ts applies
// by leaving unconfirmed models "unverified" rather than assuming support.

import { evaluateProviderFailureHealth } from "@/lib/providerHealthPolicyCore";

export type ModelHealthStatus = "healthy" | "degraded" | "unavailable" | "unknown";

export type ModelHealthReason =
  | "provider_unavailable"
  | "provider_degraded"
  | "model_probe_outage"
  | "model_probe_limited"
  | "model_probes_stale"
  | "model_never_probed"
  | "healthy";

/** Only what a rollup needs; the full row carries diagnostics this must not read. */
export type ModelProbeObservation = {
  success: boolean;
  completedAt: Date;
  latencyMs?: number | null;
};

export type ProviderHealthVerdict = {
  /** Provider-wide outage, as the existing health path already decided it. */
  outage: boolean;
  /** Provider-wide degradation, likewise. */
  limited: boolean;
};

export type ModelHealthRollup = {
  modelId: string;
  provider: string;
  status: ModelHealthStatus;
  reason: ModelHealthReason;
  probeCount: number;
  failureRatePercent: number | null;
  lastProbeAt: Date | null;
  medianLatencyMs: number | null;
  /**
   * Whether a candidate filter may select this model automatically. Auto
   * routing takes healthy only; degraded stays selectable by an explicit
   * manual choice, and the Router's own policy decides what to do with it.
   */
  eligibleForAutoRouting: boolean;
};

/**
 * A probe older than this says nothing about now. Deliberately generous -- the
 * prober's own cadence sets the floor, and a window too tight would report
 * every model as stale between runs.
 */
export const PROBE_FRESHNESS_WINDOW_MS = 6 * 60 * 60 * 1000;

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
};

const trailingSuccessStreak = (observations: ModelProbeObservation[]) => {
  let streak = 0;
  for (let index = observations.length - 1; index >= 0; index -= 1) {
    if (!observations[index].success) break;
    streak += 1;
  }
  return streak;
};

/**
 * Rolls a model's probe history up into one verdict, with the provider's own
 * verdict dominating.
 *
 * Provider first, and not merged: a provider in outage takes every model with
 * it, because a model cannot be reachable through an unreachable provider.
 * Underneath that, a model can be individually unavailable while its provider
 * is fine, which is the case the provider-keyed signal could never express.
 */
export const rollUpModelHealth = ({
  modelId,
  provider,
  providerVerdict,
  observations,
  now,
  freshnessWindowMs = PROBE_FRESHNESS_WINDOW_MS,
}: {
  modelId: string;
  provider: string;
  providerVerdict: ProviderHealthVerdict;
  observations: ModelProbeObservation[];
  now: Date;
  freshnessWindowMs?: number;
}): ModelHealthRollup => {
  const ordered = [...observations].sort(
    (a, b) => a.completedAt.getTime() - b.completedAt.getTime()
  );
  const lastProbeAt = ordered.length > 0 ? ordered[ordered.length - 1].completedAt : null;
  const medianLatencyMs = median(
    ordered
      .map((observation) => observation.latencyMs)
      .filter((latency): latency is number => typeof latency === "number" && latency >= 0)
  );

  const base = {
    modelId,
    provider,
    probeCount: ordered.length,
    lastProbeAt,
    medianLatencyMs,
  };

  if (providerVerdict.outage) {
    return {
      ...base,
      status: "unavailable",
      reason: "provider_unavailable",
      failureRatePercent: null,
      eligibleForAutoRouting: false,
    };
  }

  if (ordered.length === 0) {
    return {
      ...base,
      status: "unknown",
      reason: "model_never_probed",
      failureRatePercent: null,
      eligibleForAutoRouting: false,
    };
  }

  if (lastProbeAt && now.getTime() - lastProbeAt.getTime() > freshnessWindowMs) {
    return {
      ...base,
      status: "unknown",
      reason: "model_probes_stale",
      failureRatePercent: null,
      eligibleForAutoRouting: false,
    };
  }

  // The provider-level thresholds, reused rather than re-invented: a model
  // degrading looks the same as a provider degrading, and two sets of numbers
  // for one judgement would drift.
  const health = evaluateProviderFailureHealth({
    successCount: ordered.filter((observation) => observation.success).length,
    failureCount: ordered.filter((observation) => !observation.success).length,
    consecutiveSuccesses: trailingSuccessStreak(ordered),
  });

  if (health.outage) {
    return {
      ...base,
      status: "unavailable",
      reason: "model_probe_outage",
      failureRatePercent: health.failureRatePercent,
      eligibleForAutoRouting: false,
    };
  }

  if (health.limited) {
    return {
      ...base,
      status: "degraded",
      reason: "model_probe_limited",
      failureRatePercent: health.failureRatePercent,
      eligibleForAutoRouting: false,
    };
  }

  // A provider that is degraded but not out leaves its healthy-looking models
  // degraded too: the shared path between them is the thing misbehaving, and a
  // model's own probes cannot see that.
  if (providerVerdict.limited) {
    return {
      ...base,
      status: "degraded",
      reason: "provider_degraded",
      failureRatePercent: health.failureRatePercent,
      eligibleForAutoRouting: false,
    };
  }

  return {
    ...base,
    status: "healthy",
    reason: "healthy",
    failureRatePercent: health.failureRatePercent,
    eligibleForAutoRouting: true,
  };
};
