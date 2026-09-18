import { createHash } from "node:crypto";

import {
  PROMPT_REFINER_EXECUTION_CONTRACT,
  PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
  PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
  PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
  PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
} from "@/lib/promptRefinerExecutionContract";
import {
  PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
  PROMPT_REFINER_RESERVATION_STAGE_ID,
} from "@/lib/promptRefinerReservationCore";
import {
  PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST,
  PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST,
  PROMPT_REFINER_SHADOW_ADMISSION_MANIFEST_SHA256,
  PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_IDENTITY_DIGEST,
  PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF,
  PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST,
  PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION,
} from "@/lib/promptRefinerShadowAdmissionCore";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";

/**
 * Content-free durable approval contract. This module performs no I/O and
 * cannot create a stage, reserve a slot, call a provider, or enable a flag.
 */
export const PROMPT_REFINER_STAGE_ADMISSION_VERSION =
  "prompt-refiner-stage-admission-v1" as const;
export const PROMPT_REFINER_RUNTIME_SOURCE_MANIFEST_VERSION =
  "prompt-refiner-runtime-source-manifest-v2" as const;
export const PROMPT_REFINER_EXECUTION_MANIFEST_VERSION =
  "prompt-refiner-shadow-execution-manifest-v1" as const;
export const PROMPT_REFINER_STAGE_APPROVAL_TTL_MS = 60 * 60 * 1_000;
export const PROMPT_REFINER_STAGE_ENVIRONMENT = "staging" as const;
export const PROMPT_REFINER_STAGE_CONFIRMATION =
  "APPROVE PROMPT REFINER SHADOW STAGE V1 FOR 60 MINUTES" as const;
export const PROMPT_REFINER_STAGE_REASON =
  "bounded_staging_shadow_cost_approval" as const;
export const PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT = 186 as const;
export const PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES = 8 * 1024 * 1024;
export const PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES = 16 * 1024 * 1024;

// These are the executable entrypoints whose complete local runtime import
// closure is bound into every durable stage. Keep the closure test in sync: a
// newly introduced local runtime import must fail closed until both this list
// and the database constraint are reviewed together.
export const PROMPT_REFINER_RUNTIME_IMPORT_ROOTS = Object.freeze([
  "app/api/admin/prompt-refiner/shadow-stage/route.ts",
  "lib/promptRefinerReservationAuthority.ts",
  "lib/promptRefinerShadowHarness.ts",
  "lib/promptRefinerShadowJournal.ts",
  "lib/promptRefinerShadowSource.ts",
  "lib/providerUsageCost.ts",
  "lib/promptRefinerSuggestion.ts",
  "proxy.ts",
] as const);

