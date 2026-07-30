// Pure decision logic for the *public* provider status shown on the status
// page and mirrored in the admin panel. Kept dependency-free (no Prisma, no
// "server-only") so it can be unit-tested with fixtures and a mock clock,
// and so the public page and admin diagnostics can never disagree -- both
// call this same function instead of deriving their own verdicts.
//
// Core principle: "no incident recorded" is not the same claim as
// "operational". Operational requires positive, recent evidence of success.

export type PublicProviderStatus = "operational" | "degraded" | "incident" | "unknown";

export type PublicStatusReasonCode =
  | "PUBLIC_INCIDENT_DECLARED"
  | "INTERNAL_OUTAGE_DETECTED"
  | "CONSECUTIVE_FAILURES_THRESHOLD"
  | "DEGRADED_PERFORMANCE"
  | "RECENT_FAILURE_EVIDENCE"
  | "ELEVATED_LATENCY"
  | "RECENT_SUCCESS_CONFIRMED"
  | "PROBE_SUCCESS_CONFIRMED"
  | "PROBE_REPEATED_FAILURE"
  | "PROBE_FAILURE_STALE"
  | "NO_SUCCESS_RECORDED"
  | "SUCCESS_STALE"
  | "HEALTH_DATA_UNAVAILABLE";

export type PublicProviderStatusResult = {
  status: PublicProviderStatus;
  reasonCode: PublicStatusReasonCode;
  reasonText: string;
  /** Whether lastSuccessAt falls within the freshness window, ignoring every other signal. */
  isFresh: boolean;
  freshnessMinutes: number;
};

export type PublicProviderStatusInput = {
  now: Date;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  /** How many minutes a success stays usable as "recent" evidence. */
  freshnessMinutes: number;
  /** An operator has manually declared a public incident for this provider. */
  hasPublicIncident?: boolean;
  /** Internal available/limited/outage verdict from evaluateProviderFailureHealth. */
  internalStatus: "available" | "limited" | "outage";
  /** Running count of failures since the last success (see ProviderHealthState). */
  consecutiveFailures?: number;
  /** How many consecutive failures escalate straight to "incident" even with too few
   *  samples for the window failure-rate to trip on its own (a low-traffic provider
   *  whose only recent request failed shouldn't still read as healthy). */
  incidentConsecutiveFailureThreshold?: number;
  /** Caller-supplied signal that recent successes were unusually slow. Not derived
   *  from any timestamp here -- production latency instrumentation is a separate,
   *  not-yet-built data source (see the report); tests/fixtures can set this
   *  directly to exercise the "recent success but degraded" path. */
  elevatedLatency?: boolean;
  /** At least one specific model under this provider is failing repeatedly right
   *  now (provider.modelIncidents). Provider-level evidence can look fine while
   *  one model is actually down, so this escalates straight to "incident" --
   *  folded into the core function (rather than composed ad hoc per page) so
   *  the public page and admin panel can't disagree about it. */
  hasActiveModelIncident?: boolean;
  /** AUD-R001: evidence from scheduled synthetic probes, kept in separate fields
   *  from the real-traffic ones above so the two streams can never silently
   *  overwrite each other -- see lib/providerMonitoring.ts's
   *  recordProviderProbeSuccess/Failure. All default to "no probe evidence",
   *  so every existing caller/test keeps behaving exactly as before. */
  lastProbeSuccessAt?: Date | null;
  lastProbeFailureAt?: Date | null;
  consecutiveProbeFailures?: number;
  /** How many consecutive probe failures (with no fresh real success) escalate
   *  probe evidence to "incident" rather than just "degraded". Deliberately a
   *  higher bar than a single failed probe (principle #4: one probe failure
   *  never alone means an outage). */
  probeIncidentConsecutiveFailureThreshold?: number;
};

