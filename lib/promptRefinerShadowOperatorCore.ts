/**
 * Client-safe validation for the owner-only Prompt Refiner shadow operator.
 *
 * The server routes remain the authority. This second, deliberately duplicated
 * boundary keeps the browser from turning a drifted or malformed preview into
 * an approval request. Changing any frozen cost/model/runtime fact therefore
 * requires an explicit operator-UI review as well as a server-contract change.
 */

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const HEX_DIGEST = /^[a-f0-9]{64}$/;
const FULL_SHA = /^[a-f0-9]{40}$/;
const EVIDENCE_GATE_REASONS = new Set([
  "case_evidence_failed",
  "case_evidence_incomplete",
  "injection_evidence_failed",
  "injection_evidence_incomplete",
  "terminal_failure_present",
  "unknown_present",
  "cost_incomplete",
  "cost_threshold_exceeded",
  "latency_incomplete",
  "latency_p90_exceeded",
  "latency_max_exceeded",
]);

export const PROMPT_REFINER_SHADOW_OPERATOR_PATH =
  "/admin/prompt-refiner-shadow" as const;
export const PROMPT_REFINER_SHADOW_STAGE_PATH =
  "/api/admin/prompt-refiner/shadow-stage" as const;
export const PROMPT_REFINER_SHADOW_RUN_PATH =
  "/api/admin/prompt-refiner/shadow-run" as const;
export const PROMPT_REFINER_SHADOW_EXECUTION_PATH =
  "/api/admin/prompt-refiner/shadow-run/execute" as const;

export const PROMPT_REFINER_SHADOW_OPERATOR_CONTRACT = Object.freeze({
  stageId: "prompt-refiner-shadow-v2",
  runId: "prompt-refiner-shadow-run-v4",
  environment: "staging",
  provider: "openai",
  modelId: "gpt-5-6-luna",
  apiModelId: "gpt-5.6-luna",
  perRequestCostMicroUsd: 24_916,
  stageMaxReservations: 100,
  stageCostCeilingMicroUsd: 2_491_600,
  runMaxDispatches: 16,
  runCostCeilingMicroUsd: 398_656,
  approvalTtlMinutes: 60,
  timeoutMs: 15_000,
  retryCount: 0,
  tokenizerPackage: "js-tiktoken",
  tokenizerPackageVersion: "1.0.21",
  tokenizerEncoding: "o200k_base",
  maxInputTokens: 100_000,
  stageConfirmation:
    "APPROVE PROMPT REFINER SHADOW STAGE V2 FOR 60 MINUTES",
  runConfirmation:
    "APPROVE PROMPT REFINER SHADOW RUN V4 FOR THE DISPLAYED COST CEILING",
  executionConfirmation:
    "EXECUTE THE APPROVED PROMPT REFINER SHADOW RUN V4 ONCE",
});

type UnknownRecord = Record<string, unknown>;

const record = (value: unknown): UnknownRecord | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : null;

const string = (value: unknown): string | null =>
  typeof value === "string" ? value : null;
const integer = (value: unknown): number | null =>
  Number.isSafeInteger(value) ? (value as number) : null;
const boolean = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

export type PromptRefinerStagePreview = Readonly<{
  stageId: string;
  status: "ready_for_explicit_cost_approval" | "already_exists";
  proposalDigest: string;
  runtimeSourceManifestDigest: string;
  executionManifestDigest: string;
  environment: string;
  deploymentId: string;
  commitSha: string;
  perRequestCostMicroUsd: number;
  maxReservations: number;
  costCeilingMicroUsd: number;
  approvalTtlMinutes: number;
  previewBindingDigest: string;
  confirmation: string;
  executionAdmitted: false;
  productAdapterReady: false;
}>;

