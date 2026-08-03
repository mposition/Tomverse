import {
  ERROR_CLASSIFICATION_SOURCE,
  EVIDENCE_AVAILABILITY,
  TOKEN_VERIFICATION_STATUS,
} from "@/lib/errorReportContract";

/**
 * Phase 2 shadow-mode case vocabulary and rules -- dependency-free so the
 * server worker, the admin console and the tests share one definition.
 *
 * Shadow mode means exactly this (docs/policy/trace-feedback-automation.md
 * §8): a case only collects evidence, classifies eligibility with the
 * deterministic rules below, and leaves a bounded diagnostic summary for a
 * human. No code is modified, no branch is pushed, no PR is created, and no
 * LLM verdict gates anything -- `llmConfidence` exists as an observational
 * field for a future diagnosis pass and stays null here.
 */

export const AUTOFIX_CASE_STATE = {
  received: "received",
  collectingEvidence: "collecting_evidence",
  evidenceReady: "evidence_ready",
  evidenceDelayed: "evidence_delayed",
  classifying: "classifying",
  diagnosticReady: "diagnostic_ready",
  ineligible: "ineligible",
  awaitingHumanReview: "awaiting_human_review",
  closed: "closed",
  // --- Phase 3 (docs/policy §9; dark until FEEDBACK_AUTOFIX_ENABLED) ------
  /** A fix workflow run holds the case under a lease. */
  fixAttempting: "fix_attempting",
  /** The deterministic Red→Green proof was validated server-side. */
  redGreenProven: "red_green_proven",
  /** A develop PR exists; a human must approve it (never auto-merge in the
   * initial operating period). */
  prOpen: "pr_open",
  /** GitHub's mergedAt/mergeSha were read back -- never inferred. */
  merged: "merged",
  /** The merge commit was confirmed on staging with readiness green. */
  stagingVerified: "staging_verified",
  /** The attempt could not produce a proof or a PR; a human decides next. */
  fixFailed: "fix_failed",
} as const;
export type AutoFixCaseState =
  (typeof AUTOFIX_CASE_STATE)[keyof typeof AUTOFIX_CASE_STATE];

/** The full transition graph. Anything not listed is forbidden -- a case can
 * never jump to an arbitrary terminal state. */
const TRANSITIONS: Record<AutoFixCaseState, readonly AutoFixCaseState[]> = {
  received: [AUTOFIX_CASE_STATE.collectingEvidence],
  collecting_evidence: [
    AUTOFIX_CASE_STATE.evidenceReady,
    AUTOFIX_CASE_STATE.evidenceDelayed,
    AUTOFIX_CASE_STATE.ineligible,
  ],
  evidence_delayed: [
    AUTOFIX_CASE_STATE.collectingEvidence,
    AUTOFIX_CASE_STATE.ineligible,
  ],
  // collecting_evidence appears as a target of evidence_ready/classifying
  // for exactly one purpose: lease recovery. A worker that died mid-pass
  // leaves the case there until the lease expires, and the next pass
  // restarts collection rather than guessing where the dead worker stopped.
  evidence_ready: [
    AUTOFIX_CASE_STATE.classifying,
    AUTOFIX_CASE_STATE.collectingEvidence,
  ],
  classifying: [
    AUTOFIX_CASE_STATE.diagnosticReady,
    AUTOFIX_CASE_STATE.ineligible,
    AUTOFIX_CASE_STATE.collectingEvidence,
  ],
  diagnostic_ready: [AUTOFIX_CASE_STATE.awaitingHumanReview],
  awaiting_human_review: [
    AUTOFIX_CASE_STATE.closed,
    // Phase 3 entry: a candidate may be claimed by the fix workflow. The
    // claim endpoint additionally requires FEEDBACK_AUTOFIX_ENABLED -- the
    // graph edge alone never activates anything.
    AUTOFIX_CASE_STATE.fixAttempting,
  ],
  ineligible: [AUTOFIX_CASE_STATE.closed],
  // --- Phase 3 -------------------------------------------------------------
  fix_attempting: [
    AUTOFIX_CASE_STATE.redGreenProven,
    AUTOFIX_CASE_STATE.fixFailed,
    // Lease recovery: an expired claim returns to the review pool.
    AUTOFIX_CASE_STATE.awaitingHumanReview,
  ],
  red_green_proven: [AUTOFIX_CASE_STATE.prOpen, AUTOFIX_CASE_STATE.fixFailed],
  pr_open: [AUTOFIX_CASE_STATE.merged, AUTOFIX_CASE_STATE.fixFailed],
  merged: [AUTOFIX_CASE_STATE.stagingVerified, AUTOFIX_CASE_STATE.fixFailed],
  staging_verified: [AUTOFIX_CASE_STATE.closed],
  fix_failed: [AUTOFIX_CASE_STATE.closed, AUTOFIX_CASE_STATE.awaitingHumanReview],
  closed: [],
};

export const canTransitionAutoFixCase = (
  from: string,
  to: string
): boolean =>
  (TRANSITIONS[from as AutoFixCaseState] ?? []).includes(
    to as AutoFixCaseState
  );