export const PROMPT_REFINER_RUNTIME_SOURCE_PATHS = Object.freeze([
  ".gitattributes",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "prisma/schema.prisma",
  "prisma/migrations/20260917190000_prompt_refiner_stage_admission/migration.sql",
  "apps/mobile/package.json",
  "packages/chat-core/package.json",
  "packages/ui-tokens/package.json",
  "app/api/admin/prompt-refiner/shadow-stage/route.ts",
  "lib/accountEmails.ts",
  "lib/activeAiModel.ts",
  "lib/adminAudit.ts",
  "lib/adminAuditIntegrityCore.ts",
  "lib/adminAuditSystemActors.ts",
  "lib/adminAuth.ts",
  "lib/adminAuthCore.ts",
  "lib/adminReauthentication.ts",
  "lib/adminReauthenticationCore.ts",
  "lib/anthropicPromptCaching.ts",
  "lib/apiCacheControlPolicy.ts",
  "lib/apiSecurity.ts",
  "lib/appDefaults.ts",
  "lib/appSettings.ts",
  "lib/assistantKnowledgeGuide.ts",
  "lib/assistantPackageImportAccess.ts",
  "lib/assistantProfileAccess.ts",
  "lib/auth.ts",
  "lib/billingEmails.ts",
  "lib/billingPlanDefaults.ts",
  "lib/chatAdmissionCore.ts",
  "lib/chatAttemptCostLedger.ts",
  "lib/chatConcurrencyCore.ts",
  "lib/chatCostGuardrails.ts",
  "lib/chatCostSafetyCore.ts",
  "lib/chatCreditAllocation.ts",
  "lib/chatInputLimits.ts",
  "lib/chatLimitDecisionCore.ts",
  "lib/chatLimitDecisions.ts",
  "lib/chatMultiAttemptSettlement.ts",
  "lib/chatProviderHolds.ts",
  "lib/chatRateLimitCore.ts",
  "lib/chatRequestLease.ts",
  "lib/chatSecurity.ts",
  "lib/chatStarterAccess.ts",
  "lib/chatTokenEstimate.ts",
  "lib/chatTokenQuotaCore.ts",
  "lib/chatUsageBucketCount.ts",
  "lib/chatUsageKey.ts",
  "lib/clientIp.ts",
  "lib/credentialEmailLane.ts",
  "lib/creditDebt.ts",
  "lib/creditLedger.ts",
  "lib/csp.ts",
  "lib/databaseError.ts",
  "lib/deepResearchSettlementHandoff.ts",
  "lib/deepseekUsageAdapter.ts",
  "lib/deepseekUsageAdapterCore.ts",
  "lib/documentLanguage.ts",
  "lib/e2eTestMode.ts",
  "lib/email.ts",
  "lib/emailAuditHash.ts",
  "lib/emailConsentToken.ts",
  "lib/emailFeatureFlags.ts",
  "lib/emailJurisdictionCore.ts",
  "lib/emailLogin.ts",
  "lib/emailLoginEmails.ts",
  "lib/emailPreferenceCore.ts",
  "lib/emailPreferences.ts",
  "lib/emailProviderPort.ts",
  "lib/emailProviderPortCore.ts",
  "lib/emailSendLock.ts",
  "lib/emailSendLockCore.ts",
  "lib/emailSendRetryCore.ts",
  "lib/emailSendingIdentity.ts",
  "lib/emailSendingIdentityCore.ts",
  "lib/emailSentIdentityCore.ts",
  "lib/emailSuppression.ts",
  "lib/emailSuppressionAuthority.ts",
  "lib/emailSuppressionAuthorityCore.ts",
  "lib/emailSuppressionCauses.ts",
  "lib/emailSuppressionCore.ts",
  "lib/emailTemplateDefinitions.ts",
  "lib/emailTemplateMetadataCore.ts",
  "lib/emailTemplateRegistry.ts",
  "lib/emailTypography.ts",
  "lib/externalContinuationAccess.ts",
  "lib/externalImportAccess.ts",
  "lib/foundingTesterPassCore.ts",
  "lib/imageGenerationAccess.ts",
  "lib/language.ts",
  "lib/managedSlack.ts",
  "lib/marketingConsentConfirmationEmail.ts",
  "lib/marketingEmailLayout.ts",
  "lib/marketingRoutes.ts",
  "lib/memoryAccess.ts",
  "lib/mobileAccessToken.ts",
  "lib/mobileAccessTokenCore.ts",
  "lib/mobileAuthContract.ts",
  "lib/mobileAuthKeyring.ts",
  "lib/mobileAuthService.ts",
  "lib/mobileDeploymentBinding.ts",
  "lib/mobileRefreshRotationCore.ts",
  "lib/mobileRefreshToken.ts",
  "lib/mobileRevocationFreshnessCore.ts",
  "lib/mobileSessionAuthorization.ts",
  "lib/mobileSessionSnapshotCache.ts",
  "lib/modelGenerationCompatibility.ts",
  "lib/modelLaunchEmail.ts",
  "lib/modelLifecycleDailyEmail.ts",
  "lib/modelLifecycleDailyReportCore.ts",
  "lib/modelPricing.ts",
  "lib/modelRegistry.ts",
  "lib/modelRegistryShared.ts",
  "lib/models.ts",
  "lib/nativeAppCors.ts",
  "lib/nativeBearerGate.ts",
  "lib/oauthTokenCrypto.ts",
  "lib/operationalMonitoring.ts",
  "lib/operationalMonitoringCore.ts",
  "lib/operatorAlertProbeCore.ts",
  "lib/originProtection.ts",
  "lib/perplexityResponseCore.ts",
  "lib/perplexityResponseEvents.ts",
  "lib/perplexitySearchMetadataCore.ts",
  "lib/perplexityUsageCapture.ts",
  "lib/perplexityUsageCore.ts",
  "lib/postgresConnectionConfigCore.mjs",
  "lib/prisma.ts",
  "lib/productAnnouncementEmail.ts",
  "lib/promptInjectionAudit.ts",
  "lib/promptRefinerAccess.ts",
  "lib/promptRefinerExecutionContract.ts",
  "lib/promptRefinerModelPrompt.ts",
  "lib/promptRefinerReservationAuthority.ts",
  "lib/promptRefinerReservationCore.ts",
  "lib/promptRefinerShadowAdmissionCore.ts",
  "lib/promptRefinerShadowHarness.ts",
  "lib/promptRefinerShadowJournal.ts",
  "lib/promptRefinerShadowSource.ts",
  "lib/promptRefinerStageAdmission.ts",
  "lib/promptRefinerStageAdmissionCore.ts",
  "lib/promptRefinerSuggestion.ts",
  "lib/providerBalanceCore.ts",
  "lib/providerBilling.ts",
  "lib/providerCostBudget.ts",
  "lib/providerCreditAlertsCore.ts",
  "lib/providerCredits.ts",
  "lib/providerErrorClassification.ts",
  "lib/providerFallbackCandidates.ts",
  "lib/providerHealthPolicyCore.ts",
  "lib/providerMonitoring.ts",
  "lib/providerProbe.ts",
  "lib/providerPublicStatusCore.ts",
  "lib/providerUsageAccounting.ts",
  "lib/providerUsageCost.ts",
  "lib/providerVerification.ts",
  "lib/publicSnapshotCache.ts",
  "lib/publicUrl.ts",
  "lib/requestOrigin.ts",
  "lib/routerDevelopmentBenchmark.ts",
  "lib/routingAttemptStore.ts",
  "lib/searchProviderBudget.ts",
  "lib/securityAudit.ts",
  "lib/sessionRevocationCore.ts",
  "lib/sessionSecurity.ts",
  "lib/slackMessageTemplateCore.ts",
  "lib/staticMarketingCsp.ts",
  "lib/svixSignature.ts",
  "lib/theme.ts",
  "lib/tokenEstimateShadow.ts",
  "lib/tokenEstimateShadowRecorder.ts",
  "lib/turnstile.ts",
  "lib/userDailyUsage.ts",
  "lib/userOperationalSecurity.ts",
  "lib/userTimeZone.ts",
  "lib/voiceInputAccess.ts",
  "lib/webSearchBackendPricing.ts",
  "lib/webSearchBackendRuntime.ts",
  "lib/webSearchBackends.ts",
  "lib/webSearchCapability.ts",
  "lib/webSearchCeilingBreachStore.ts",
  "lib/webSearchCitations.ts",
  "lib/webSearchCredits.ts",
  "lib/webSearchNativeCostReservation.ts",
  "proxy.ts",
] as const);

