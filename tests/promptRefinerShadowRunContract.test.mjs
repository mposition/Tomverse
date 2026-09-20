import assert from "node:assert/strict";
import test from "node:test";

import {
  PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
} from "../lib/promptRefinerExecutionContract.ts";
import {
  PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
  PROMPT_REFINER_RESERVATION_STAGE_ID,
} from "../lib/promptRefinerReservationCore.ts";
import {
  PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST,
} from "../lib/promptRefinerShadowAdmissionCore.ts";
import {
  PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
  PROMPT_REFINER_SHADOW_BYTE_PREFILTER_FRAMING_ALLOWANCE,
  PROMPT_REFINER_SHADOW_CASE_IDS,
  PROMPT_REFINER_SHADOW_INVOCATION_BUDGET_MS,
  PROMPT_REFINER_SHADOW_RUN_CONTRACT,
  PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST,
  PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD,
  PROMPT_REFINER_SHADOW_RUN_ID,
  PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES,
  PROMPT_REFINER_SHADOW_ROUTE_MAX_DURATION_SECONDS,
  PROMPT_REFINER_SHADOW_RUN_SOURCE_PATHS,
  PROMPT_REFINER_SHADOW_TERMINAL_WRITE_MARGIN_MS,
  PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING,
  PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE,
  PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION,
  buildPromptRefinerShadowRunPreviewBinding,
  buildPromptRefinerShadowRunSourceManifest,
  promptRefinerShadowRunPreviewBindingDigest,
  promptRefinerShadowRunContractProblems,
} from "../lib/promptRefinerShadowRunContract.ts";
import {
  PROMPT_REFINER_SHADOW_CORPUS_DIGEST,
} from "../lib/promptRefinerShadowHarness.ts";

test("shadow run contract narrows the durable stage to the frozen 16-case run", () => {
  assert.equal(PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES, 16);
  assert.equal(
    PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD,
    16 * PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
  );
  assert.equal(PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD, 398_656);
  assert.equal(
    PROMPT_REFINER_SHADOW_RUN_CONTRACT.reservationContractDigest,
    PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
  );
  assert.equal(
    PROMPT_REFINER_SHADOW_RUN_CONTRACT.stageId,
    PROMPT_REFINER_RESERVATION_STAGE_ID,
  );
  assert.equal(
    PROMPT_REFINER_SHADOW_RUN_CONTRACT.adapterVersion,
    PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
  );
  assert.equal(
    PROMPT_REFINER_SHADOW_CORPUS_DIGEST,
    PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST,
  );
  assert.equal(PROMPT_REFINER_SHADOW_BYTE_PREFILTER_FRAMING_ALLOWANCE, 32);
  assert.deepEqual(
    PROMPT_REFINER_SHADOW_RUN_CONTRACT.request.renderedInputPrefilter,
    {
      method: "utf8_bytes_plus_fixed_framing",
      framingTokenAllowance: 32,
      satisfiesActualTokenizerRequirement: false,
    },
  );
  assert.deepEqual(PROMPT_REFINER_SHADOW_RUN_CONTRACT.request.actualTokenizer, {
    package: PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE,
    packageVersion: PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION,
    encoding: PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING,
    framingTokenAllowance: 32,
    satisfiesActualTokenizerRequirement: true,
  });
  assert.equal(
    PROMPT_REFINER_SHADOW_RUN_CONTRACT.run.unknownOutcomePolicy,
    "stop_no_redispatch",
  );
  assert.equal(
    PROMPT_REFINER_SHADOW_RUN_CONTRACT.run.requiresExplicitCostApproval,
    true,
  );
  assert.equal(PROMPT_REFINER_SHADOW_INVOCATION_BUDGET_MS, 240_000);
  assert.equal(PROMPT_REFINER_SHADOW_ROUTE_MAX_DURATION_SECONDS, 300);
  assert.equal(
    PROMPT_REFINER_SHADOW_RUN_CONTRACT.run.routeMaxDurationSeconds,
    PROMPT_REFINER_SHADOW_ROUTE_MAX_DURATION_SECONDS,
  );
  assert.equal(PROMPT_REFINER_SHADOW_TERMINAL_WRITE_MARGIN_MS, 10_000);
  assert.equal(
    PROMPT_REFINER_SHADOW_RUN_CONTRACT.run.invocationBudgetMs,
    PROMPT_REFINER_SHADOW_INVOCATION_BUDGET_MS,
  );
  assert.equal(
    PROMPT_REFINER_SHADOW_RUN_CONTRACT.run.terminalWriteMarginMs,
    PROMPT_REFINER_SHADOW_TERMINAL_WRITE_MARGIN_MS,
  );
  assert.equal(PROMPT_REFINER_SHADOW_RUN_CONTRACT.run.runId, PROMPT_REFINER_SHADOW_RUN_ID);
  assert.deepEqual(PROMPT_REFINER_SHADOW_RUN_CONTRACT.run.caseIds, PROMPT_REFINER_SHADOW_CASE_IDS);
  assert.equal(PROMPT_REFINER_SHADOW_CASE_IDS.length, 16);
  assert.equal(new Set(PROMPT_REFINER_SHADOW_CASE_IDS).size, 16);
  assert.deepEqual(promptRefinerShadowRunContractProblems(), []);
});

