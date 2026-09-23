import { createHash } from "node:crypto";

import {
    PROMPT_REFINER_EXECUTION_MODEL_PIN,
    PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
    PROMPT_REFINER_MAX_INPUT_TOKENS,
    PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
    PROMPT_REFINER_RETRY_COUNT,
    PROMPT_REFINER_TIMEOUT_MS,
    promptRefinerExecutionContractProblems,
} from "@/lib/promptRefinerExecutionContract";
import {
    PROMPT_REFINER_RESERVATION_AUTHORITY_VERSION,
    PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
    PROMPT_REFINER_RESERVATION_STAGE_ID,
} from "@/lib/promptRefinerReservationCore";
import {
    PROMPT_REFINER_SHADOW_CORPUS_CASES,
    PROMPT_REFINER_SHADOW_CORPUS_DIGEST,
    PROMPT_REFINER_SHADOW_CORPUS_ID,
    PROMPT_REFINER_SHADOW_CORPUS_VERSION,
} from "@/lib/promptRefinerShadowHarness";
import {
    PROMPT_REFINER_SHADOW_EVIDENCE_MAX_DURATION_MS,
    PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST,
    PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_ID,
    PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_VERSION,
} from "@/lib/promptRefinerShadowEvidenceCore";

export const PROMPT_REFINER_SHADOW_RUN_CONTRACT_VERSION =
    "prompt-refiner-shadow-run-v4" as const;
export const PROMPT_REFINER_SHADOW_ADAPTER_VERSION =
    "prompt-refiner-openai-sdk-adapter-v1" as const;
export const PROMPT_REFINER_SHADOW_BYTE_PREFILTER_FRAMING_ALLOWANCE = 32 as const;
export const PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE = "js-tiktoken" as const;
export const PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION = "1.0.21" as const;
export const PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING = "o200k_base" as const;
export const PROMPT_REFINER_SHADOW_RUN_SOURCE_MANIFEST_VERSION =
    "prompt-refiner-shadow-run-source-v2" as const;
export const PROMPT_REFINER_SHADOW_RUN_APPROVAL_FLAG =
    "PROMPT_REFINER_SHADOW_RUN_APPROVAL_ENABLED" as const;
export const PROMPT_REFINER_SHADOW_RUN_CONFIRMATION =
    "APPROVE PROMPT REFINER SHADOW RUN V4 FOR THE DISPLAYED COST CEILING" as const;
export const PROMPT_REFINER_SHADOW_RUN_ID =
    "prompt-refiner-shadow-run-v4" as const;
export const PROMPT_REFINER_SHADOW_EXECUTION_FLAG =
    "PROMPT_REFINER_SHADOW_EXECUTION_ENABLED" as const;
export const PROMPT_REFINER_SHADOW_EXECUTION_CONFIRMATION =
    "EXECUTE THE APPROVED PROMPT REFINER SHADOW RUN V4 ONCE" as const;
// Unknown sweeps persist this threshold as terminal telemetry. Deriving it
// from the evidence ceiling prevents the sweep from producing a receipt that
// the writer or the durable aggregate reader must reject.
export const PROMPT_REFINER_SHADOW_RUN_UNKNOWN_AFTER_MS =
    PROMPT_REFINER_SHADOW_EVIDENCE_MAX_DURATION_MS;
export const PROMPT_REFINER_SHADOW_RUN_SWEEP_BATCH = 16 as const;
export const PROMPT_REFINER_SHADOW_ROUTE_MAX_DURATION_SECONDS = 300 as const;
/**
 * Stop admitting new cases well before the route's platform cap.
 * A case already dispatched still receives its terminal write; this budget is
 * checked only before the next reservation.
 */
export const PROMPT_REFINER_SHADOW_INVOCATION_BUDGET_MS = 240_000 as const;
export const PROMPT_REFINER_SHADOW_TERMINAL_WRITE_MARGIN_MS = 10_000 as const;
export const PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES =
    PROMPT_REFINER_SHADOW_CORPUS_CASES;
export const PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD =
    PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD *
    PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES;