export const DEFAULT_PUBLIC_STATUS_FRESHNESS_MINUTES = 30;
export const DEFAULT_INCIDENT_CONSECUTIVE_FAILURE_THRESHOLD = 3;
export const DEFAULT_PROBE_INCIDENT_CONSECUTIVE_FAILURE_THRESHOLD = 3;

const isValidPast = (value: Date | null, now: Date): value is Date =>
  value !== null && !Number.isNaN(value.getTime()) && value.getTime() <= now.getTime();

const minutesBetween = (a: Date, b: Date) => Math.abs(a.getTime() - b.getTime()) / 60_000;

/**
 * Decides the public-facing status for one provider from explicit, timestamped
 * evidence. Never returns "operational" without a fresh, valid success
 * timestamp -- a null, missing, stale, or future lastSuccessAt can only ever
 * resolve to "unknown" (or worse, if there's failure evidence instead).
 */
export const evaluatePublicProviderStatus = ({
  now,
  lastSuccessAt,
  lastFailureAt,
  freshnessMinutes,
  hasPublicIncident = false,
  internalStatus,
  consecutiveFailures = 0,
  incidentConsecutiveFailureThreshold = DEFAULT_INCIDENT_CONSECUTIVE_FAILURE_THRESHOLD,
  elevatedLatency = false,
  hasActiveModelIncident = false,
  lastProbeSuccessAt = null,
  // STG-F004: consecutiveProbeFailures alone is NOT sufficient evidence.
  // recordProviderProbeFailure does write both fields atomically, so neither
  // can be stale *relative to the other* -- but that only rules out internal
  // disagreement. When the probe scheduler itself stops running, both fields
  // freeze together and an old failure count would otherwise stay "current"
  // evidence forever (a provider read as Incident on a 38-hour-old count).
  // So the failure timestamp gates the probe escalation below, giving failure
  // evidence the same expiry that success evidence already has.
  lastProbeFailureAt = null,
  consecutiveProbeFailures = 0,
  probeIncidentConsecutiveFailureThreshold = DEFAULT_PROBE_INCIDENT_CONSECUTIVE_FAILURE_THRESHOLD,
}: PublicProviderStatusInput): PublicProviderStatusResult => {
  const safeFreshnessMinutes =
    Number.isFinite(freshnessMinutes) && freshnessMinutes > 0
      ? freshnessMinutes
      : DEFAULT_PUBLIC_STATUS_FRESHNESS_MINUTES;

  const validSuccessAt = isValidPast(lastSuccessAt, now) ? lastSuccessAt : null;
  const validFailureAt = isValidPast(lastFailureAt, now) ? lastFailureAt : null;
  const validProbeSuccessAt = isValidPast(lastProbeSuccessAt ?? null, now)
    ? lastProbeSuccessAt
    : null;
  const validProbeFailureAt = isValidPast(lastProbeFailureAt ?? null, now)
    ? lastProbeFailureAt
    : null;

  const isFresh =
    validSuccessAt !== null &&
    minutesBetween(now, validSuccessAt) <= safeFreshnessMinutes;

  const isFreshFromProbe =
    validProbeSuccessAt !== null &&
    minutesBetween(now, validProbeSuccessAt) <= safeFreshnessMinutes;

  // STG-F004: probe *failure* evidence expires on the same window as success
  // evidence. A null/invalid/future timestamp is not usable proof that the
  // failures are happening now, so it can never back a current verdict either.
  const isProbeFailureFresh =
    validProbeFailureAt !== null &&
    minutesBetween(now, validProbeFailureAt) <= safeFreshnessMinutes;

  // Either stream is legitimate "the provider is alive" evidence for the
  // purpose of clearing "unknown" -- this is the actual AUD-R001 fix (idle
  // providers that only ever get probed, never used, no longer stay
  // permanently unknown).
  const isFreshFromEitherStream = isFresh || isFreshFromProbe;

  // The most recent *kind* of event we have evidence for -- lets a stale-but-old
  // success never mask a more recent failure (and vice versa).
  const latestEventIsFailure =
    validFailureAt !== null &&
    (validSuccessAt === null || validFailureAt.getTime() > validSuccessAt.getTime());

  const result = (
    status: PublicProviderStatus,
    reasonCode: PublicStatusReasonCode,
    reasonText: string
  ): PublicProviderStatusResult => ({
    status,
    reasonCode,
    reasonText,
    isFresh: isFreshFromEitherStream,
    freshnessMinutes: safeFreshnessMinutes,
  });

  // 1. Operator-declared incident always wins.
  if (hasPublicIncident) {
    return result(
      "incident",
      "PUBLIC_INCIDENT_DECLARED",
      "An operator has declared a public incident for this provider."
    );
  }

  // 2. Explicit internal outage (failure-rate threshold, missing API key,
  //    exhausted budget, unavailable balance -- see evaluateProviderFailureHealth
  //    and getProviderHealthDashboard).
  if (internalStatus === "outage") {
    return result(
      "incident",
      "INTERNAL_OUTAGE_DETECTED",
      "Automated monitoring detected an outage-level failure rate or a hard blocker (missing key, exhausted budget, or unavailable balance)."
    );
  }

  // 3. A specific model under this provider is failing repeatedly right now,
  //    even if provider-level evidence otherwise looks fine.
  if (hasActiveModelIncident) {
    return result(
      "incident",
      "INTERNAL_OUTAGE_DETECTED",
      "At least one model from this provider is failing repeatedly in the current monitoring window."
    );
  }

  // 4. Consecutive-failure floor: catches a low-traffic provider whose only
  //    recent request(s) failed, before the window even has enough samples
  //    for the failure-rate policy to trip on its own.
  if (
    Math.max(0, Math.floor(consecutiveFailures)) >=
    Math.max(1, Math.floor(incidentConsecutiveFailureThreshold))
  ) {
    return result(
      "incident",
      "CONSECUTIVE_FAILURES_THRESHOLD",
      `${Math.floor(consecutiveFailures)} consecutive requests have failed since the last recorded success.`
    );
  }

  // 5. Internal "limited" (elevated but sub-outage failure rate).
  if (internalStatus === "limited") {
    return result(
      "degraded",
      "DEGRADED_PERFORMANCE",
      "Automated monitoring detected an elevated recent failure rate that has not reached the outage threshold."
    );
  }

  // 6. A more recent failure than success exists, but doesn't meet the
  //    consecutive-failure or window thresholds above -- don't call this
  //    operational, but a single/soft blip shouldn't read as a full incident.
  if (latestEventIsFailure) {
    return result(
      "degraded",
      "RECENT_FAILURE_EVIDENCE",
      "The most recent recorded outcome for this provider was a failure."
    );
  }

  // 7. Caller-supplied latency signal on an otherwise-healthy, recent success.
  //    Gated on real-traffic freshness specifically -- a probe can't observe
  //    real-user latency, only real traffic can.
  if (elevatedLatency && isFresh) {
    return result(
      "degraded",
      "ELEVATED_LATENCY",
      "Recent requests are succeeding but responding slower than expected."
    );
  }

  // 8-9. AUD-R001 synthetic-probe evidence. Only consulted once every
  //      real-traffic signal above has had its say, and only when real
  //      traffic doesn't already have a fresh success of its own -- a
  //      flaky probe must never override or race with an actual working
  //      provider (principle #3: don't let absence-of-real-failure be
  //      silently overridden by probe noise).
  const safeConsecutiveProbeFailures = Math.max(
    0,
    Math.floor(consecutiveProbeFailures)
  );

  //      The failure count only escalates while its own timestamp is still
  //      inside the freshness window (STG-F004) -- otherwise a scheduler that
  //      stopped running would pin the provider to Incident indefinitely.
  if (!isFresh && isProbeFailureFresh) {
    if (
      safeConsecutiveProbeFailures >=
      Math.max(1, Math.floor(probeIncidentConsecutiveFailureThreshold))
    ) {
      return result(
        "incident",
        "PROBE_REPEATED_FAILURE",
        `${safeConsecutiveProbeFailures} consecutive automated probes have failed with no fresh real-traffic success to contradict them.`
      );
    }
    if (safeConsecutiveProbeFailures >= 1) {
      return result(
        "degraded",
        "PROBE_REPEATED_FAILURE",
        `The most recent automated probe failed (${safeConsecutiveProbeFailures} consecutive), though this hasn't yet reached the incident threshold.`
      );
    }
  }

  // 10. Fresh success evidence from either real traffic or a synthetic
  //     probe, with nothing above overriding it.
  if (isFresh) {
    return result(
      "operational",
      "RECENT_SUCCESS_CONFIRMED",
      `A successful request was recorded within the last ${safeFreshnessMinutes} minutes.`
    );
  }
  if (isFreshFromProbe) {
    return result(
      "operational",
      "PROBE_SUCCESS_CONFIRMED",
      `An automated probe succeeded within the last ${safeFreshnessMinutes} minutes.`
    );
  }

  // 11. STG-F004: probe failures exist but their timestamp has expired (or was
  //     never usable), and nothing fresh contradicts or confirms them. Report
  //     the honest verdict -- we do not currently know -- and say why, rather
  //     than presenting an expired count as a live incident or silently
  //     dropping the fact that the last thing we saw was a failure.
  if (safeConsecutiveProbeFailures >= 1) {
    return result(
      "unknown",
      "PROBE_FAILURE_STALE",
      validProbeFailureAt === null
        ? `${safeConsecutiveProbeFailures} automated probe failures are recorded, but without a usable timestamp they cannot confirm the provider's current state.`
        : `The last automated probe failure is older than the ${safeFreshnessMinutes}-minute freshness window, so it no longer describes the provider's current state.`
    );
  }

  // 12. No success evidence at all, from either stream.
  if (validSuccessAt === null && validProbeSuccessAt === null) {
    return result(
      "unknown",
      "NO_SUCCESS_RECORDED",
      "No successful request has been recorded for this provider yet."
    );
  }

  // 13. Success evidence exists in at least one stream but is older than the
  //     freshness window in both.
  return result(
    "unknown",
    "SUCCESS_STALE",
    `The last recorded success is older than the ${safeFreshnessMinutes}-minute freshness window.`
  );
};

