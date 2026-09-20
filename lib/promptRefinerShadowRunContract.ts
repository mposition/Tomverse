import { createHash } from "node:crypto";

import {
    PROMPT_REFINER_EXECUTION_MODEL_PIN,
    PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
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

export const PROMPT_REFINER_SHADOW_RUN_CONTRACT_VERSION =
    "prompt-refiner-shadow-run-v2" as const;
export const PROMPT_REFINER_SHADOW_ADAPTER_VERSION =
    "prompt-refiner-openai-sdk-adapter-v1" as const;
export const PROMPT_REFINER_SHADOW_BYTE_PREFILTER_FRAMING_ALLOWANCE = 32 as const;
export const PROMPT_REFINER_SHADOW_RUN_SOURCE_MANIFEST_VERSION =
    "prompt-refiner-shadow-run-source-v1" as const;
export const PROMPT_REFINER_SHADOW_RUN_APPROVAL_FLAG =
    "PROMPT_REFINER_SHADOW_RUN_APPROVAL_ENABLED" as const;
export const PROMPT_REFINER_SHADOW_RUN_CONFIRMATION =
    "APPROVE PROMPT REFINER SHADOW RUN V2 FOR THE DISPLAYED COST CEILING" as const;
export const PROMPT_REFINER_SHADOW_RUN_ID =
    "prompt-refiner-shadow-run-v2" as const;
export const PROMPT_REFINER_SHADOW_RUN_UNKNOWN_AFTER_MS = 60_000 as const;
export const PROMPT_REFINER_SHADOW_RUN_SWEEP_BATCH = 16 as const;
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
    "lib/adminAuditSystemActors.ts",
    "lib/promptRefinerShadowLiveAdapter.ts",
    "lib/promptRefinerShadowRunContract.ts",
    "lib/promptRefinerShadowRunStore.ts",
    "lib/promptRefinerShadowSystemAudit.ts",
    "prisma/migrations/20260920120000_prompt_refiner_shadow_run_writer/migration.sql",
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
 * synthetic corpus. The durable writer and preview are ready, while the false
 * entry-point and execution-admission values remain part of the digest:
 * shipping storage must not turn the deployed stage into an executable run.
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
    }),
    shadowAdapterImplemented: true,
    durableRunWriterReady: true,
    runApprovalPreviewReady: true,
    entryPointReady: false,
    executionAdmitted: false,
    productAdapterReady: false,
} as const);

const computedDigest = `sha256:${createHash("sha256")
    .update(canonicalJson(PROMPT_REFINER_SHADOW_RUN_CONTRACT), "utf8")
    .digest("hex")}`;

// Replaced with the computed literal before review. A mismatch fails import.
export const PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST =
    "sha256:a48ca37275c72f5a39d6029c9952d0ab4e35de7e55a4fd7086cb8a148eb6222a" as const;

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
        PROMPT_REFINER_SHADOW_CASE_IDS.length !==
            PROMPT_REFINER_SHADOW_CORPUS_CASES ||
        new Set(PROMPT_REFINER_SHADOW_CASE_IDS).size !==
            PROMPT_REFINER_SHADOW_CASE_IDS.length
    ) {
        problems.push("run_case_ids_mismatch");
    }
    if (PROMPT_REFINER_SHADOW_RUN_CONTRACT.executionAdmitted !== false) {
        problems.push("execution_must_remain_unadmitted");
    }
    if (PROMPT_REFINER_SHADOW_RUN_CONTRACT.entryPointReady !== false) {
        problems.push("entry_point_must_remain_unready");
    }
    if (PROMPT_REFINER_SHADOW_RUN_CONTRACT.durableRunWriterReady !== true) {
        problems.push("durable_writer_must_be_ready");
    }
    if (PROMPT_REFINER_SHADOW_RUN_CONTRACT.runApprovalPreviewReady !== true) {
        problems.push("run_preview_must_be_ready");
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
    adapterVersion: typeof PROMPT_REFINER_SHADOW_ADAPTER_VERSION;
    provider: typeof PROMPT_REFINER_EXECUTION_MODEL_PIN.provider;
    modelId: typeof PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId;
    apiModelId: typeof PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId;
    timeoutMs: typeof PROMPT_REFINER_TIMEOUT_MS;
    retryCount: typeof PROMPT_REFINER_RETRY_COUNT;
    maxDispatches: typeof PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES;
    perRequestCostMicroUsd: typeof PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD;
    costCeilingMicroUsd: typeof PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD;
    unknownOutcomePolicy: "stop_no_redispatch";
    executionAdmitted: false;
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
        adapterVersion: PROMPT_REFINER_SHADOW_ADAPTER_VERSION,
        provider: PROMPT_REFINER_EXECUTION_MODEL_PIN.provider,
        modelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId,
        apiModelId: PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId,
        timeoutMs: PROMPT_REFINER_TIMEOUT_MS,
        retryCount: PROMPT_REFINER_RETRY_COUNT,
        maxDispatches: PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES,
        perRequestCostMicroUsd:
            PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
        costCeilingMicroUsd:
            PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD,
        unknownOutcomePolicy: "stop_no_redispatch",
        executionAdmitted: false,
        productAdapterReady: false,
    });

export const promptRefinerShadowRunPreviewBindingDigest = (
    binding: PromptRefinerShadowRunPreviewBinding
): string => promptRefinerShadowRunDigest(binding);
