import {
    getModel,
    type AiModel,
} from "@/lib/models";
import {
    getModelPricingProfile,
    resolveModelPricing,
    type ModelPricingProfile,
} from "@/lib/modelPricing";
import { calculateProviderUsageCost } from "@/lib/providerUsageCost";
import type { PromptRefinerFailureCode } from "@/lib/promptRefinerReceiptCore";
import {
    PROMPT_REFINER_MAX_PROMPT_BYTES,
    PROMPT_REFINER_MAX_PROMPT_CHARS,
    PROMPT_REFINER_VERSION,
} from "@/lib/promptRefinerSuggestion";

/**
 * Provider-independent preregistration for the first Prompt Refiner shadow.
 *
 * This module cannot call a provider, select an adapter, read rollout state,
 * write a receipt, charge credits or authorize a run. It only freezes the
 * configuration a separately approved future harness must present before it
 * may dispatch. Product mode is deliberately absent.
 *
 * docs/ui-contracts/prompt-refiner-suggestion.md
 * docs/policy/prompt-refiner-observability.md
 */

export const PROMPT_REFINER_EXECUTION_CONTRACT_VERSION =
    "prompt-refiner-execution-contract-v1" as const;

export const PROMPT_REFINER_EXECUTION_MODEL_PIN = Object.freeze({
    provider: "openai",
    /** Stable Tomverse catalogue identity recorded in internal receipts. */
    modelId: "gpt-5-6-luna",
    /** Exact upstream identifier. A catalogue remap requires a new contract. */
    apiModelId: "gpt-5.6-luna",
    pricingVersion: "openai-gpt-5.6-luna-2026-08-01",
    pricingEffectiveDate: "2026-08-01",
    routing: "direct_provider_api",
    processingTier: "standard",
    reasoningEffort: "medium",
    contextWindowTokens: 1_050_000,
    reasoningTokenBilling: "billed_as_output",
    inputUsdPerMillionTokens: 0.2,
    outputUsdPerMillionTokens: 1.2,
} as const);

/**
 * Worst-case rendered-input allowance.
 *
 * The public request accepts at most 16,000 UTF-16 code units and 32 KiB of
 * UTF-8 source. JSON escaping can expand one control character to six ASCII
 * bytes, so the source alone can render to 96,000 bytes.
 *
 * Offline proof lemma: for the target OpenAI byte-level BPE family assumed by
 * this preregistration, every emitted token covers at least one UTF-8 byte, so
 * rendered content tokens are bounded above by rendered UTF-8 bytes. The
 * repository does not catalogue the exact upstream tokenizer, so this is a
 * conservative family-level proof assumption, not a claim about its merges or
 * a runtime tokenizer result. A future adapter must still identify/count with
 * its actual tokenizer and fail closed above this ceiling before any call.
 *
 * The framing allowance is an offline contract-proof constant for the fixed
 * system instruction, canonical JSON envelope and message framing. No runtime
 * adapter consumes it. Applying the lemma first and then adding that allowance
 * keeps the worst rendered request inside the 100,000-token priced tier.
 */
export const PROMPT_REFINER_MAX_INPUT_TOKENS = 100_000;
export const PROMPT_REFINER_MESSAGE_FRAMING_TOKEN_ALLOWANCE = 2_048;
export const PROMPT_REFINER_MAX_OUTPUT_TOKENS = 4_096;
export const PROMPT_REFINER_REQUIRED_CONTEXT_TOKENS =
    PROMPT_REFINER_MAX_INPUT_TOKENS + PROMPT_REFINER_MAX_OUTPUT_TOKENS;
export const PROMPT_REFINER_TIMEOUT_MS = 15_000;
export const PROMPT_REFINER_RETRY_COUNT = 0;
export const PROMPT_REFINER_SHADOW_MAX_DISPATCHES = 100;

export const promptRefinerWorstCaseCostMicroUsd = (input: {
    inputTokens: number;
    outputTokens?: number;
}): number =>
    calculateProviderUsageCost({
        inputTokens: input.inputTokens,
        outputTokens:
            input.outputTokens ?? PROMPT_REFINER_MAX_OUTPUT_TOKENS,
        inputUsdPerMillionTokens:
            PROMPT_REFINER_EXECUTION_MODEL_PIN.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens:
            PROMPT_REFINER_EXECUTION_MODEL_PIN.outputUsdPerMillionTokens,
        // The preregistration attaches no prompt cache. Costing the whole
        // prompt as uncached is both the requested path and the upper bound.
        cachedInputPriceMultiplier: 1,
    }).totalCostMicroUsd;