export type PromptRefinerRuntimeSourceFile = Readonly<{
  path: (typeof PROMPT_REFINER_RUNTIME_SOURCE_PATHS)[number];
  sizeBytes: number;
  sha256: string;
}>;

export type PromptRefinerRuntimeSourceManifest = Readonly<{
  schemaVersion: typeof PROMPT_REFINER_RUNTIME_SOURCE_MANIFEST_VERSION;
  commitSha: string;
  totalSizeBytes: number;
  files: readonly PromptRefinerRuntimeSourceFile[];
}>;

export type PromptRefinerExecutionManifest = Readonly<{
  schemaVersion: typeof PROMPT_REFINER_EXECUTION_MANIFEST_VERSION;
  stageId: typeof PROMPT_REFINER_RESERVATION_STAGE_ID;
  reservationContractDigest: typeof PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST;
  runtimeSource: Readonly<{
    fileCount: typeof PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT;
    maxFileBytes: typeof PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES;
    maxTotalBytes: typeof PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES;
  }>;
  executionContractVersion: typeof PROMPT_REFINER_EXECUTION_CONTRACT_VERSION;
  executionContract: typeof PROMPT_REFINER_EXECUTION_CONTRACT;
  perRequestCostMicroUsd: typeof PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD;
  maxReservations: typeof PROMPT_REFINER_SHADOW_MAX_DISPATCHES;
  costCeilingMicroUsd: typeof PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD;
  executionAdmitted: false;
  productAdapterReady: false;
}>;