/** Public status to use when health data itself couldn't be loaded (DB/API failure). */
export const HEALTH_DATA_UNAVAILABLE_RESULT: PublicProviderStatusResult = {
  status: "unknown",
  reasonCode: "HEALTH_DATA_UNAVAILABLE",
  reasonText: "Provider health data could not be loaded.",
  isFresh: false,
  freshnessMinutes: DEFAULT_PUBLIC_STATUS_FRESHNESS_MINUTES,
};

export type MonitoredStatusSummary = {
  headline: string;
  tone: "operational" | "degraded" | "incident" | "unknown";
};

/**
 * Evidence-based summary headline for the whole status page. Never claims
 * "all operational" unless every monitored provider actually has fresh
 * success evidence -- an all-unknown or mixed-unknown set must say so.
 */
export const summarizeMonitoredStatuses = (
  statuses: PublicProviderStatus[]
): MonitoredStatusSummary => {
  if (statuses.length === 0) {
    return {
      headline: "No providers are currently monitored",
      tone: "unknown",
    };
  }
  if (statuses.some((status) => status === "incident")) {
    return {
      headline: "One or more providers are experiencing an incident",
      tone: "incident",
    };
  }
  if (statuses.some((status) => status === "degraded")) {
    return {
      headline: "Some providers are experiencing degraded performance",
      tone: "degraded",
    };
  }
  if (statuses.some((status) => status === "unknown")) {
    return {
      headline: "Some provider statuses are currently unverified",
      tone: "unknown",
    };
  }
  return {
    headline: "All monitored providers are operational",
    tone: "operational",
  };
};
