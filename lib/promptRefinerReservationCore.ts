import { createHash } from "node:crypto";

import {
    PROMPT_REFINER_EXECUTION_CONTRACT,
    PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
    PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
    PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
    PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
} from "@/lib/promptRefinerExecutionContract";

/**
 * Content-free, provider-free authority contract for the first Refiner shadow.
 * This module decides shapes and state only; it does not read or write a DB.
 */
export const PROMPT_REFINER_RESERVATION_AUTHORITY_VERSION =
    "prompt-refiner-reservation-authority-v1" as const;
export const PROMPT_REFINER_RESERVATION_STAGE_ID =
    "prompt-refiner-shadow-v1" as const;
export const PROMPT_REFINER_RESERVATION_TTL_MS = 5 * 60 * 1_000;

export const PROMPT_REFINER_RESERVATION_STAGE_STATUSES = Object.freeze([
    "approved",
    "closed",
] as const);
export type PromptRefinerReservationStageStatus =
    (typeof PROMPT_REFINER_RESERVATION_STAGE_STATUSES)[number];

export const PROMPT_REFINER_RESERVATION_STATUSES = Object.freeze([
    "reserved",
    "consumed",
    "released",
    "expired",
] as const);
export type PromptRefinerReservationStatus =
    (typeof PROMPT_REFINER_RESERVATION_STATUSES)[number];

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

export const PROMPT_REFINER_RESERVATION_CONTRACT = Object.freeze({
    authorityVersion: PROMPT_REFINER_RESERVATION_AUTHORITY_VERSION,
    executionContract: PROMPT_REFINER_EXECUTION_CONTRACT,
    stageId: PROMPT_REFINER_RESERVATION_STAGE_ID,
    perRequestCostMicroUsd:
        PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
    maxReservations: PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
    costCeilingMicroUsd: PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
    reservationTtlMs: PROMPT_REFINER_RESERVATION_TTL_MS,
    stageStates: PROMPT_REFINER_RESERVATION_STAGE_STATUSES,
    reservationStates: PROMPT_REFINER_RESERVATION_STATUSES,
} as const);

const computedReservationContractDigest = `sha256:${createHash("sha256")
    .update(canonicalJson(PROMPT_REFINER_RESERVATION_CONTRACT), "utf8")
    .digest("hex")}`;

export const PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST =
    "sha256:c5cc412eb47821d56f6eed2e837d11086a9ab744069715e90d33ea37a378d55f" as const;

if (computedReservationContractDigest !== PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST) {
    throw new Error("Prompt Refiner reservation contract digest drifted");
}

export const PROMPT_REFINER_RESERVATION_REFUSALS = Object.freeze([
    "invalid_binding",
    "stage_not_found",
    "stage_authorization_invalid",
    "stage_contract_mismatch",
    "runtime_contract_mismatch",
    "runtime_source_mismatch",
    "request_binding_mismatch",
    "request_already_terminal",
    "reservation_not_found",
    "reservation_not_active",
    "reservation_expired",
    "stage_capacity_exhausted",
] as const);
export type PromptRefinerReservationRefusal =
    (typeof PROMPT_REFINER_RESERVATION_REFUSALS)[number];

export type PromptRefinerReservationStageFacts = {
    id: string;
    contractVersion: string;
    contractDigest: string;
    status: string;
    perRequestCostMicroUsd: bigint;
    maxReservations: number;
    costCeilingMicroUsd: bigint;
    reservationCount: number;
    allocatedCostMicroUsd: bigint;
    approvedAt: Date;
    approvalExpiresAt: Date;
};

export const promptRefinerReservationStageProblems = (
    stage: PromptRefinerReservationStageFacts,
    options: { requireApproved?: boolean } = {}
): string[] => {
    const problems: string[] = [];
    if (stage.id !== PROMPT_REFINER_RESERVATION_STAGE_ID) problems.push("stage_id_mismatch");
    if (stage.contractVersion !== PROMPT_REFINER_EXECUTION_CONTRACT_VERSION) {
        problems.push("contract_version_mismatch");
    }
    if (stage.contractDigest !== PROMPT_REFINER_RESERVATION_CONTRACT_DIGEST) {
        problems.push("contract_digest_mismatch");
    }
    if (!(PROMPT_REFINER_RESERVATION_STAGE_STATUSES as readonly string[]).includes(stage.status)) {
        problems.push("stage_status_invalid");
    } else if (options.requireApproved !== false && stage.status !== "approved") {
        problems.push("stage_not_approved");
    }
    if (
        stage.perRequestCostMicroUsd !==
        BigInt(PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD)
    ) {
        problems.push("request_cost_mismatch");
    }
    if (stage.maxReservations !== PROMPT_REFINER_SHADOW_MAX_DISPATCHES) {
        problems.push("reservation_limit_mismatch");
    }
    if (
        stage.costCeilingMicroUsd !==
        BigInt(PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD)
    ) {
        problems.push("stage_cost_mismatch");
    }
    if (
        !Number.isSafeInteger(stage.reservationCount) ||
        stage.reservationCount < 0 ||
        stage.reservationCount > stage.maxReservations
    ) {
        problems.push("reservation_count_invalid");
    }
    if (
        stage.allocatedCostMicroUsd !==
        BigInt(stage.reservationCount) * stage.perRequestCostMicroUsd
    ) {
        problems.push("allocated_cost_invalid");
    }
    if (stage.allocatedCostMicroUsd > stage.costCeilingMicroUsd) {
        problems.push("stage_cost_exceeded");
    }
    if (
        stage.approvalExpiresAt.getTime() - stage.approvedAt.getTime() !==
        60 * 60 * 1_000
    ) {
        problems.push("approval_window_invalid");
    }
    return problems;
};

export const promptRefinerReservationIdentifiersAreValid = (input: {
    requestId: string;
    reservationId?: string;
}): boolean => {
    const bounded = (value: string, maximum: number) =>
        value.length >= 1 &&
        value.length <= maximum &&
        /^[A-Za-z0-9:_-]+$/.test(value);
    return (
        bounded(input.requestId, 128) &&
        (input.reservationId === undefined || bounded(input.reservationId, 128))
    );
};

export type PromptRefinerReservationBinding = {
    reservationId: string;
    requestId: string;
    stageId: string;
    contractDigest: string;
};

export const promptRefinerReservationBindingMatches = (
    expected: PromptRefinerReservationBinding,
    actual: PromptRefinerReservationBinding
): boolean =>
    expected.reservationId === actual.reservationId &&
    expected.requestId === actual.requestId &&
    expected.stageId === actual.stageId &&
    expected.contractDigest === actual.contractDigest;