export const PROMPT_REFINER_SHADOW_RUN_STATUSES = Object.freeze([
    "approved",
    "running",
    "completed",
    "stopped_unknown",
] as const);
export type PromptRefinerShadowRunStatus =
    (typeof PROMPT_REFINER_SHADOW_RUN_STATUSES)[number];

export const PROMPT_REFINER_SHADOW_ATTEMPT_STATUSES = Object.freeze([
    "dispatch_intent",
    "terminal",
] as const);
export type PromptRefinerShadowAttemptStatus =
    (typeof PROMPT_REFINER_SHADOW_ATTEMPT_STATUSES)[number];

/**
 * Files added after the durable stage closure was approved. The run preview
 * binds these exact bytes while also binding the current stage source manifest
 * digest, so the combined approval covers the old closure and this delta.
 */
export const PROMPT_REFINER_SHADOW_RUN_SOURCE_PATHS = Object.freeze([
    "app/api/admin/prompt-refiner/shadow-run/route.ts",
    "app/api/admin/prompt-refiner/shadow-run/execute/route.ts",
    "lib/adminAuditSystemActors.ts",
    "lib/maintenance.ts",
    "lib/promptRefinerShadowLiveAdapter.ts",
    "lib/promptRefinerShadowEvidenceCore.ts",
    "lib/promptRefinerShadowRunContract.ts",
    "lib/promptRefinerShadowRunner.ts",
    "lib/promptRefinerShadowRunStore.ts",
    "lib/promptRefinerShadowSystemAudit.ts",
    "lib/promptRefinerShadowTokenizer.ts",
    "package-lock.json",
    "package.json",
    "docs/ops/prompt-refiner-shadow/corpus-v1.json",
    "docs/ops/prompt-refiner-shadow/evidence-spec-v1.json",
    "prisma/schema.prisma",
    "prisma/migrations/20260920120000_prompt_refiner_shadow_run_writer/migration.sql",
    "prisma/migrations/20260920190000_prompt_refiner_shadow_execution_runner/migration.sql",
    "prisma/migrations/20260921100000_prompt_refiner_confirmatory_shadow_v4/migration.sql",
] as const);
export const PROMPT_REFINER_SHADOW_RUN_SOURCE_MAX_FILE_BYTES = 2 * 1024 * 1024;
export const PROMPT_REFINER_SHADOW_RUN_SOURCE_MAX_TOTAL_BYTES = 4 * 1024 * 1024;
export const PROMPT_REFINER_SHADOW_CASE_IDS = Object.freeze([
    "prsv1-ko-01",
    "prsv1-ko-02",
    "prsv1-ko-03",
    "prsv1-ko-04",
    "prsv1-ko-05",
    "prsv1-ko-06",
    "prsv1-ko-07",
    "prsv1-ko-08",
    "prsv1-en-01",
    "prsv1-en-02",
    "prsv1-en-03",
    "prsv1-en-04",
    "prsv1-en-05",
    "prsv1-en-06",
    "prsv1-en-07",
    "prsv1-en-08",
] as const);

