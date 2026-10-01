/**
 * Offline vNext execution proposal. This module has no provider, database,
 * route, approval writer, or product import. In particular, validating a usage
 * object never consumes or releases a durable reservation.
 */
import { calculateProviderUsageCost } from "./providerUsageCost";

export const PROMPT_REFINER_VNEXT_EXECUTION_VERSION =
    "prompt-refiner-vnext-execution-contract-v1" as const;
export const PROMPT_REFINER_VNEXT_SLOT_COUNT = 80 as const;
export const PROMPT_REFINER_VNEXT_MAX_INPUT_TOKENS = 100_000 as const;
export const PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS = 4_096 as const;
export const PROMPT_REFINER_VNEXT_TIMEOUT_MS = 15_000 as const;
export const PROMPT_REFINER_VNEXT_RETRY_COUNT = 0 as const;
export const PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD = 29_918 as const;
export const PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD = 2_393_440 as const;

// Approved design snapshot only. A future server-owned admission must compare
// the current catalogue/official rate and provider usage contract before paid
// dispatch; this offline module does not claim current-price compatibility.
export const PROMPT_REFINER_VNEXT_PRICE_PIN = Object.freeze({
    provider: "openai",
    modelId: "gpt-5-6-luna",
    apiModelId: "gpt-5.6-luna",
    routing: "direct_provider_api",
    processingTier: "standard",
    inputUsdPerMillionTokens: 0.2,
    cachedInputPriceMultiplier: 0.1,
    cacheWriteUsdPerMillionTokens: 0.25,
    outputUsdPerMillionTokens: 1.2,
} as const);

export const PROMPT_REFINER_VNEXT_EXECUTION_CONTRACT = Object.freeze({
    version: PROMPT_REFINER_VNEXT_EXECUTION_VERSION,
    numericSpecSha256:
        "a1ebccdbbe10c02725d73686235f379f51abd38f5cf8a6acd9e3ba294edbbfea",
    mode: "staging_shadow",
    slotCount: PROMPT_REFINER_VNEXT_SLOT_COUNT,
    stageCapacity: PROMPT_REFINER_VNEXT_SLOT_COUNT,
    maxInputTokens: PROMPT_REFINER_VNEXT_MAX_INPUT_TOKENS,
    maxOutputTokens: PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS,
    timeoutMs: PROMPT_REFINER_VNEXT_TIMEOUT_MS,
    retryCount: PROMPT_REFINER_VNEXT_RETRY_COUNT,
    perRequestCeilingMicroUsd: PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
    // Both authorise the same 80 slots. They are nested limits, not additive spend.
    stageCeilingMicroUsd: PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD,
    runCeilingMicroUsd: PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD,
    pricePin: PROMPT_REFINER_VNEXT_PRICE_PIN,
    manifestRootRequired: true,
    sourceClosureRequired: true,
    exactDeploymentRequired: true,
    explicitCacheWriteCountRequired: true,
    durableReservationAuthority: "unavailable",
    executionAdmitted: false,
    productAdapterReady: false,
} as const);

export type PromptRefinerVnextUsageGuardResult = Readonly<{
    complete: boolean;
    costUpperBoundMicroUsd: number | null;
    problems: readonly string[];
    /** A future DB writer must separately verify/consume the exact authority. */
    reservationReleaseAuthorized: false;
}>;

const USAGE_FIELDS = [
    "inputTokens", "outputTokens", "cachedInputTokens",
    "cacheWriteInputTokens", "reasoningTokens",
] as const;
const PRICE_FIELDS = Object.keys(PROMPT_REFINER_VNEXT_PRICE_PIN);

function ownDataRecord(value: unknown, fields: readonly string[]): Record<string, unknown> | null {
    try {
        if (value === null || typeof value !== "object" || Array.isArray(value) ||
            Object.getPrototypeOf(value) !== Object.prototype) return null;
        const keys = Reflect.ownKeys(value);
        if (keys.length !== fields.length || fields.some((field) => !keys.includes(field))) {
            return null;
        }
        const result: Record<string, unknown> = Object.create(null);
        for (const field of fields) {
            const descriptor = Object.getOwnPropertyDescriptor(value, field);
            if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
            result[field] = descriptor.value;
        }
        return result;
    } catch {
        return null;
    }
}

const nonnegativeCount = (value: unknown): value is number =>
    Number.isSafeInteger(value) && (value as number) >= 0;

/**
 * Checks a normalized provider usage observation against the frozen price pin.
 * `null` or an omitted cache-write count is never interpreted as zero. The
 * generic calculator clamps malformed buckets, so this guard rejects them
 * before calling it. A successful result is still only offline cost evidence.
 */