export type PromptRefinerRunPreview = Readonly<{
  status: "ready_for_explicit_cost_approval" | "already_exists";
  runId: string;
  stageId: string;
  stageRuntimeSourceManifestDigest: string;
  runSourceManifestDigest: string;
  environment: string;
  deploymentId: string;
  commitSha: string;
  stageApprovalExpiresAt: string;
  runContractDigest: string;
  corpusDigest: string;
  evidenceSpecDigest: string;
  adapterVersion: string;
  provider: string;
  modelId: string;
  apiModelId: string;
  timeoutMs: number;
  retryCount: number;
  tokenizerPackage: string;
  tokenizerPackageVersion: string;
  tokenizerEncoding: string;
  maxInputTokens: number;
  maxDispatches: number;
  perRequestCostMicroUsd: number;
  costCeilingMicroUsd: number;
  unknownOutcomePolicy: string;
  executionAdmitted: true;
  productAdapterReady: false;
  previewBindingDigest: string;
  confirmation: string;
  approvalEnabled: boolean;
}>;

export type PromptRefinerExecutionPreview = Readonly<{
  observedAt: string;
  runId: string;
  status: "approved" | "running" | "completed" | "stopped_unknown";
  dispatchCount: number;
  terminalCount: number;
  nextCaseIndex: number | null;
  nextCaseId: string | null;
  inFlightAttemptId: string | null;
  approvalExpiresAt: string;
  runContractDigest: string;
  enabled: boolean;
  confirmation: string;
  evidence: PromptRefinerExecutionEvidence | null;
  productAdapterReady: false;
}>;

export type PromptRefinerExecutionEvidence = Readonly<{
  gateOutcome: "pass" | "fail" | "insufficient_evidence";
  gateReasons: readonly string[];
  summary: Readonly<{
    attemptedCases: number;
    suggestedCases: number;
    failedCases: number;
    unknownCases: number;
    passedCases: number;
    passedInjectionCases: number;
    costReportedCases: number;
    totalCostMicroUsd: number | null;
    latencyReportedCases: number;
    latencyP90Ms: number | null;
    latencyMaxMs: number | null;
  }>;
}>;

export type PromptRefinerExecutionResult = Readonly<{
  status: "completed" | "stopped_unknown" | "in_flight" | "paused";
  attemptedThisInvocation: number;
  dispatchCount: number;
  terminalCount: number;
  inFlightAttemptId: string | null;
  observedAt: string;
  retryCount: 0;
  redispatched: 0;
}>;

const expectDigest = (value: unknown) => {
  const parsed = string(value);
  return parsed && DIGEST.test(parsed) ? parsed : null;
};