export const PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD =
    promptRefinerWorstCaseCostMicroUsd({
        inputTokens: PROMPT_REFINER_MAX_INPUT_TOKENS,
    });

export const PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD =
    PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD *
    PROMPT_REFINER_SHADOW_MAX_DISPATCHES;

export const PROMPT_REFINER_EXECUTION_CONTRACT = Object.freeze({
    contractVersion: PROMPT_REFINER_EXECUTION_CONTRACT_VERSION,
    refinerVersion: PROMPT_REFINER_VERSION,
    mode: "shadow" as const,
    userVisible: false,
    model: PROMPT_REFINER_EXECUTION_MODEL_PIN,
    request: Object.freeze({
        maxSourceChars: PROMPT_REFINER_MAX_PROMPT_CHARS,
        maxSourceBytes: PROMPT_REFINER_MAX_PROMPT_BYTES,
        maxInputTokens: PROMPT_REFINER_MAX_INPUT_TOKENS,
        maxOutputTokens: PROMPT_REFINER_MAX_OUTPUT_TOKENS,
        timeoutMs: PROMPT_REFINER_TIMEOUT_MS,
        retryCount: PROMPT_REFINER_RETRY_COUNT,
        promptCaching: "disabled" as const,
        tools: "none" as const,
        perRequestCostCeilingMicroUsd:
            PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD,
    }),
    stage: Object.freeze({
        maxDispatches: PROMPT_REFINER_SHADOW_MAX_DISPATCHES,
        costCeilingMicroUsd: PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD,
        requiresSeparateApproval: true,
        reservationAuthority: "unavailable" as const,
    }),
} as const);

type ContractModel = Pick<
    AiModel,
    | "id"
    | "apiModel"
    | "provider"
    | "enabled"
    | "status"
    | "reasoning"
    | "contextWindowTokens"
    | "usageClass"
    | "maxOutputTokens"
    | "reservationOutputTokens"
    | "inputUsdPerMillionTokens"
    | "outputUsdPerMillionTokens"
    | "cachedInputPriceMultiplier"
>;

/**
 * Compares the preregistration with the checked-in catalogue and price facts.
 * A drift is a refusal, not a request to silently inherit the new value.
 */