test("v3 admits only the owner-only shadow entry point, never the product path", () => {
  assert.equal(PROMPT_REFINER_SHADOW_RUN_CONTRACT.shadowAdapterImplemented, true);
  assert.equal(PROMPT_REFINER_SHADOW_RUN_CONTRACT.durableRunWriterReady, true);
  assert.equal(PROMPT_REFINER_SHADOW_RUN_CONTRACT.runApprovalPreviewReady, true);
  assert.equal(PROMPT_REFINER_SHADOW_RUN_CONTRACT.entryPointReady, true);
  assert.equal(PROMPT_REFINER_SHADOW_RUN_CONTRACT.executionAdmitted, true);
  assert.equal(PROMPT_REFINER_SHADOW_RUN_CONTRACT.productAdapterReady, false);
  assert.match(
    PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST,
    /^sha256:[a-f0-9]{64}$/,
  );
});

test("run source manifest is exact, bounded and commit-bound", () => {
  const files = new Map(
    PROMPT_REFINER_SHADOW_RUN_SOURCE_PATHS.map((path, index) => [
      path,
      new TextEncoder().encode(`fixture-${index}`),
    ]),
  );
  const built = buildPromptRefinerShadowRunSourceManifest({
    commitSha: "a".repeat(40),
    files,
  });
  assert.equal(built.manifest.files.length, PROMPT_REFINER_SHADOW_RUN_SOURCE_PATHS.length);
  assert.deepEqual(
    built.manifest.files.map((entry) => entry.path),
    [...PROMPT_REFINER_SHADOW_RUN_SOURCE_PATHS],
  );
  assert.match(built.manifestDigest, /^sha256:[a-f0-9]{64}$/);
  assert.throws(
    () => buildPromptRefinerShadowRunSourceManifest({
      commitSha: "a".repeat(40),
      files: new Map([...files].slice(1)),
    }),
    /source_path_allowlist/,
  );
});

test("run preview digest binds deployment, stage closure, delta and cost", () => {
  const base = {
    stageRuntimeSourceManifestDigest: `sha256:${"1".repeat(64)}`,
    runSourceManifestDigest: `sha256:${"2".repeat(64)}`,
    deploymentId: "deploy-1",
    commitSha: "a".repeat(40),
    stageApprovalExpiresAt: new Date("2026-09-20T03:00:00.000Z"),
  };
  const binding = buildPromptRefinerShadowRunPreviewBinding(base);
  const digest = promptRefinerShadowRunPreviewBindingDigest(binding);
  assert.match(digest, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(
    digest,
    promptRefinerShadowRunPreviewBindingDigest(
      buildPromptRefinerShadowRunPreviewBinding({ ...base, deploymentId: "deploy-2" }),
    ),
  );
  assert.equal(binding.executionAdmitted, true);
  assert.equal(binding.productAdapterReady, false);
  assert.equal(binding.tokenizerPackage, PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE);
  assert.equal(
    binding.tokenizerPackageVersion,
    PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION,
  );
  assert.equal(binding.tokenizerEncoding, PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING);
  assert.equal(binding.maxInputTokens, 100_000);
});