/** Non-terminal states a worker may hold a lease on. */
export const AUTOFIX_ACTIVE_STATES: readonly AutoFixCaseState[] = [
  AUTOFIX_CASE_STATE.received,
  AUTOFIX_CASE_STATE.collectingEvidence,
  AUTOFIX_CASE_STATE.evidenceReady,
  AUTOFIX_CASE_STATE.evidenceDelayed,
  AUTOFIX_CASE_STATE.classifying,
];

/**
 * Deterministic classification of a verified report. Never a fix decision:
 * `application_candidate` only means "worth a human's diagnostic attention".
 */
export const AUTOFIX_CLASSIFICATION = {
  applicationCandidate: "application_candidate",
  providerTransient: "provider_transient",
  operationalLimit: "operational_limit",
  clientClassified: "client_classified",
  untrustedTrace: "untrusted_trace",
  evidenceIncomplete: "evidence_incomplete",
} as const;
export type AutoFixClassification =
  (typeof AUTOFIX_CLASSIFICATION)[keyof typeof AUTOFIX_CLASSIFICATION];

/** Evidence codes that describe the provider's own failure to answer, not an
 * application defect -- observed, never auto-fixed. */
const PROVIDER_SIDE_CODE_PREFIXES = ["AI_EMPTY_RESPONSE", "DEEP_RESEARCH_JOB"];

export type AutoFixClassificationInput = {
  errorReportVerification: string | null;
  errorClassificationSource: string | null;
  clientErrorCode: string | null;
  evidenceAvailability: string | null;
  evidence: {
    errorCode: string | null;
    retryable: boolean | null;
    httpStatus: number | null;
  } | null;
};

export type AutoFixClassificationOutcome = {
  classification: AutoFixClassification;
  /** True only for application_candidate: the case proceeds to a diagnostic
   * summary and human review; everything else closes as ineligible. */
  eligible: boolean;
  reason: string;
};

export const classifyAutoFixCase = (
  input: AutoFixClassificationInput
): AutoFixClassificationOutcome => {
  if (
    input.errorReportVerification !== TOKEN_VERIFICATION_STATUS.verified
  ) {
    return {
      classification: AUTOFIX_CLASSIFICATION.untrustedTrace,
      eligible: false,
      reason: "report is not backed by a verified server token",
    };
  }
  if (
    input.errorClassificationSource === ERROR_CLASSIFICATION_SOURCE.client &&
    !input.evidence
  ) {
    return {
      classification: AUTOFIX_CLASSIFICATION.clientClassified,
      eligible: false,
      reason: "client-classified error with no server evidence",
    };
  }
  if (
    input.evidenceAvailability === EVIDENCE_AVAILABILITY.existingLimitEvent
  ) {
    return {
      classification: AUTOFIX_CLASSIFICATION.operationalLimit,
      eligible: false,
      reason: "limit/entitlement refusal; the limit-decision events are the record",
    };
  }
  if (!input.evidence) {
    return {
      classification: AUTOFIX_CLASSIFICATION.evidenceIncomplete,
      eligible: false,
      reason: "no evidence row available for this occurrence",
    };
  }
  const code = input.evidence.errorCode || "";
  if (
    input.evidence.retryable === true ||
    PROVIDER_SIDE_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))
  ) {
    return {
      classification: AUTOFIX_CLASSIFICATION.providerTransient,
      eligible: false,
      reason: "provider-side or retryable failure; not an application defect",
    };
  }
  return {
    classification: AUTOFIX_CLASSIFICATION.applicationCandidate,
    eligible: true,
    reason: "server-classified application failure with recorded evidence",
  };
};

/** Evidence-collection retry ceiling. The worker runs on the maintenance
 * cadence, so the effective delay between attempts is at least one cron
 * interval; after this many attempts a still-missing evidence row is treated
 * as permanently lost and the case closes as evidence_incomplete. */
export const AUTOFIX_MAX_COLLECT_ATTEMPTS = 6;

/** Backoff floor before the next collection attempt, indexed by how many
 * attempts have already run. Coarse on purpose: the worker wakes on the
 * maintenance cron, not a dedicated timer. */
export const autoFixCollectBackoffMs = (attemptCount: number): number => {
  const minutes = [1, 5, 15, 30, 60, 120];
  const index = Math.min(Math.max(attemptCount - 1, 0), minutes.length - 1);
  return minutes[index] * 60 * 1000;
};

/** How long one worker pass may hold a case before another may reclaim it. */
export const AUTOFIX_LEASE_MS = 5 * 60 * 1000;

/** Shadow-mode kill switch: cases are queued and processed only while this is
 * the literal string "true". Fail-closed by default. */
export const isAutoFixShadowModeEnabled = () =>
  process.env.FEEDBACK_AUTOFIX_SHADOW_ENABLED === "true";

/**
 * Phase 3 master switch. Entirely separate from shadow mode and default OFF:
 * turning it on is an operational decision gated by policy §9 (30 days of
 * shadow observation, ≥30 verified traced reports, zero leaks, and explicit
 * human approval) -- the code never checks those conditions itself, so the
 * flag is the commitment that a human verified them.
 */
export const isAutoFixFixingEnabled = () =>
  process.env.FEEDBACK_AUTOFIX_ENABLED === "true";