export const promptRefinerExecutionContractProblems = (input?: {
    model?: ContractModel | null;
    pricing?: ModelPricingProfile | null;
}): string[] => {
    const model =
        input && "model" in input
            ? input.model
            : getModel(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
    const pricing =
        input && "pricing" in input
            ? input.pricing
            : getModelPricingProfile(PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId);
    const problems: string[] = [];

    if (!model) {
        problems.push("model_missing");
    } else {
        if (model.id !== PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId) {
            problems.push("model_id_mismatch");
        }
        if (model.provider !== PROMPT_REFINER_EXECUTION_MODEL_PIN.provider) {
            problems.push("model_provider_mismatch");
        }
        if (model.apiModel !== PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId) {
            problems.push("api_model_mismatch");
        }
        if (model.reasoning !== PROMPT_REFINER_EXECUTION_MODEL_PIN.reasoningEffort) {
            problems.push("reasoning_effort_mismatch");
        }
        if (
            model.contextWindowTokens !==
            PROMPT_REFINER_EXECUTION_MODEL_PIN.contextWindowTokens
        ) {
            problems.push("context_window_mismatch");
        }
        if (
            (model.contextWindowTokens ?? 0) <
            PROMPT_REFINER_REQUIRED_CONTEXT_TOKENS
        ) {
            problems.push("context_window_insufficient");
        }
        if (!model.enabled || model.status !== "enabled") {
            problems.push("model_not_enabled");
        }

        // This is deliberately the same resolver used by reservation and cost
        // settlement paths. Static profile checks below are necessary but not
        // sufficient: DB/admin fields and per-model environment variables have
        // higher precedence and must not silently move the effective price or
        // make the frozen request output cap impossible.
        const effectivePricing = resolveModelPricing(model, {
            estimatedPromptTokens: PROMPT_REFINER_MAX_INPUT_TOKENS,
        });
        if (
            effectivePricing.inputUsdPerMillionTokens !==
            PROMPT_REFINER_EXECUTION_MODEL_PIN.inputUsdPerMillionTokens
        ) {
            problems.push("effective_input_price_mismatch");
        }
        if (
            effectivePricing.outputUsdPerMillionTokens !==
            PROMPT_REFINER_EXECUTION_MODEL_PIN.outputUsdPerMillionTokens
        ) {
            problems.push("effective_output_price_mismatch");
        }
        // The resolved cap is a product/provider capability, while this
        // contract requests exactly 4,096 tokens. A larger capability does not
        // change that request; a smaller or invalid one cannot honour it. The
        // future adapter must pass the contract cap, never substitute this
        // resolved maximum as the Refiner request cap.
        if (
            !Number.isSafeInteger(effectivePricing.maxOutputTokens) ||
            effectivePricing.maxOutputTokens < PROMPT_REFINER_MAX_OUTPUT_TOKENS
        ) {
            problems.push("effective_output_cap_below_contract");
        }
    }

    if (!pricing) {
        problems.push("pricing_missing");
    } else {
        if (pricing.modelId !== PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId) {
            problems.push("pricing_model_mismatch");
        }
        if (pricing.provider !== PROMPT_REFINER_EXECUTION_MODEL_PIN.provider) {
            problems.push("pricing_provider_mismatch");
        }
        if (pricing.apiModelId !== PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId) {
            problems.push("pricing_api_model_mismatch");
        }
        if (pricing.routing !== PROMPT_REFINER_EXECUTION_MODEL_PIN.routing) {
            problems.push("routing_mismatch");
        }
        if (
            pricing.processingTier !==
            PROMPT_REFINER_EXECUTION_MODEL_PIN.processingTier
        ) {
            problems.push("processing_tier_mismatch");
        }
        if (
            pricing.pricingVersion !==
            PROMPT_REFINER_EXECUTION_MODEL_PIN.pricingVersion
        ) {
            problems.push("pricing_version_mismatch");
        }
        if (
            pricing.effectiveDate !==
            PROMPT_REFINER_EXECUTION_MODEL_PIN.pricingEffectiveDate
        ) {
            problems.push("pricing_effective_date_mismatch");
        }
        if (pricing.priceSchedule?.length) {
            problems.push("pricing_schedule_requires_new_contract");
        }
        if (
            pricing.reasoningTokenBilling !==
            PROMPT_REFINER_EXECUTION_MODEL_PIN.reasoningTokenBilling
        ) {
            problems.push("reasoning_token_billing_mismatch");
        }
        const applicableTier = pricing.tiers.find(
            (tier) =>
                tier.maxPromptTokens === null ||
                PROMPT_REFINER_MAX_INPUT_TOKENS <= tier.maxPromptTokens
        );
        if (!applicableTier) {
            problems.push("pricing_tier_missing");
        } else {
            if (
                applicableTier.inputUsdPerMillionTokens !==
                PROMPT_REFINER_EXECUTION_MODEL_PIN.inputUsdPerMillionTokens
            ) {
                problems.push("input_price_mismatch");
            }
            if (
                applicableTier.outputUsdPerMillionTokens !==
                PROMPT_REFINER_EXECUTION_MODEL_PIN.outputUsdPerMillionTokens
            ) {
                problems.push("output_price_mismatch");
            }
        }
        if (pricing.maxOutputTokens < PROMPT_REFINER_MAX_OUTPUT_TOKENS) {
            problems.push("output_cap_exceeds_model_profile");
        }
    }

    if (
        promptRefinerWorstCaseCostMicroUsd({
            inputTokens: PROMPT_REFINER_MAX_INPUT_TOKENS,
        }) !== PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD
    ) {
        problems.push("request_cost_ceiling_mismatch");
    }
    if (
        PROMPT_REFINER_STAGE_COST_CEILING_MICRO_USD !==
        PROMPT_REFINER_PER_REQUEST_COST_CEILING_MICRO_USD *
            PROMPT_REFINER_SHADOW_MAX_DISPATCHES
    ) {
        problems.push("stage_cost_ceiling_mismatch");
    }

    return problems;
};

export const PROMPT_REFINER_ADMISSION_REFUSAL_REASONS = Object.freeze([
    "eligibility_refused",
    "execution_not_approved",
    "adapter_unavailable",
    "execution_contract_mismatch",
    "reservation_authority_unavailable",
] as const);
export type PromptRefinerAdmissionRefusalReason =
    (typeof PROMPT_REFINER_ADMISSION_REFUSAL_REASONS)[number];

export type PromptRefinerExecutionCandidate = {
    mode: "shadow" | "product" | null;
    /** Unknown is null and fails closed. */
    eligible: boolean | null;
    /** Separate human/cost approval; this contract is not that approval. */
    stageApproved: boolean | null;
    /** A real model-facing adapter exists for this exact candidate. */
    adapterReady: boolean | null;
    contractVersion: string | null;
    refinerVersion: string | null;
    model: {
        provider: string;
        modelId: string;
        apiModelId: string;
        pricingVersion: string;
        pricingEffectiveDate: string;
        routing: string;
        processingTier: string;
        reasoningEffort: string;
        contextWindowTokens: number;
        reasoningTokenBilling: string;
        inputUsdPerMillionTokens: number;
        outputUsdPerMillionTokens: number;
    } | null;
    maxOutputTokens: number | null;
    timeoutMs: number | null;
    retryCount: number | null;
    promptCaching: string | null;
    tools: string | null;
    /** Exact preregistered ceiling, not a caller-selected cost estimate. */
    inputTokenCeiling: number | null;
};

export type PromptRefinerAdmissionDecision = {
    admitted: false;
    reason: PromptRefinerAdmissionRefusalReason;
};

const exactModelPin = (
    candidate: PromptRefinerExecutionCandidate["model"]
): boolean => {
    if (!candidate) return false;
    return (
        candidate.provider === PROMPT_REFINER_EXECUTION_MODEL_PIN.provider &&
        candidate.modelId === PROMPT_REFINER_EXECUTION_MODEL_PIN.modelId &&
        candidate.apiModelId === PROMPT_REFINER_EXECUTION_MODEL_PIN.apiModelId &&
        candidate.pricingVersion ===
            PROMPT_REFINER_EXECUTION_MODEL_PIN.pricingVersion &&
        candidate.pricingEffectiveDate ===
            PROMPT_REFINER_EXECUTION_MODEL_PIN.pricingEffectiveDate &&
        candidate.routing === PROMPT_REFINER_EXECUTION_MODEL_PIN.routing &&
        candidate.processingTier ===
            PROMPT_REFINER_EXECUTION_MODEL_PIN.processingTier &&
        candidate.reasoningEffort ===
            PROMPT_REFINER_EXECUTION_MODEL_PIN.reasoningEffort &&
        candidate.contextWindowTokens ===
            PROMPT_REFINER_EXECUTION_MODEL_PIN.contextWindowTokens &&
        candidate.reasoningTokenBilling ===
            PROMPT_REFINER_EXECUTION_MODEL_PIN.reasoningTokenBilling &&
        candidate.inputUsdPerMillionTokens ===
            PROMPT_REFINER_EXECUTION_MODEL_PIN.inputUsdPerMillionTokens &&
        candidate.outputUsdPerMillionTokens ===
            PROMPT_REFINER_EXECUTION_MODEL_PIN.outputUsdPerMillionTokens
    );
};

/**
 * Pure fail-closed preregistration check. It reserves no money and dispatches
 * nothing. There is deliberately no admitted:true branch: a future authority
 * must atomically bind a request id, reserve one stage slot and worst-case
 * cost, attach expiry, and consume the lease once before a new contract may
 * expose successful admission.
 */
export const admitPromptRefinerExecution = (
    candidate: PromptRefinerExecutionCandidate
): PromptRefinerAdmissionDecision => {
    if (candidate.eligible !== true || candidate.mode !== "shadow") {
        return { admitted: false, reason: "eligibility_refused" };
    }
    if (candidate.stageApproved !== true) {
        return { admitted: false, reason: "execution_not_approved" };
    }
    if (candidate.adapterReady !== true) {
        return { admitted: false, reason: "adapter_unavailable" };
    }
    if (
        promptRefinerExecutionContractProblems().length > 0 ||
        candidate.contractVersion !==
            PROMPT_REFINER_EXECUTION_CONTRACT_VERSION ||
        candidate.refinerVersion !== PROMPT_REFINER_VERSION ||
        !exactModelPin(candidate.model) ||
        candidate.maxOutputTokens !== PROMPT_REFINER_MAX_OUTPUT_TOKENS ||
        candidate.timeoutMs !== PROMPT_REFINER_TIMEOUT_MS ||
        candidate.retryCount !== PROMPT_REFINER_RETRY_COUNT ||
        candidate.promptCaching !== "disabled" ||
        candidate.tools !== "none" ||
        candidate.inputTokenCeiling !== PROMPT_REFINER_MAX_INPUT_TOKENS
    ) {
        return {
            admitted: false,
            reason: "execution_contract_mismatch",
        };
    }
    return {
        admitted: false,
        reason: "reservation_authority_unavailable",
    };
};

export type PromptRefinerTerminalReason =
    | "suggested"
    | PromptRefinerAdmissionRefusalReason
    | "cancelled_before_dispatch"
    | "provider_error"
    | "timeout"
    | "invalid_response"
    | "empty_response"
    | "no_change"
    | "cancelled_after_dispatch"
    | "unknown_after_dispatch";

const PROMPT_REFINER_TERMINAL_REASON_COVERAGE = {
    suggested: true,
    eligibility_refused: true,
    execution_not_approved: true,
    execution_contract_mismatch: true,
    adapter_unavailable: true,
    reservation_authority_unavailable: true,
    cancelled_before_dispatch: true,
    provider_error: true,
    timeout: true,
    invalid_response: true,
    empty_response: true,
    no_change: true,
    cancelled_after_dispatch: true,
    unknown_after_dispatch: true,
} as const satisfies Record<PromptRefinerTerminalReason, true>;

export const PROMPT_REFINER_TERMINAL_REASONS = Object.freeze(
    Object.keys(
        PROMPT_REFINER_TERMINAL_REASON_COVERAGE
    ) as PromptRefinerTerminalReason[]
);

export type PromptRefinerTerminalDispositionPolicy =
    | "choice_or_stale_after_ready"
    | "stale_before_ready_only";

export type PromptRefinerTerminalReceiptFacts = {
    outcome: "suggested" | "failed" | "refused_before_dispatch";
    failureLayer:
        | "none"
        | "admission"
        | "adapter"
        | "provider"
        | "response_validation";
    failureCode: PromptRefinerFailureCode | null;
    retryCount: 0;
    dispositionPolicy: PromptRefinerTerminalDispositionPolicy;
};

const terminalFacts = (
    facts: Omit<PromptRefinerTerminalReceiptFacts, "retryCount">
): PromptRefinerTerminalReceiptFacts => ({
    ...facts,
    retryCount: PROMPT_REFINER_RETRY_COUNT,
});

/**
 * One terminal reason has one receipt encoding and one disposition boundary.
 * Provider prose and content never enter this mapping.
 */
export const promptRefinerTerminalReceiptFacts = (
    reason: PromptRefinerTerminalReason
): PromptRefinerTerminalReceiptFacts => {
    switch (reason) {
        case "suggested":
            return terminalFacts({
                outcome: "suggested",
                failureLayer: "none",
                failureCode: null,
                dispositionPolicy: "choice_or_stale_after_ready",
            });
        case "eligibility_refused":
        case "execution_not_approved":
        case "execution_contract_mismatch":
            return terminalFacts({
                outcome: "refused_before_dispatch",
                failureLayer: "admission",
                failureCode: reason,
                dispositionPolicy: "stale_before_ready_only",
            });
        case "adapter_unavailable":
            return terminalFacts({
                outcome: "refused_before_dispatch",
                failureLayer: "adapter",
                failureCode: "adapter_unavailable",
                dispositionPolicy: "stale_before_ready_only",
            });
        case "reservation_authority_unavailable":
            return terminalFacts({
                outcome: "refused_before_dispatch",
                failureLayer: "admission",
                failureCode: reason,
                dispositionPolicy: "stale_before_ready_only",
            });
        case "cancelled_before_dispatch":
            return terminalFacts({
                outcome: "refused_before_dispatch",
                failureLayer: "admission",
                failureCode: "cancelled",
                dispositionPolicy: "stale_before_ready_only",
            });
        case "provider_error":
        case "timeout":
        case "unknown_after_dispatch":
            return terminalFacts({
                outcome: "failed",
                failureLayer: "provider",
                failureCode: reason,
                dispositionPolicy: "stale_before_ready_only",
            });
        case "invalid_response":
        case "empty_response":
        case "no_change":
            return terminalFacts({
                outcome: "failed",
                failureLayer: "response_validation",
                failureCode: reason,
                dispositionPolicy: "stale_before_ready_only",
            });
        case "cancelled_after_dispatch":
            return terminalFacts({
                outcome: "failed",
                failureLayer: "provider",
                failureCode: "cancelled",
                dispositionPolicy: "stale_before_ready_only",
            });
    }
};
