/**
 * The checked-in human decision that may permit a bounded Auto release while
 * the three ordinary readiness attestations remain pending.
 *
 * This record is deliberately pending. A merge must not grant authority by
 * itself: the operator fills every nullable field only after reviewing the
 * concrete implementation, target, limits and content-free evidence.
 */

export type AutoRouterLimitedReleasePlan = "Free" | "Pro" | "Max";

export type AutoRouterLimitedReleaseApprovalRecord = Readonly<{
  version: "auto-router-limited-release-approval-v1";
  exceptionId: "CHAT-01-AUTO-ROUTER-LIMITED-RELEASE-V1";
  workId: "CHAT-01";
  status: "pending" | "approved";
  approvedBy: string | null;
  approvedAt: string | null;
  policyCommit: string | null;
  policySha256: string | null;
  evaluatedImplementationCommit: string | null;
  targetEnvironmentName: string | null;
  targetEnvironmentId: string | null;
  targetServiceId: string | null;
  maxRolloutPercent: number | null;
  eligiblePlans: readonly AutoRouterLimitedReleasePlan[];
  expiresAt: string | null;
  evidenceRef: string | null;
  knownLimitations: string | null;
  unmetReadinessGates: readonly [
    "shadow_report",
    "offline_quality_evaluation",
    "attempt_manifest_boundary",
  ];
  requiredDispatchInstrumentation: "enforce";
  fallbackEnabled: false;
  maxProviderDispatchesPerLogicalResponse: 1;
  additionalProviderDispatchesPerLogicalResponse: 0;
  costAuthority: "existing_chat_entitlement_and_provider_guardrails_only";
  activationAuthority: "none" | "operator_runtime_selector";
  paidDispatchAuthority: "none" | "existing_chat_request_only";
}>;

export const AUTO_ROUTER_LIMITED_RELEASE_APPROVAL:
  AutoRouterLimitedReleaseApprovalRecord = Object.freeze({
    version: "auto-router-limited-release-approval-v1",
    exceptionId: "CHAT-01-AUTO-ROUTER-LIMITED-RELEASE-V1",
    workId: "CHAT-01",
    status: "pending",
    approvedBy: null,
    approvedAt: null,
    policyCommit: null,
    policySha256: null,
    evaluatedImplementationCommit: null,
    targetEnvironmentName: null,
    targetEnvironmentId: null,
    targetServiceId: null,
    maxRolloutPercent: null,
    eligiblePlans: Object.freeze([]),
    expiresAt: null,
    evidenceRef: null,
    knownLimitations: null,
    unmetReadinessGates: Object.freeze([
      "shadow_report",
      "offline_quality_evaluation",
      "attempt_manifest_boundary",
    ] as const),
    requiredDispatchInstrumentation: "enforce",
    fallbackEnabled: false,
    maxProviderDispatchesPerLogicalResponse: 1,
    additionalProviderDispatchesPerLogicalResponse: 0,
    costAuthority: "existing_chat_entitlement_and_provider_guardrails_only",
    activationAuthority: "none",
    paidDispatchAuthority: "none",
  });
