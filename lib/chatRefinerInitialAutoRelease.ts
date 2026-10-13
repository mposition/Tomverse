import { createHash } from "node:crypto";

import { autoCohortConfig } from "@/lib/autoCohort";
import { autoFallbackFlagEnabled } from "@/lib/autoFallbackGate";
import { isAutoRouterUiEnabled } from "@/lib/autoRoutingUi";
import { activeManifestHashKey } from "@/lib/manifestHashKeyring";
import {
  PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST,
  PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
  PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
} from "@/lib/promptRefinerProductContract";
import { promptRefinerKillSwitchEngaged } from "@/lib/promptRefinerAccess";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";
import { currentChatReleaseSourceFingerprint } from
  "@/lib/chatReleaseSourceFingerprint";
import { ROUTER_VERSIONS } from "@/lib/routerDecision";
import { FALLBACK_POLICY_VERSION, plannerFailureMode } from
  "@/lib/routingFallbackPolicy";
import { dispatchInstrumentationMode } from "@/lib/routingInstrumentationMode";
import type { ChatRefinerInitialAutoEvidenceRefs } from
  "@/lib/chatRefinerInitialAutoReleaseApiContract";

export const CHAT_REFINER_INITIAL_AUTO_RELEASE_KIND =
  "initial_auto_v2" as const;
export const CHAT_REFINER_INITIAL_AUTO_POLICY_COMMIT =
  "3aeb001a4abde2d93e945ed5e5de61b10c412c0b" as const;
export const CHAT_REFINER_INITIAL_AUTO_POLICY_SHA256 =
  "a9dbe509a056152015a59a45fd6438304fac36f36521a1319c11f8d1704970f9" as const;
export const CHAT_REFINER_STABLE_RELEASE_POLICY_SHA256 =
  "1624ea972b907448dbe13ae9739c96a7854e2dbd777bbfb8dece36ba5d1f7838" as const;
export const CHAT_REFINER_INITIAL_AUTO_ROUTER_ACTION =
  "chat_auto.initial_release_exception_activated" as const;
export const CHAT_REFINER_INITIAL_AUTO_PRODUCT_ACTION =
  "prompt_refiner.product_initial_auto_release_activated" as const;
export const CHAT_REFINER_INITIAL_AUTO_ROUTER_SUMMARY =
  "Activated the stable-source Chat Auto initial-release exception." as const;
export const CHAT_REFINER_INITIAL_AUTO_PRODUCT_SUMMARY =
  "Activated the stable-source Prompt Refiner initial Auto release." as const;

export const CHAT_REFINER_INITIAL_AUTO_DEFERRED_ROUTER_GATES = Object.freeze([
  "shadow_report",
  "offline_quality_evaluation",
  "attempt_manifest_boundary",
] as const);

export const CHAT_REFINER_INITIAL_AUTO_HISTORICAL_FAILURE_REASONS = Object.freeze([
  "latency_ceiling_exceeded",
  "quality_cell_threshold",
  "challenge_threshold",
  "audit_incomplete",
] as const);

const sha256 = (value: unknown) => createHash("sha256")
  .update(typeof value === "string" ? value : canonicalBenchmarkJson(value), "utf8")
  .digest("hex");

/** Source is activation provenance; current execution controls remain bound. */
export const chatRefinerInitialAutoAuthorityDigest = (
  releaseFingerprint: string,
  routerConfigDigest: string,
) => sha256({
  version: "chat-release-authority-v2",
  releaseFingerprint,
  routerConfigDigest,
  candidateDigest: PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
  pricePinDigest: PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
  adapterConfigDigest: PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST,
  continuityPolicySha256: CHAT_REFINER_STABLE_RELEASE_POLICY_SHA256,
});

export type ChatRefinerInitialAutoRuntimeBinding = Readonly<{
  runtimeCommitSha: string;
  runtimeDeploymentId: string;
  releaseFingerprint: string;
  releaseAuthorityDigest: string;
  routerConfigDigest: string;
  rolloutPercent: number;
  eligiblePlans: readonly string[];
  cohortSaltDigest: string;
  manifestHashKeyId: string;
}>;

/**
 * Resolves the actual serving-process routing controls without exposing the
 * cohort salt or manifest secret. Every unsafe or incomplete configuration is
 * refused instead of being normalized into release authority.
 */