const canonicalJson = (value: unknown): string => {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
    }
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
        .join(",")}}`;
};

/**
 * The stage writer authorises a bounded reservation pool, not provider work.
 * This second contract narrows one future paid run to the frozen 16-case
 * synthetic corpus. The owner-only execution entry point is admitted only for
 * that shadow run; product Chat remains explicitly outside the contract.
 */
export const PROMPT_REFINER_SHADOW_RUN_CONTRACT = Object.freeze({
    runContractVersion: PROMPT_REFINER_SHADOW_RUN_CONTRACT_VERSION,
    executionContractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
    reservationAuthorityVersion: PROMPT_REFINER_RESERVATION_AUTHORITY_VERSION,
    reservationContractDigest: PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST,
    stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
    adapterVersion: PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
    corpus: Object.freeze({
        schemaVersion: PROMPT_REFINER_SHADOW_CORPUS_VERSION,
        corpusId: PROMPT_REFINER_SHADOW_CORPUS_ID,
        corpusDigest: PROMPT_REFINER_SHADOW_CORPUS_DIGEST,
        cases: PROMPT_REFINER_SHADOW_CORPUS_CASES,
    }),
    evidence: Object.freeze({
        specVersion: PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_VERSION,
        specId: PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_ID,
        specDigest: PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST,
        evaluation: "transient_proposal_to_content_free_case_evidence" as const,
        durableProposalBytes: false,
        durablePerItemContentDigest: false,
        terminalReceiptAtomicity: "same_transaction" as const,
        aggregateRebuild: "content_free_attempt_evidence" as const,
    }),
    request: Object.freeze({
        timeoutMs: PROMPT_REFINER_TIMEOUT_MS,
        retryCount: PROMPT_REFINER_RETRY_COUNT,
        perRequestCostCeilingMicroUsd:
            PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
        renderedInputPrefilter: Object.freeze({
            method: "utf8_bytes_plus_fixed_framing" as const,
            framingTokenAllowance:
                PROMPT_REFINER_SHADOW_BYTE_PREFILTER_FRAMING_ALLOWANCE,
            satisfiesActualTokenizerRequirement: false,
        }),
        actualTokenizer: Object.freeze({
            package: PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE,
            packageVersion: PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION,
            encoding: PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING,
            framingTokenAllowance:
                PROMPT_REFINER_SHADOW_BYTE_PREFILTER_FRAMING_ALLOWANCE,
            satisfiesActualTokenizerRequirement: true,
        }),
    }),
    run: Object.freeze({
        runId: PROMPT_REFINER_SHADOW_RUN_ID,
        caseIds: PROMPT_REFINER_SHADOW_CASE_IDS,
        maxDispatches: PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES,
        costCeilingMicroUsd:
            PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD,
        requiresExplicitCostApproval: true,
        unknownOutcomePolicy: "stop_no_redispatch" as const,
        consumedWithoutTerminalAfterMs:
            PROMPT_REFINER_SHADOW_RUN_UNKNOWN_AFTER_MS,
        routeMaxDurationSeconds:
            PROMPT_REFINER_SHADOW_ROUTE_MAX_DURATION_SECONDS,
        invocationBudgetMs: PROMPT_REFINER_SHADOW_INVOCATION_BUDGET_MS,
        terminalWriteMarginMs:
            PROMPT_REFINER_SHADOW_TERMINAL_WRITE_MARGIN_MS,
    }),
    shadowAdapterImplemented: true,
    durableRunWriterReady: true,
    runApprovalPreviewReady: true,
    entryPointReady: true,
    executionAdmitted: true,
    productAdapterReady: false,
} as const);

const computedDigest = `sha256:${createHash("sha256")
    .update(canonicalJson(PROMPT_REFINER_SHADOW_RUN_CONTRACT), "utf8")
    .digest("hex")}`;

// Replaced with the computed literal before review. A mismatch fails import.
export const PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST =
    "sha256:16051b8c1c10d1d14b85e65dc3697cf7230dd6c9bce8a30bb03d328f963eafd7" as const;

if (computedDigest !== PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST) {
    throw new Error(`Prompt Refiner shadow run contract digest drifted: ${computedDigest}`);
}

export const promptRefinerShadowRunContractProblems = (): string[] => {
    const problems = promptRefinerExecutionContractProblems().map(
        (problem) => `execution_${problem}`
    );
    if (
        PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES !==
        PROMPT_REFINER_SHADOW_CORPUS_CASES
    ) {
        problems.push("run_case_count_mismatch");
    }
    if (
        PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD !==
        PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD *
            PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES
    ) {
        problems.push("run_cost_ceiling_mismatch");
    }
    if (PROMPT_REFINER_RETRY_COUNT !== 0) problems.push("retry_mismatch");
    if (
        PROMPT_REFINER_SHADOW_INVOCATION_BUDGET_MS >=
            PROMPT_REFINER_SHADOW_ROUTE_MAX_DURATION_SECONDS * 1_000 ||
        PROMPT_REFINER_SHADOW_INVOCATION_BUDGET_MS <=
            PROMPT_REFINER_TIMEOUT_MS +
                PROMPT_REFINER_SHADOW_TERMINAL_WRITE_MARGIN_MS
    ) {
        problems.push("invocation_budget_mismatch");
    }
    if (
        PROMPT_REFINER_SHADOW_CASE_IDS.length !==
            PROMPT_REFINER_SHADOW_CORPUS_CASES ||
        new Set(PROMPT_REFINER_SHADOW_CASE_IDS).size !==
            PROMPT_REFINER_SHADOW_CASE_IDS.length
    ) {
        problems.push("run_case_ids_mismatch");
    }
    if (PROMPT_REFINER_SHADOW_RUN_CONTRACT.executionAdmitted !== true) {
        problems.push("execution_must_be_admitted");
    }
    if (PROMPT_REFINER_SHADOW_RUN_CONTRACT.entryPointReady !== true) {
        problems.push("entry_point_must_be_ready");
    }
    if (
        PROMPT_REFINER_SHADOW_RUN_CONTRACT.request.actualTokenizer
            .satisfiesActualTokenizerRequirement !== true
    ) {
        problems.push("actual_tokenizer_must_be_ready");
    }
    if (PROMPT_REFINER_SHADOW_RUN_CONTRACT.durableRunWriterReady !== true) {
        problems.push("durable_writer_must_be_ready");
    }
    if (PROMPT_REFINER_SHADOW_RUN_CONTRACT.runApprovalPreviewReady !== true) {
        problems.push("run_preview_must_be_ready");
    }
    if (PROMPT_REFINER_SHADOW_RUN_CONTRACT.productAdapterReady !== false) {
        problems.push("product_adapter_must_remain_unready");
    }
    return problems;
};

export type PromptRefinerShadowRunSourceManifest = Readonly<{
    schemaVersion: typeof PROMPT_REFINER_SHADOW_RUN_SOURCE_MANIFEST_VERSION;
    commitSha: string;
    totalSizeBytes: number;
    files: readonly Readonly<{
        path: (typeof PROMPT_REFINER_SHADOW_RUN_SOURCE_PATHS)[number];
        sizeBytes: number;
        sha256: string;
    }>[];
}>;

export const promptRefinerShadowRunDigest = (value: unknown): string =>
    `sha256:${createHash("sha256")
        .update(canonicalJson(value), "utf8")
        .digest("hex")}`;

export const buildPromptRefinerShadowRunSourceManifest = (input: {
    commitSha: string;
    files: ReadonlyMap<string, Uint8Array>;
}): Readonly<{
    manifest: PromptRefinerShadowRunSourceManifest;
    manifestDigest: string;
}> => {
    if (!/^[a-f0-9]{40}$/.test(input.commitSha)) {
        throw new Error("prompt_refiner_shadow_run_commit_invalid");
    }
    const expected = [...PROMPT_REFINER_SHADOW_RUN_SOURCE_PATHS];
    if (
        input.files.size !== expected.length ||
        expected.some((path) => !input.files.has(path)) ||
        [...input.files.keys()].some((path) => !expected.includes(path as never))
    ) {
        throw new Error("prompt_refiner_shadow_run_source_path_allowlist");
    }
    let totalSizeBytes = 0;
    const files = expected.map((path) => {
        const bytes = input.files.get(path);
        if (
            !(bytes instanceof Uint8Array) ||
            bytes.byteLength === 0 ||
            bytes.byteLength > PROMPT_REFINER_SHADOW_RUN_SOURCE_MAX_FILE_BYTES
        ) {
            throw new Error("prompt_refiner_shadow_run_source_file_invalid");
        }
        totalSizeBytes += bytes.byteLength;
        if (totalSizeBytes > PROMPT_REFINER_SHADOW_RUN_SOURCE_MAX_TOTAL_BYTES) {
            throw new Error("prompt_refiner_shadow_run_source_total_size");
        }
        return Object.freeze({
            path,
            sizeBytes: bytes.byteLength,
            sha256: createHash("sha256").update(bytes).digest("hex"),
        });
    });
    const manifest = Object.freeze({
        schemaVersion: PROMPT_REFINER_SHADOW_RUN_SOURCE_MANIFEST_VERSION,
        commitSha: input.commitSha,
        totalSizeBytes,
        files: Object.freeze(files),
    });
    return Object.freeze({
        manifest,
        manifestDigest: promptRefinerShadowRunDigest(manifest),
    });
};

export type PromptRefinerShadowRunPreviewBinding = Readonly<{
    runId: typeof PROMPT_REFINER_SHADOW_RUN_ID;
    stageId: typeof PROMPT_REFINER_RESERVATION_STAGE_ID;
    stageRuntimeSourceManifestDigest: string;
    runSourceManifestDigest: string;
    environment: "staging";
    deploymentId: string;
    commitSha: string;
    stageApprovalExpiresAt: string;
    runContractDigest: typeof PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST;
    corpusDigest: typeof PROMPT_REFINER_SHADOW_CORPUS_DIGEST;
    evidenceSpecDigest: typeof PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST;
    adapterVersion: typeof PROMPT_REFINER_SHADOW_ADAPTER_VERSION;
    provider: typeof PROMPT_REFINER_EXECUTION_MODEL_PIN.provider;
    modelId: typeof PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId;
    apiModelId: typeof PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId;
    timeoutMs: typeof PROMPT_REFINER_TIMEOUT_MS;
    retryCount: typeof PROMPT_REFINER_RETRY_COUNT;
    tokenizerPackage: typeof PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE;
    tokenizerPackageVersion: typeof PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION;
    tokenizerEncoding: typeof PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING;
    maxInputTokens: typeof PROMPT_REFINER_MAX_INPUT_TOKENS;
    maxDispatches: typeof PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES;
    perRequestCostMicroUsd: typeof PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD;
    costCeilingMicroUsd: typeof PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD;
    unknownOutcomePolicy: "stop_no_redispatch";
    executionAdmitted: true;
    productAdapterReady: false;
}>;

export const buildPromptRefinerShadowRunPreviewBinding = (input: {
    stageRuntimeSourceManifestDigest: string;
    runSourceManifestDigest: string;
    deploymentId: string;
    commitSha: string;
    stageApprovalExpiresAt: Date;
}): PromptRefinerShadowRunPreviewBinding =>
    Object.freeze({
        runId: PROMPT_REFINER_SHADOW_RUN_ID,
        stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
        stageRuntimeSourceManifestDigest: input.stageRuntimeSourceManifestDigest,
        runSourceManifestDigest: input.runSourceManifestDigest,
        environment: "staging",
        deploymentId: input.deploymentId,
        commitSha: input.commitSha,
        stageApprovalExpiresAt: input.stageApprovalExpiresAt.toISOString(),
        runContractDigest: PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST,
        corpusDigest: PROMPT_REFINER_SHADOW_CORPUS_DIGEST,
        evidenceSpecDigest: PROMPT_REFINER_SHADOW_EVIDENCE_SPEC_DIGEST,
        adapterVersion: PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
        provider: PROMPT_REFINER_EXECUTION_MODEL_PIN.provider,
        modelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId,
        apiModelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId,
        timeoutMs: PROMPT_REFINER_TIMEOUT_MS,
        retryCount: PROMPT_REFINER_RETRY_COUNT,
        tokenizerPackage: PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE,
        tokenizerPackageVersion:
            PROMPT_REFINER_SHADOW_TOKENIZER_PACKAGE_VERSION,
        tokenizerEncoding: PROMPT_REFINER_SHADOW_TOKENIZER_ENCODING,
        maxInputTokens: PROMPT_REFINER_MAX_INPUT_TOKENS,
        maxDispatches: PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES,
        perRequestCostMicroUsd:
            PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
        costCeilingMicroUsd:
            PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD,
        unknownOutcomePolicy: "stop_no_redispatch",
        executionAdmitted: true,
        productAdapterReady: false,
    });

export const promptRefinerShadowRunPreviewBindingDigest = (
    binding: PromptRefinerShadowRunPreviewBinding
): string => promptRefinerShadowRunDigest(binding);