export function guardPromptRefinerVnextBilledUsage(input: {
    usage: unknown;
    effectivePricePin: unknown;
}): PromptRefinerVnextUsageGuardResult {
    const problems: string[] = [];
    const usage = ownDataRecord(input.usage, USAGE_FIELDS);
    const price = ownDataRecord(input.effectivePricePin, PRICE_FIELDS);
    if (!usage) problems.push("usage_shape_invalid");
    if (!price || PRICE_FIELDS.some((field) =>
        price[field] !== PROMPT_REFINER_VNEXT_PRICE_PIN[field as keyof typeof PROMPT_REFINER_VNEXT_PRICE_PIN]
    )) problems.push("price_pin_mismatch");
    if (usage) {
        for (const field of USAGE_FIELDS.slice(0, 4)) {
            if (!nonnegativeCount(usage[field])) problems.push(`${field}_missing_or_invalid`);
        }
        // Billed outputTokens already include reasoning under this frozen
        // design. A missing optional breakdown therefore does not lower this
        // conservative cost (unlike the historical v1 adapter's stricter
        // telemetry-completeness rule). The total output count is mandatory.
        if (usage.reasoningTokens !== null && usage.reasoningTokens !== undefined &&
            !nonnegativeCount(usage.reasoningTokens)) {
            problems.push("reasoningTokens_invalid");
        }
        if (nonnegativeCount(usage.inputTokens) && usage.inputTokens === 0) {
            problems.push("inputTokens_empty");
        }
        if (nonnegativeCount(usage.inputTokens) &&
            usage.inputTokens > PROMPT_REFINER_VNEXT_MAX_INPUT_TOKENS) {
            problems.push("inputTokens_above_cap");
        }
        if (nonnegativeCount(usage.outputTokens) &&
            usage.outputTokens > PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS) {
            problems.push("outputTokens_above_cap");
        }
        if (nonnegativeCount(usage.inputTokens) &&
            nonnegativeCount(usage.cachedInputTokens) &&
            nonnegativeCount(usage.cacheWriteInputTokens) &&
            usage.cachedInputTokens + usage.cacheWriteInputTokens > usage.inputTokens) {
            problems.push("input_buckets_exceed_total");
        }
        if (nonnegativeCount(usage.outputTokens) &&
            nonnegativeCount(usage.reasoningTokens) &&
            usage.reasoningTokens > usage.outputTokens) {
            problems.push("reasoning_exceeds_output");
        }
    }
    if (problems.length > 0 || !usage) {
        return Object.freeze({
            complete: false,
            costUpperBoundMicroUsd: null,
            problems: Object.freeze(problems),
            reservationReleaseAuthorized: false,
        });
    }
    const breakdown = calculateProviderUsageCost({
        inputTokens: usage.inputTokens as number,
        cachedInputTokens: usage.cachedInputTokens as number,
        cacheWriteInputTokens: usage.cacheWriteInputTokens as number,
        outputTokens: usage.outputTokens as number,
        inputUsdPerMillionTokens: PROMPT_REFINER_VNEXT_PRICE_PIN.inputUsdPerMillionTokens,
        cachedInputPriceMultiplier: PROMPT_REFINER_VNEXT_PRICE_PIN.cachedInputPriceMultiplier,
        cacheWriteUsdPerMillionTokens: PROMPT_REFINER_VNEXT_PRICE_PIN.cacheWriteUsdPerMillionTokens,
        outputUsdPerMillionTokens: PROMPT_REFINER_VNEXT_PRICE_PIN.outputUsdPerMillionTokens,
    });
    if (breakdown.unpricedCacheWriteTokens !== 0 ||
        breakdown.uncachedInputTokens + breakdown.cachedInputTokens +
            breakdown.cacheWriteInputTokens !== usage.inputTokens ||
        breakdown.totalCostMicroUsd > PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD) {
        return Object.freeze({
            complete: false,
            costUpperBoundMicroUsd: null,
            problems: Object.freeze(["cost_reconciliation_invalid"]),
            reservationReleaseAuthorized: false,
        });
    }
    return Object.freeze({
        complete: true,
        costUpperBoundMicroUsd: breakdown.totalCostMicroUsd,
        problems: Object.freeze([]),
        reservationReleaseAuthorized: false,
    });
}

/** Static arithmetic check only; not a runtime model-price or authority check. */
export function promptRefinerVnextExecutionContractProblems(): string[] {
    const worst = calculateProviderUsageCost({
        inputTokens: PROMPT_REFINER_VNEXT_MAX_INPUT_TOKENS,
        cachedInputTokens: 1,
        cacheWriteInputTokens: PROMPT_REFINER_VNEXT_MAX_INPUT_TOKENS - 2,
        outputTokens: PROMPT_REFINER_VNEXT_MAX_OUTPUT_TOKENS,
        inputUsdPerMillionTokens: PROMPT_REFINER_VNEXT_PRICE_PIN.inputUsdPerMillionTokens,
        cachedInputPriceMultiplier: PROMPT_REFINER_VNEXT_PRICE_PIN.cachedInputPriceMultiplier,
        cacheWriteUsdPerMillionTokens: PROMPT_REFINER_VNEXT_PRICE_PIN.cacheWriteUsdPerMillionTokens,
        outputUsdPerMillionTokens: PROMPT_REFINER_VNEXT_PRICE_PIN.outputUsdPerMillionTokens,
    });
    const problems: string[] = [];
    if (worst.totalCostMicroUsd !== PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD) {
        problems.push("request_ceiling_mismatch");
    }
    if (PROMPT_REFINER_VNEXT_SLOT_COUNT * PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD !==
        PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD) {
        problems.push("run_ceiling_mismatch");
    }
    if (PROMPT_REFINER_VNEXT_RETRY_COUNT !== 0) problems.push("retry_mismatch");
    return problems;
}