export const chatRefinerInitialAutoRuntimeBinding = (
  runtime: Record<string, string | undefined>,
): ChatRefinerInitialAutoRuntimeBinding => {
  const runtimeCommitSha = runtime.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase() ?? "";
  const runtimeDeploymentId = runtime.RAILWAY_DEPLOYMENT_ID?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{40}$/.test(runtimeCommitSha) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        runtimeDeploymentId)) {
    throw new Error("chat_refiner_initial_auto_runtime_identity_invalid");
  }
  const cohort = autoCohortConfig(runtime as NodeJS.ProcessEnv);
  const eligiblePlans = Object.freeze([...new Set(cohort.eligiblePlans)].sort());
  if (cohort.killSwitch || promptRefinerKillSwitchEngaged(runtime) ||
      cohort.rolloutPercent <= 0 || eligiblePlans.length === 0 ||
      cohort.salt === "unset" || !isAutoRouterUiEnabled(runtime) ||
      dispatchInstrumentationMode(runtime) !== "enforce") {
    throw new Error("chat_refiner_initial_auto_runtime_controls_invalid");
  }
  const manifestHashKeyId = activeManifestHashKey(runtime).keyId;
  const cohortSaltDigest = sha256(cohort.salt);
  const routerConfigDigest = sha256({
    version: "chat-refiner-initial-auto-router-config-v1",
    rolloutPercent: cohort.rolloutPercent,
    eligiblePlans,
    cohortSaltDigest,
    uiEnabled: true,
    routerVersions: ROUTER_VERSIONS,
    fallbackPolicyVersion: FALLBACK_POLICY_VERSION,
    fallbackEnabled: autoFallbackFlagEnabled(runtime),
    plannerFailureMode: plannerFailureMode(runtime),
    dispatchInstrumentation: "enforce",
    manifestHashKeyId,
  });
  const releaseFingerprint = currentChatReleaseSourceFingerprint();
  const releaseAuthorityDigest = chatRefinerInitialAutoAuthorityDigest(
    releaseFingerprint, routerConfigDigest);
  return Object.freeze({ runtimeCommitSha, runtimeDeploymentId,
    releaseFingerprint, releaseAuthorityDigest, routerConfigDigest,
    rolloutPercent: cohort.rolloutPercent,
    eligiblePlans, cohortSaltDigest, manifestHashKeyId });
};

const sharedMetadata = (binding: ChatRefinerInitialAutoRuntimeBinding,
  evidenceRefs: ChatRefinerInitialAutoEvidenceRefs) => ({
  policyCommit: CHAT_REFINER_INITIAL_AUTO_POLICY_COMMIT,
  policySha256: CHAT_REFINER_INITIAL_AUTO_POLICY_SHA256,
  continuityPolicySha256: CHAT_REFINER_STABLE_RELEASE_POLICY_SHA256,
  runtimeCommitSha: binding.runtimeCommitSha,
  runtimeDeploymentId: binding.runtimeDeploymentId,
  releaseFingerprint: binding.releaseFingerprint,
  releaseAuthorityDigest: binding.releaseAuthorityDigest,
  candidateDigest: PROMPT_REFINER_PRODUCT_CANDIDATE_DIGEST,
  pricePinDigest: PROMPT_REFINER_PRODUCT_PRICE_PIN_DIGEST,
  adapterConfigDigest: PROMPT_REFINER_PRODUCT_ADAPTER_CONFIG_DIGEST,
  routerConfigDigest: binding.routerConfigDigest,
  rolloutPercent: binding.rolloutPercent,
  eligiblePlans: binding.eligiblePlans,
  cohortSaltDigest: binding.cohortSaltDigest,
  dispatchInstrumentation: "enforce",
  manifestHashKeyId: binding.manifestHashKeyId,
  historicalGateOutcome: "fail",
  historicalGateReasonCodes: CHAT_REFINER_INITIAL_AUTO_HISTORICAL_FAILURE_REASONS,
  unresolvedEvaluationAuditConcerns: 34,
  qualityFollowupRequired: true,
  deferredRouterGates: CHAT_REFINER_INITIAL_AUTO_DEFERRED_ROUTER_GATES,
  evidenceRefs,
});

export const chatRefinerInitialAutoRouterMetadata = (
  binding: ChatRefinerInitialAutoRuntimeBinding,
  evidenceRefs: ChatRefinerInitialAutoEvidenceRefs,
) => ({
  version: "chat-refiner-initial-auto-router-release-v2",
  releaseKind: CHAT_REFINER_INITIAL_AUTO_RELEASE_KIND,
  ...sharedMetadata(binding, evidenceRefs),
});

export const chatRefinerInitialAutoProductMetadata = (
  binding: ChatRefinerInitialAutoRuntimeBinding,
  routerExceptionAuditLogId: string,
  evidenceRefs: ChatRefinerInitialAutoEvidenceRefs,
) => ({
  version: "prompt-refiner-product-initial-auto-release-v2",
  releaseKind: CHAT_REFINER_INITIAL_AUTO_RELEASE_KIND,
  ...sharedMetadata(binding, evidenceRefs),
  routerExceptionAuditLogId,
  explicitEnabled: true,
  autoEnabled: true,
});

export const chatRefinerInitialAutoResumeMetadata = (input: Readonly<{
  operatorConfirmedReasonCode: string;
  pauseAuditLogId: string;
  priorGeneration: number;
  runtimeCommitSha: string;
  runtimeDeploymentId: string;
  routerExceptionAuditLogId: string;
  productActivationAuditLogId: string;
}>) => ({
  version: "prompt-refiner-product-auto-resume-v3",
  releaseKind: CHAT_REFINER_INITIAL_AUTO_RELEASE_KIND,
  policyCommit: CHAT_REFINER_INITIAL_AUTO_POLICY_COMMIT,
  policySha256: CHAT_REFINER_INITIAL_AUTO_POLICY_SHA256,
  continuityPolicySha256: CHAT_REFINER_STABLE_RELEASE_POLICY_SHA256,
  ...input,
});

export const exactChatRefinerInitialAutoMetadata = (
  actual: unknown,
  expected: unknown,
): boolean => canonicalBenchmarkJson(actual ?? null) === canonicalBenchmarkJson(expected);