export type PromptRefinerStageAdmissionFacts = Readonly<{
  admissionVersion: typeof PROMPT_REFINER_STAGE_ADMISSION_VERSION;
  proposalVersion: typeof PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION;
  proposalDigest: typeof PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST;
  evidenceBundleDigest: typeof PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST;
  evidenceManifestSha256: typeof PROMPT_REFINER_SHADOW_ADMISSION_MANIFEST_SHA256;
  historicalSourceRef: typeof PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF;
  historicalSourceIdentityDigest: typeof PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_IDENTITY_DIGEST;
  corpusDigest: typeof PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST;
  runtimeCommitSha: string;
  runtimeSourceIdentityDigest: string;
  runtimeSourceManifest: PromptRefinerRuntimeSourceManifest;
  runtimeSourceManifestDigest: string;
  runtimeEnvironment: typeof PROMPT_REFINER_STAGE_ENVIRONMENT;
  runtimeDeploymentId: string;
  executionManifest: PromptRefinerExecutionManifest;
  executionManifestDigest: string;
}>;

export type PromptRefinerStagePreviewBinding = Readonly<{
  environment: typeof PROMPT_REFINER_STAGE_ENVIRONMENT;
  deploymentId: string;
  commitSha: string;
  proposalDigest: string;
  runtimeSourceManifestDigest: string;
  executionManifestDigest: string;
  perRequestCostMicroUsd: number;
  maxReservations: number;
  costCeilingMicroUsd: number;
  approvalTtlMinutes: number;
}>;

const sha256 = (bytes: string | Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

export const prefixedPromptRefinerDigest = (value: unknown): string =>
  `sha256:${sha256(canonicalBenchmarkJson(value))}`;

/**
 * Binds an operator preview to the exact deployment and every server-owned
 * cost, capacity, and expiry fact that the subsequent write will use.
 */
export const promptRefinerStagePreviewBindingDigest = (
  binding: PromptRefinerStagePreviewBinding
): string => prefixedPromptRefinerDigest(binding);

export const buildPromptRefinerStagePreviewBinding = (
  facts: Pick<
    PromptRefinerStageAdmissionFacts,
    | "runtimeEnvironment"
    | "runtimeDeploymentId"
    | "runtimeCommitSha"
    | "proposalDigest"
    | "runtimeSourceManifestDigest"
    | "executionManifestDigest"
  >
): PromptRefinerStagePreviewBinding =>
  Object.freeze({
    environment: facts.runtimeEnvironment,
    deploymentId: facts.runtimeDeploymentId,
    commitSha: facts.runtimeCommitSha,
    proposalDigest: facts.proposalDigest,
    runtimeSourceManifestDigest: facts.runtimeSourceManifestDigest,
    executionManifestDigest: facts.executionManifestDigest,
    perRequestCostMicroUsd: PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
    maxReservations: PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
    costCeilingMicroUsd: PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
    approvalTtlMinutes: PROMPT_REFINER_STAGE_APPROVAL_TTL_MS / 60_000,
  });

const FULL_SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HEX_DIGEST = /^[a-f0-9]{64}$/;
const DEPLOYMENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const runtimeSourceManifestProblems = (
  manifest: PromptRefinerRuntimeSourceManifest
): string[] => {
  const problems: string[] = [];
  const expected = [...PROMPT_REFINER_RUNTIME_SOURCE_PATHS];
  if (
    manifest.schemaVersion !== PROMPT_REFINER_RUNTIME_SOURCE_MANIFEST_VERSION ||
    manifest.files.length !== expected.length ||
    manifest.files.some((entry, index) => entry.path !== expected[index])
  ) {
    problems.push("runtime_source_paths");
  }
  const totalSizeBytes = manifest.files.reduce((sum, entry) => {
    if (
      !Number.isSafeInteger(entry.sizeBytes) ||
      entry.sizeBytes <= 0 ||
      entry.sizeBytes > PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES ||
      !/^[a-f0-9]{64}$/.test(entry.sha256)
    ) {
      problems.push("runtime_source_file");
    }
    return sum + entry.sizeBytes;
  }, 0);
  if (
    !Number.isSafeInteger(manifest.totalSizeBytes) ||
    manifest.totalSizeBytes !== totalSizeBytes ||
    totalSizeBytes <= 0 ||
    totalSizeBytes > PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES
  ) {
    problems.push("runtime_source_total_size");
  }
  return [...new Set(problems)];
};

export const buildPromptRefinerRuntimeSourceManifest = (input: {
  commitSha: string;
  files: ReadonlyMap<string, Uint8Array>;
}): {
  manifest: PromptRefinerRuntimeSourceManifest;
  sourceIdentityDigest: string;
  manifestDigest: string;
} => {
  if (!FULL_SHA.test(input.commitSha)) {
    throw new Error("prompt_refiner_stage_runtime_commit_invalid");
  }
  const expected = [...PROMPT_REFINER_RUNTIME_SOURCE_PATHS];
  if (
    input.files.size !== expected.length ||
    expected.some((path) => !input.files.has(path)) ||
    [...input.files.keys()].some((path) => !expected.includes(path as never))
  ) {
    throw new Error("prompt_refiner_stage_runtime_source_path_allowlist");
  }
  let totalSizeBytes = 0;
  const files = expected.map((path) => {
    const bytes = input.files.get(path);
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength === 0 ||
      bytes.byteLength > PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES
    ) {
      throw new Error("prompt_refiner_stage_runtime_source_file_invalid");
    }
    totalSizeBytes += bytes.byteLength;
    if (totalSizeBytes > PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES) {
      throw new Error("prompt_refiner_stage_runtime_source_total_size");
    }
    return Object.freeze({ path, sizeBytes: bytes.byteLength, sha256: sha256(bytes) });
  });
  const manifest = Object.freeze({
    schemaVersion: PROMPT_REFINER_RUNTIME_SOURCE_MANIFEST_VERSION,
    commitSha: input.commitSha,
    totalSizeBytes,
    files: Object.freeze(files),
  });
  const sourceIdentityDigest = prefixedPromptRefinerDigest({ files });
  return Object.freeze({
    manifest,
    sourceIdentityDigest,
    manifestDigest: prefixedPromptRefinerDigest(manifest),
  });
};

