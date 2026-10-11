/**
 * The checked-in human decision that may permit a bounded Auto release while
 * the three ordinary readiness attestations remain pending.
 *
 * This record carries mposition's exact bounded approval. A merge still does
 * not grant authority by itself: the selector, target, serving commit, source
 * digests, instrumentation, keyring, rollout and expiry must all match.
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
  evaluatedArtifactSha256: string | null;
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
    status: "approved",
    approvedBy: "mposition",
    approvedAt: "2026-10-11T00:44:09Z",
    policyCommit: "9851b4863639871f2b6b83b62df59a76510a7334",
    policySha256:
      "a0d0f119d1c5ab9d647ef5c72cd8af658e4cd8b4b5c92d23d6bca3c0adc6999b",
    evaluatedImplementationCommit:
      "1f5d4c60123fc33b5e40f9b5f5cb4e36bd29b177",
    evaluatedArtifactSha256:
      "159f2227c1ece70e18df8450ae313053813b280d1e21048b50ac18067fe4999f",
    targetEnvironmentName: "production",
    targetEnvironmentId: "4ffdeab7-a1fb-4ec1-bf4a-4dd2818ba668",
    targetServiceId: "f0a4f7f4-a476-4726-87a6-9114f8da8147",
    maxRolloutPercent: 100,
    eligiblePlans: Object.freeze(["Free", "Pro", "Max"] as const),
    expiresAt: "2026-11-10T00:00:00Z",
    evidenceRef:
      "docs/ops/tomverse-chat-auto-router-limited-release-v1-approval.md#approved-evidence",
    knownLimitations:
      "Routing uses neutral scores and answer quality is unproven; representative Shadow evidence and the full durable Chat cancellation, stream-failure, failure-matrix, and operational-latency coverage remain incomplete; deployments without readable source fail closed; future main SHAs require separate approval; the earlier UI 21 and PostgreSQL provenance 42 checks were not rerun for the final RC.",
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
    activationAuthority: "operator_runtime_selector",
    paidDispatchAuthority: "existing_chat_request_only",
  });
