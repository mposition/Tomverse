import type { PublicStatusReasonCode } from "@/lib/providerPublicStatusCore";

// AUD-R001: three distinct evidence sources can back a status verdict -- an
// operator's manual declaration, real user-request traffic, or a scheduled
// synthetic probe. These must never be conflated on the public page: a
// probe confirms "the provider was reachable," not "a real user got a
// working response," so the page always states which kind of evidence
// backs the current verdict. Pure and dependency-free so it's unit-testable
// without rendering the page.
export const evidenceSourceLabel = (reasonCode: PublicStatusReasonCode): string => {
  if (reasonCode === "PUBLIC_INCIDENT_DECLARED") {
    return "(declared by a Tomverse operator)";
  }
  if (
    reasonCode === "PROBE_SUCCESS_CONFIRMED" ||
    reasonCode === "PROBE_REPEATED_FAILURE" ||
    reasonCode === "PROBE_FAILURE_STALE"
  ) {
    return "(from an automated synthetic check, not real user traffic)";
  }
  return "(from real request traffic monitoring)";
};

export type ProbeSchedulerJobSummary = {
  delayed: boolean;
  lastRunAt: string | null;
};

/**
 * "The probe scheduler hasn't run recently" and "a provider is unhealthy"
 * are different failure modes and must never be shown as the same thing --
 * a delayed scheduler means the evidence below may simply be older than
 * usual, not that anything is actually down. Returns null when there is
 * nothing to say (the scheduler is on schedule, or has literally never run
 * and there is no prior state to compare against).
 */
export const describeProbeSchedulerDelay = (
  job: ProbeSchedulerJobSummary | null
): "delayed_with_history" | "delayed_never_run" | null => {
  if (!job || !job.delayed) return null;
  return job.lastRunAt ? "delayed_with_history" : "delayed_never_run";
};