export const promptRefinerExecutionManifest = (): PromptRefinerExecutionManifest =>
  Object.freeze({
    schemaVersion: PROMPT_REFINER_EXECUTION_MANIFEST_VERSION,
    stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
    reservationContractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
    runtimeSource: Object.freeze({
      fileCount: PROMPT_REFINER_RUNTIME_SOURCE_FILE_COUNT,
      maxFileBytes: PROMPT_REFINER_RUNTIME_SOURCE_FILE_MAX_BYTES,
      maxTotalBytes: PROMPT_REFINER_RUNTIME_SOURCE_TOTAL_MAX_BYTES,
    }),
    executionContractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
    executionContract: PROMPT_REFINER_EXECUTION_CONTRACT,
    perRequestCostMicroUsd: PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
    maxReservations: PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
    costCeilingMicroUsd: PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
    executionAdmitted: false,
    productAdapterReady: false,
  });

export const buildPromptRefinerStageAdmissionFacts = (input: {
  runtimeCommitSha: string;
  runtimeDeploymentId: string;
  runtimeEnvironment: string;
  runtimeSourceManifest: PromptRefinerRuntimeSourceManifest;
  runtimeSourceIdentityDigest: string;
  runtimeSourceManifestDigest: string;
}): PromptRefinerStageAdmissionFacts => {
  if (input.runtimeEnvironment !== PROMPT_REFINER_STAGE_ENVIRONMENT) {
    throw new Error("prompt_refiner_stage_environment_not_staging");
  }
  if (!FULL_SHA.test(input.runtimeCommitSha) || input.runtimeSourceManifest.commitSha !== input.runtimeCommitSha) {
    throw new Error("prompt_refiner_stage_runtime_commit_invalid");
  }
  if (!DEPLOYMENT_ID.test(input.runtimeDeploymentId)) {
    throw new Error("prompt_refiner_stage_deployment_id_invalid");
  }
  if (runtimeSourceManifestProblems(input.runtimeSourceManifest).length > 0) {
    throw new Error("prompt_refiner_stage_runtime_manifest_invalid");
  }
  if (!DIGEST.test(input.runtimeSourceIdentityDigest) || !DIGEST.test(input.runtimeSourceManifestDigest)) {
    throw new Error("prompt_refiner_stage_runtime_digest_invalid");
  }
  if (prefixedPromptRefinerDigest(input.runtimeSourceManifest) !== input.runtimeSourceManifestDigest) {
    throw new Error("prompt_refiner_stage_runtime_manifest_digest_mismatch");
  }
  if (prefixedPromptRefinerDigest({ files: input.runtimeSourceManifest.files }) !== input.runtimeSourceIdentityDigest) {
    throw new Error("prompt_refiner_stage_runtime_source_identity_mismatch");
  }
  const executionManifest = promptRefinerExecutionManifest();
  return Object.freeze({
    admissionVersion: PROMPT_REFINER_STAGE_ADMISSION_VERSION,
    proposalVersion: PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION,
    proposalDigest: PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST,
    evidenceBundleDigest: PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST,
    evidenceManifestSha256: PROMPT_REFINER_SHADOW_ADMISSION_MANIFEST_SHA256,
    historicalSourceRef: PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF,
    historicalSourceIdentityDigest: PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_IDENTITY_DIGEST,
    corpusDigest: PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST,
    runtimeCommitSha: input.runtimeCommitSha,
    runtimeSourceIdentityDigest: input.runtimeSourceIdentityDigest,
    runtimeSourceManifest: input.runtimeSourceManifest,
    runtimeSourceManifestDigest: input.runtimeSourceManifestDigest,
    runtimeEnvironment: PROMPT_REFINER_STAGE_ENVIRONMENT,
    runtimeDeploymentId: input.runtimeDeploymentId,
    executionManifest,
    executionManifestDigest: prefixedPromptRefinerDigest(executionManifest),
  });
};