const evidenceProblems = (value: unknown): readonly string[] => {
  if (value === null) return [];
  const evidence = record(value);
  const summary = record(evidence?.summary);
  if (!evidence || !summary) return ["evidence_shape"];
  if (
    Object.keys(evidence).sort().join("|") !==
      "gateOutcome|gateReasons|summary" ||
    Object.keys(summary).sort().join("|") !==
      [
        "attemptedCases",
        "costReportedCases",
        "failedCases",
        "latencyMaxMs",
        "latencyP90Ms",
        "latencyReportedCases",
        "passedCases",
        "passedInjectionCases",
        "suggestedCases",
        "totalCostMicroUsd",
        "unknownCases",
      ].sort().join("|")
  ) {
    return ["evidence_shape"];
  }
  const serialized = JSON.stringify(value);
  if (/"(?:sourceText|refinedPrompt|promptDigest|proposalDigest)"/.test(serialized)) {
    return ["evidence_content_leak"];
  }
  const problems: string[] = [];
  const gateReasons = Array.isArray(evidence.gateReasons)
    ? evidence.gateReasons
    : null;
  if (
    evidence.gateOutcome !== "pass" &&
    evidence.gateOutcome !== "fail" &&
    evidence.gateOutcome !== "insufficient_evidence"
  ) {
    problems.push("evidence_outcome");
  }
  if (
    gateReasons === null ||
    gateReasons.some(
      (reason) => typeof reason !== "string" || !EVIDENCE_GATE_REASONS.has(reason)
    ) ||
    new Set(gateReasons).size !== gateReasons.length
  ) {
    problems.push("evidence_reasons");
  }
  for (const key of [
    "attemptedCases",
    "suggestedCases",
    "failedCases",
    "unknownCases",
    "passedCases",
    "passedInjectionCases",
    "costReportedCases",
    "latencyReportedCases",
  ] as const) {
    const parsed = integer(summary[key]);
    if (parsed === null || parsed < 0 || parsed > 16) problems.push(`evidence_${key}`);
  }
  for (const key of ["totalCostMicroUsd", "latencyP90Ms", "latencyMaxMs"] as const) {
    const value = summary[key];
    if (value !== null && (integer(value) === null || (value as number) < 0)) {
      problems.push(`evidence_${key}`);
    }
  }
  const attemptedCases = integer(summary.attemptedCases);
  const suggestedCases = integer(summary.suggestedCases);
  const failedCases = integer(summary.failedCases);
  const unknownCases = integer(summary.unknownCases);
  const passedCases = integer(summary.passedCases);
  const passedInjectionCases = integer(summary.passedInjectionCases);
  const costReportedCases = integer(summary.costReportedCases);
  const latencyReportedCases = integer(summary.latencyReportedCases);
  if (
    attemptedCases !== 16 ||
    suggestedCases === null ||
    failedCases === null ||
    unknownCases === null ||
    suggestedCases + failedCases + unknownCases !== 16 ||
    passedCases === null ||
    passedCases > suggestedCases ||
    passedInjectionCases === null ||
    passedInjectionCases > 2 ||
    costReportedCases === null ||
    (costReportedCases === 16) !== (summary.totalCostMicroUsd !== null) ||
    latencyReportedCases === null ||
    (latencyReportedCases === 16) !==
      (summary.latencyP90Ms !== null && summary.latencyMaxMs !== null) ||
    (summary.latencyP90Ms !== null &&
      summary.latencyMaxMs !== null &&
      (summary.latencyP90Ms as number) > (summary.latencyMaxMs as number))
  ) {
    problems.push("evidence_summary_relationships");
  }
  if (
    (evidence.gateOutcome === "pass") !== (gateReasons?.length === 0) ||
    (evidence.gateOutcome === "pass" &&
      (passedCases !== 16 ||
        passedInjectionCases !== 2 ||
        failedCases !== 0 ||
        unknownCases !== 0))
  ) {
    problems.push("evidence_gate_relationships");
  }
  return problems;
};

export const promptRefinerStagePreviewProblems = (
  value: unknown
): readonly string[] => {
  const wrapper = record(value);
  const preview = record(wrapper?.preview);
  if (!preview) return ["preview_missing"];
  const contract = PROMPT_REFINER_SHADOW_OPERATOR_CONTRACT;
  const problems: string[] = [];
  if (preview.stageId !== contract.stageId) problems.push("stage_id");
  if (
    preview.status !== "ready_for_explicit_cost_approval" &&
    preview.status !== "already_exists"
  ) {
    problems.push("status");
  }
  for (const key of [
    "proposalDigest",
    "runtimeSourceManifestDigest",
    "executionManifestDigest",
    "previewBindingDigest",
  ] as const) {
    if (!expectDigest(preview[key])) problems.push(key);
  }
  if (preview.environment !== contract.environment) problems.push("environment");
  if (!string(preview.deploymentId)) problems.push("deployment_id");
  if (!FULL_SHA.test(string(preview.commitSha) || "")) problems.push("commit_sha");
  if (preview.perRequestCostMicroUsd !== contract.perRequestCostMicroUsd)
    problems.push("per_request_cost");
  if (preview.maxReservations !== contract.stageMaxReservations)
    problems.push("max_reservations");
  if (preview.costCeilingMicroUsd !== contract.stageCostCeilingMicroUsd)
    problems.push("stage_cost_ceiling");
  if (preview.approvalTtlMinutes !== contract.approvalTtlMinutes)
    problems.push("approval_ttl");
  if (preview.confirmation !== contract.stageConfirmation)
    problems.push("confirmation");
  if (preview.executionAdmitted !== false) problems.push("execution_admitted");
  if (preview.productAdapterReady !== false) problems.push("product_adapter");
  return problems;
};

export const parsePromptRefinerStagePreview = (
  value: unknown
): PromptRefinerStagePreview | null => {
  if (promptRefinerStagePreviewProblems(value).length > 0) return null;
  return record(value)!.preview as PromptRefinerStagePreview;
};

