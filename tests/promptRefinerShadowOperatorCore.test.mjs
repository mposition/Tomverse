import assert from "node:assert/strict";
import test from "node:test";

import {
  PROMPT_REFINER_SHADOW_OPERATOR_CONTRACT,
  parsePromptRefinerExecutionPreview,
  parsePromptRefinerExecutionResult,
  parsePromptRefinerRunPreview,
  parsePromptRefinerStagePreview,
  promptRefinerExecutionBody,
  promptRefinerRunApprovalBody,
  promptRefinerStageApprovalBody,
} from "../lib/promptRefinerShadowOperatorCore.ts";
import {
  PROMPT_REFINER_EXECUTION_MODEL_PIN,
  PROMPT_REFINER_MAX_INPUT_TOKENS,
  PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
  PROMPT_REFINER_RETRY_COUNT,
  PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
  PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
  PROMPT_REFINER_TIMEOUT_MS,
} from "../lib/promptRefinerExecutionContract.ts";
import { PROMPT_REFINER_RESERVATION_STAGE_ID } from "../lib/promptRefinerReservationCore.ts";
import {
  PROMPT_REFINER_SHADOW_EXECUTION_CONFIRMATION,
  PROMPT_REFINER_SHADOW_RUN_CONFIRMATION,
  PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD,
  PROMPT_REFINER_SHADOW_RUN_ID,
  PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES,
  PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING,
  PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE,
  PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION,
} from "../lib/promptRefinerShadowRunContract.ts";
import {
  PROMPT_REFINER_STAGE_APPROVAL_TTL_MS,
  PROMPT_REFINER_STAGE_CONFIRMATION,
  PROMPT_REFINER_STAGE_ENVIRONMENT,
} from "../lib/promptRefinerStageAdmissionCore.ts";

const digest = (character) => `sha256:${character.repeat(64)}`;
const contract = PROMPT_REFINER_SHADOW_OPERATOR_CONTRACT;

test("the duplicated browser contract exactly matches server-owned constants", () => {
  assert.deepEqual(contract, {
    stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
    runId: PROMPT_REFINER_SHADOW_RUN_ID,
    environment: PROMPT_REFINER_STAGE_ENVIRONMENT,
    provider: PROMPT_REFINER_EXECUTION_MODEL_PIN.provider,
    modelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId,
    apiModelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId,
    perRequestCostMicroUsd: PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
    stageMaxReservations: PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
    stageCostCeilingMicroUsd: PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
    runMaxDispatches: PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES,
    runCostCeilingMicroUsd: PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD,
    approvalTtlMinutes: PROMPT_REFINER_STAGE_APPROVAL_TTL_MS / 60_000,
    timeoutMs: PROMPT_REFINER_TIMEOUT_MS,
    retryCount: PROMPT_REFINER_RETRY_COUNT,
    tokenizerPackage: PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE,
    tokenizerPackageVersion: PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION,
    tokenizerEncoding: PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING,
    maxInputTokens: PROMPT_REFINER_MAX_INPUT_TOKENS,
    stageConfirmation: PROMPT_REFINER_STAGE_CONFIRMATION,
    runConfirmation: PROMPT_REFINER_SHADOW_RUN_CONFIRMATION,
    executionConfirmation: PROMPT_REFINER_SHADOW_EXECUTION_CONFIRMATION,
  });
});

const stageBody = () => ({
  preview: {
    stageId: contract.stageId,
    status: "ready_for_explicit_cost_approval",
    proposalDigest: digest("1"),
    runtimeSourceManifestDigest: digest("2"),
    executionManifestDigest: digest("3"),
    environment: contract.environment,
    deploymentId: "deployment-1",
    commitSha: "a".repeat(40),
    perRequestCostMicroUsd: contract.perRequestCostMicroUsd,
    maxReservations: contract.stageMaxReservations,
    costCeilingMicroUsd: contract.stageCostCeilingMicroUsd,
    approvalTtlMinutes: contract.approvalTtlMinutes,
    previewBindingDigest: digest("4"),
    confirmation: contract.stageConfirmation,
    executionAdmitted: false,
    productAdapterReady: false,
  },
});

const runBody = () => ({
  preview: {
    status: "ready_for_explicit_cost_approval",
    runId: contract.runId,
    stageId: contract.stageId,
    stageRuntimeSourceManifestDigest: digest("2"),
    runSourceManifestDigest: digest("5"),
    environment: contract.environment,
    deploymentId: "deployment-1",
    commitSha: "a".repeat(40),
    stageApprovalExpiresAt: "2026-09-21T02:00:00.000Z",
    runContractDigest: digest("6"),
    corpusDigest: "b".repeat(64),
    evidenceSpecDigest: "c".repeat(64),
    adapterVersion: "prompt-refiner-openai-sdk-adapter-v1",
    provider: contract.provider,
    modelId: contract.modelId,
    apiModelId: contract.apiModelId,
    timeoutMs: contract.timeoutMs,
    retryCount: contract.retryCount,
    tokenizerPackage: contract.tokenizerPackage,
    tokenizerPackageVersion: contract.tokenizerPackageVersion,
    tokenizerEncoding: contract.tokenizerEncoding,
    maxInputTokens: contract.maxInputTokens,
    maxDispatches: contract.runMaxDispatches,
    perRequestCostMicroUsd: contract.perRequestCostMicroUsd,
    costCeilingMicroUsd: contract.runCostCeilingMicroUsd,
    unknownOutcomePolicy: "stop_no_redispatch",
    executionAdmitted: true,
    productAdapterReady: false,
    previewBindingDigest: digest("7"),
    confirmation: contract.runConfirmation,
    approvalEnabled: true,
  },
});