export const promptRefinerStageAdmissionProblems = (
  value: PromptRefinerStageAdmissionFacts
): string[] => {
  const problems: string[] = [];
  if (value.admissionVersion !== PROMPT_REFINER_STAGE_ADMISSION_VERSION) problems.push("admission_version");
  if (value.proposalVersion !== PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_VERSION) problems.push("proposal_version");
  if (value.proposalDigest !== PROMPT_REFINER_SHADOW_STAGE_PROPOSAL_DIGEST) problems.push("proposal_digest");
  if (value.evidenceBundleDigest !== PROMPT_REFINER_SHADOW_ADMISSION_EVIDENCE_BUNDLE_DIGEST) problems.push("evidence_bundle_digest");
  if (value.evidenceManifestSha256 !== PROMPT_REFINER_SHADOW_ADMISSION_MANIFEST_SHA256) problems.push("evidence_manifest_sha256");
  if (value.historicalSourceRef !== PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_REF) problems.push("historical_source_ref");
  if (value.historicalSourceIdentityDigest !== PROMPT_REFINER_SHADOW_ADMISSION_SOURCE_IDENTITY_DIGEST) problems.push("historical_source_identity_digest");
  if (value.corpusDigest !== PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST) problems.push("corpus_digest");
  if (
    !FULL_SHA.test(value.runtimeCommitSha) ||
    value.runtimeSourceManifest.commitSha !== value.runtimeCommitSha
  ) {
    problems.push("runtime_commit_sha");
  }
  problems.push(...runtimeSourceManifestProblems(value.runtimeSourceManifest));
  if (
    !DIGEST.test(value.runtimeSourceIdentityDigest) ||
    prefixedPromptRefinerDigest({ files: value.runtimeSourceManifest.files }) !==
      value.runtimeSourceIdentityDigest
  ) {
    problems.push("runtime_source_identity_digest");
  }
  if (!DIGEST.test(value.runtimeSourceManifestDigest) || prefixedPromptRefinerDigest(value.runtimeSourceManifest) !== value.runtimeSourceManifestDigest) problems.push("runtime_source_manifest_digest");
  if (value.runtimeEnvironment !== PROMPT_REFINER_STAGE_ENVIRONMENT) problems.push("runtime_environment");
  if (!DEPLOYMENT_ID.test(value.runtimeDeploymentId)) problems.push("runtime_deployment_id");
  if (!DIGEST.test(value.executionManifestDigest) || prefixedPromptRefinerDigest(value.executionManifest) !== value.executionManifestDigest) problems.push("execution_manifest_digest");
  if (canonicalBenchmarkJson(value.executionManifest) !== canonicalBenchmarkJson(promptRefinerExecutionManifest())) problems.push("execution_manifest");
  if (!HEX_DIGEST.test(value.evidenceManifestSha256) || !HEX_DIGEST.test(value.historicalSourceIdentityDigest) || !HEX_DIGEST.test(value.corpusDigest)) problems.push("historical_digest_shape");
  return problems;
};

export const promptRefinerStageApprovalWindowProblems = (input: {
  approvedAt: Date;
  approvalExpiresAt: Date;
  now: Date;
}): string[] => {
  const problems: string[] = [];
  if (input.approvalExpiresAt.getTime() - input.approvedAt.getTime() !== PROMPT_REFINER_STAGE_APPROVAL_TTL_MS) problems.push("approval_ttl");
  if (input.approvedAt.getTime() > input.now.getTime()) problems.push("approval_from_future");
  if (input.approvalExpiresAt.getTime() <= input.now.getTime()) problems.push("approval_expired");
  return problems;
};