export const promptRefinerRunPreviewProblems = (
  value: unknown,
  stage: PromptRefinerStagePreview
): readonly string[] => {
  const wrapper = record(value);
  const preview = record(wrapper?.preview);
  if (!preview) return ["preview_missing"];
  const contract = PROMPT_REFINER_SHADOW_OPERATOR_CONTRACT;
  const problems: string[] = [];
  if (preview.runId !== contract.runId) problems.push("run_id");
  if (preview.stageId !== contract.stageId) problems.push("stage_id");
  if (
    preview.status !== "ready_for_explicit_cost_approval" &&
    preview.status !== "already_exists"
  ) {
    problems.push("status");
  }
  for (const key of [
    "stageRuntimeSourceManifestDigest",
    "runSourceManifestDigest",
    "runContractDigest",
    "previewBindingDigest",
  ] as const) {
    if (!expectDigest(preview[key])) problems.push(key);
  }
  if (!HEX_DIGEST.test(string(preview.corpusDigest) || ""))
    problems.push("corpusDigest");
  if (!HEX_DIGEST.test(string(preview.evidenceSpecDigest) || ""))
    problems.push("evidenceSpecDigest");
  if (preview.environment !== contract.environment) problems.push("environment");
  if (preview.deploymentId !== stage.deploymentId) problems.push("deployment_id");
  if (preview.commitSha !== stage.commitSha) problems.push("commit_sha");
  if (preview.provider !== contract.provider) problems.push("provider");
  if (preview.modelId !== contract.modelId) problems.push("model_id");
  if (preview.apiModelId !== contract.apiModelId) problems.push("api_model_id");
  if (preview.timeoutMs !== contract.timeoutMs) problems.push("timeout");
  if (preview.retryCount !== contract.retryCount) problems.push("retry_count");
  if (preview.tokenizerPackage !== contract.tokenizerPackage)
    problems.push("tokenizer_package");
  if (preview.tokenizerPackageVersion !== contract.tokenizerPackageVersion)
    problems.push("tokenizer_version");
  if (preview.tokenizerEncoding !== contract.tokenizerEncoding)
    problems.push("tokenizer_encoding");
  if (preview.maxInputTokens !== contract.maxInputTokens)
    problems.push("max_input_tokens");
  if (preview.maxDispatches !== contract.runMaxDispatches)
    problems.push("max_dispatches");
  if (preview.perRequestCostMicroUsd !== contract.perRequestCostMicroUsd)
    problems.push("per_request_cost");
  if (preview.costCeilingMicroUsd !== contract.runCostCeilingMicroUsd)
    problems.push("run_cost_ceiling");
  if (preview.unknownOutcomePolicy !== "stop_no_redispatch")
    problems.push("unknown_policy");
  if (preview.executionAdmitted !== true) problems.push("execution_admitted");
  if (preview.productAdapterReady !== false) problems.push("product_adapter");
  if (preview.confirmation !== contract.runConfirmation)
    problems.push("confirmation");
  if (boolean(preview.approvalEnabled) === null)
    problems.push("approval_enabled");
  if (!string(preview.adapterVersion)) problems.push("adapter_version");
  if (!string(preview.stageApprovalExpiresAt)) problems.push("stage_expiry");
  return problems;
};

export const parsePromptRefinerRunPreview = (
  value: unknown,
  stage: PromptRefinerStagePreview
): PromptRefinerRunPreview | null => {
  if (promptRefinerRunPreviewProblems(value, stage).length > 0) return null;
  return record(value)!.preview as PromptRefinerRunPreview;
};

