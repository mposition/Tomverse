import { createHash } from "node:crypto";

import {
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
    PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST,
} from "@/lib/promptRefinerShadowAdmissionCore";
import {
    PROMPT_REFINER_SHADOW_CORPUS_CASES,
    PROMPT_REFINER_SHADOW_CORPUS_ID,
    PROMPT_REFINER_SHADOW_CORPUS_VERSION,
} from "@/lib/promptRefinerShadowHarness";

export const PROMPT_REFINER_SHADOW_RUN_CONTRACT_VERSION =
    "prompt-refiner-shadow-run-v1" as const;
export const PROMPT_REFINER_SHADOW_ADAPTER_VERSION =
    "prompt-refiner-openai-sdk-adapter-v1" as const;
export const PROMPT_REFINER_SHADOW_CORPUS_DIGEST =
    PROMPT_REFINER_SHADOW_ADMISSION_CORPUS_DIGEST;
export const PROMPT_REFINER_SHADOW_BYTE_PREFILTER_FRAMING_ALLOWANCE = 32 as const;
export const PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES =
    PROMPT_REFINER_SHADOW_CORPUS_CASES;
export const PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD =
    PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD *
    PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES;

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
 * synthetic corpus. The false readiness values are part of the digest: merely
 * shipping the adapter must not turn the deployed stage into an executable
 * run.
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
        maxDispatches: PROMPT_REFINER_SHADOW_RUN_MAX_DISPATCHES,
        costCeilingMicroUsd:
            PROMPT_REFINER_SHADOW_RUN_COST_CEILING_MICRO_USD,
        requiresExplicitCostApproval: true,
        unknownOutcomePolicy: "stop_no_redispatch" as const,
    }),
    shadowAdapterImplemented: true,
    durableRunWriterReady: false,
    entryPointReady: false,
    executionAdmitted: false,
    productAdapterReady: false,
} as const);

const computedDigest = `sha256:${createHash("sha256")
    .update(canonicalJson(PROMPT_REFINER_SHADOW_RUN_CONTRACT), "utf8")
    .digest("hex")}`;

// Replaced with the computed literal before review. A mismatch fails import.
export const PROMPT_REFINER_SHADOW_RUN_CONTRACT_DIGEST =
    "sha256:50a77992458e4fbdc3bf0325ec2df93feabe894b02eb242438cc036120e067dd" as const;

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
    if (PROMPT_REFINER_SHADOW_RUN_CONTRACT.executionAdmitted !== false) {
        problems.push("execution_must_remain_unadmitted");
    }
    if (PROMPT_REFINER_SHADOW_RUN_CONTRACT.entryPointReady !== false) {
        problems.push("entry_point_must_remain_unready");
    }
    if (PROMPT_REFINER_SHADOW_RUN_CONTRACT.durableRunWriterReady !== false) {
        problems.push("durable_writer_must_remain_unready");
    }
    return problems;
};