const executionBody = () => ({
  execution: {
    observedAt: "2026-09-21T01:00:00.000Z",
    runId: contract.runId,
    status: "approved",
    dispatchCount: 0,
    terminalCount: 0,
    nextCaseIndex: 0,
    nextCaseId: "general-short-ko",
    inFlightAttemptId: null,
    approvalExpiresAt: "2026-09-21T02:00:00.000Z",
    runContractDigest: digest("6"),
    enabled: true,
    confirmation: contract.executionConfirmation,
    evidence: null,
    productAdapterReady: false,
  },
});

const evidenceBody = () => ({
  gateOutcome: "pass",
  gateReasons: [],
  summary: {
    attemptedCases: 16,
    suggestedCases: 16,
    failedCases: 0,
    unknownCases: 0,
    passedCases: 16,
    passedInjectionCases: 2,
    costReportedCases: 16,
    totalCostMicroUsd: 12_345,
    latencyReportedCases: 16,
    latencyP90Ms: 900,
    latencyMaxMs: 1_200,
  },
});

test("the exact frozen stage, run, and execution previews are accepted", () => {
  const stage = parsePromptRefinerStagePreview(stageBody());
  assert.ok(stage);
  const run = parsePromptRefinerRunPreview(runBody(), stage);
  assert.ok(run);
  const execution = parsePromptRefinerExecutionPreview(executionBody(), run);
  assert.ok(execution);
  assert.equal(run.corpusDigest, "b".repeat(64));
  assert.equal(run.evidenceSpecDigest, "c".repeat(64));
});

test("a completed content-free evidence summary is accepted and malformed summaries fail closed", () => {
  const stage = parsePromptRefinerStagePreview(stageBody());
  assert.ok(stage);
  const run = parsePromptRefinerRunPreview(runBody(), stage);
  assert.ok(run);
  const valid = executionBody();
  valid.execution.evidence = evidenceBody();
  assert.ok(parsePromptRefinerExecutionPreview(valid, run));

  for (const mutate of [
    (evidence) => (evidence.sourceText = "must not cross the API"),
    (evidence) => (evidence.summary.attemptedCases = 15),
    (evidence) => (evidence.summary.unknownCases = 1),
    (evidence) => (evidence.summary.latencyP90Ms = 1_300),
    (evidence) => evidence.gateReasons.push("unknown_reason"),
    (evidence) => evidence.gateReasons.push("unknown_present"),
  ]) {
    const candidate = executionBody();
    candidate.execution.evidence = evidenceBody();
    mutate(candidate.execution.evidence);
    assert.equal(parsePromptRefinerExecutionPreview(candidate, run), null);
  }
});

test("approval bodies reuse only exact server-bound values", () => {
  const stage = parsePromptRefinerStagePreview(stageBody());
  assert.ok(stage);
  assert.deepEqual(promptRefinerStageApprovalBody(stage), {
    proposalDigest: digest("1"),
    runtimeSourceManifestDigest: digest("2"),
    executionManifestDigest: digest("3"),
    previewBindingDigest: digest("4"),
    confirmation: contract.stageConfirmation,
  });

  const run = parsePromptRefinerRunPreview(runBody(), stage);
  assert.ok(run);
  assert.deepEqual(promptRefinerRunApprovalBody(run), {
    runContractDigest: digest("6"),
    stageRuntimeSourceManifestDigest: digest("2"),
    runSourceManifestDigest: digest("5"),
    previewBindingDigest: digest("7"),
    confirmation: contract.runConfirmation,
  });

  const execution = parsePromptRefinerExecutionPreview(executionBody(), run);
  assert.ok(execution);
  assert.deepEqual(promptRefinerExecutionBody(execution), {
    runId: contract.runId,
    runContractDigest: digest("6"),
    confirmation: contract.executionConfirmation,
  });
});

test("cost, model, deployment, and run-contract drift fail closed", () => {
  const stage = parsePromptRefinerStagePreview(stageBody());
  assert.ok(stage);

  for (const mutate of [
    (preview) => (preview.costCeilingMicroUsd += 1),
    (preview) => (preview.modelId = "another-model"),
    (preview) => (preview.deploymentId = "deployment-2"),
    (preview) => (preview.corpusDigest = digest("b")),
    (preview) => (preview.evidenceSpecDigest = digest("c")),
  ]) {
    const candidate = structuredClone(runBody());
    mutate(candidate.preview);
    assert.equal(parsePromptRefinerRunPreview(candidate, stage), null);
  }

  const run = parsePromptRefinerRunPreview(runBody(), stage);
  assert.ok(run);
  const execution = executionBody();
  execution.execution.runContractDigest = digest("8");
  assert.equal(parsePromptRefinerExecutionPreview(execution, run), null);

  const wrongExpiry = executionBody();
  wrongExpiry.execution.approvalExpiresAt = "2030-01-01T00:00:00.000Z";
  assert.equal(parsePromptRefinerExecutionPreview(wrongExpiry, run), null);
});

test("execution results accept only bounded, no-retry receipts", () => {
  const valid = {
    execution: {
      status: "paused",
      attemptedThisInvocation: 8,
      dispatchCount: 8,
      terminalCount: 8,
      inFlightAttemptId: null,
      observedAt: "2026-09-21T01:05:00.000Z",
      retryCount: 0,
      redispatched: 0,
    },
    productAdapterReady: false,
  };
  assert.ok(parsePromptRefinerExecutionResult(valid));

  for (const mutate of [
    (execution) => (execution.retryCount = 1),
    (execution) => (execution.redispatched = 1),
    (execution) => (execution.dispatchCount = 17),
    (execution) => (execution.status = "retry"),
  ]) {
    const candidate = structuredClone(valid);
    mutate(candidate.execution);
    assert.equal(parsePromptRefinerExecutionResult(candidate), null);
  }
});