export const promptRefinerExecutionPreviewProblems = (
  value: unknown,
  run: PromptRefinerRunPreview
): readonly string[] => {
  const wrapper = record(value);
  const execution = record(wrapper?.execution);
  if (!execution) return ["execution_missing"];
  const contract = PROMPT_REFINER_SHADOW_OPERATOR_CONTRACT;
  const problems: string[] = [];
  if (execution.runId !== contract.runId) problems.push("run_id");
  if (execution.runContractDigest !== run.runContractDigest)
    problems.push("run_contract_digest");
  if (
    execution.status !== "approved" &&
    execution.status !== "running" &&
    execution.status !== "completed" &&
    execution.status !== "stopped_unknown"
  ) {
    problems.push("status");
  }
  for (const key of ["dispatchCount", "terminalCount"] as const) {
    const parsed = integer(execution[key]);
    if (parsed === null || parsed < 0 || parsed > contract.runMaxDispatches)
      problems.push(key);
  }
  const nextCaseIndex = execution.nextCaseIndex;
  if (
    nextCaseIndex !== null &&
    (integer(nextCaseIndex) === null ||
      (nextCaseIndex as number) < 0 ||
      (nextCaseIndex as number) >= contract.runMaxDispatches)
  ) {
    problems.push("next_case_index");
  }
  if (execution.nextCaseId !== null && !string(execution.nextCaseId))
    problems.push("next_case_id");
  if (
    execution.inFlightAttemptId !== null &&
    !string(execution.inFlightAttemptId)
  ) {
    problems.push("in_flight_attempt");
  }
  if (!string(execution.observedAt)) problems.push("observed_at");
  if (execution.approvalExpiresAt !== run.stageApprovalExpiresAt)
    problems.push("approval_expiry");
  if (boolean(execution.enabled) === null) problems.push("enabled");
  if (execution.confirmation !== contract.executionConfirmation)
    problems.push("confirmation");
  if (execution.productAdapterReady !== false) problems.push("product_adapter");
  problems.push(...evidenceProblems(execution.evidence));
  return problems;
};

export const parsePromptRefinerExecutionPreview = (
  value: unknown,
  run: PromptRefinerRunPreview
): PromptRefinerExecutionPreview | null => {
  if (promptRefinerExecutionPreviewProblems(value, run).length > 0) return null;
  return record(value)!.execution as PromptRefinerExecutionPreview;
};

export const parsePromptRefinerExecutionResult = (
  value: unknown
): PromptRefinerExecutionResult | null => {
  const wrapper = record(value);
  const execution = record(wrapper?.execution);
  if (!execution || wrapper?.productAdapterReady !== false) return null;
  if (
    execution.status !== "completed" &&
    execution.status !== "stopped_unknown" &&
    execution.status !== "in_flight" &&
    execution.status !== "paused"
  ) {
    return null;
  }
  for (const key of [
    "attemptedThisInvocation",
    "dispatchCount",
    "terminalCount",
  ] as const) {
    const parsed = integer(execution[key]);
    if (
      parsed === null ||
      parsed < 0 ||
      parsed > PROMPT_REFINER_SHADOW_OPERATOR_CONTRACT.runMaxDispatches
    ) {
      return null;
    }
  }
  if (
    execution.inFlightAttemptId !== null &&
    !string(execution.inFlightAttemptId)
  ) {
    return null;
  }
  if (
    !string(execution.observedAt) ||
    execution.retryCount !== 0 ||
    execution.redispatched !== 0
  ) {
    return null;
  }
  return execution as PromptRefinerExecutionResult;
};

export const promptRefinerStageApprovalBody = (
  preview: PromptRefinerStagePreview
) => ({
  proposalDigest: preview.proposalDigest,
  runtimeSourceManifestDigest: preview.runtimeSourceManifestDigest,
  executionManifestDigest: preview.executionManifestDigest,
  previewBindingDigest: preview.previewBindingDigest,
  confirmation: preview.confirmation,
});

export const promptRefinerRunApprovalBody = (
  preview: PromptRefinerRunPreview
) => ({
  runContractDigest: preview.runContractDigest,
  stageRuntimeSourceManifestDigest:
    preview.stageRuntimeSourceManifestDigest,
  runSourceManifestDigest: preview.runSourceManifestDigest,
  previewBindingDigest: preview.previewBindingDigest,
  confirmation: preview.confirmation,
});

export const promptRefinerExecutionBody = (
  preview: PromptRefinerExecutionPreview
) => ({
  runId: preview.runId,
  runContractDigest: preview.runContractDigest,
  confirmation: preview.confirmation,
});
