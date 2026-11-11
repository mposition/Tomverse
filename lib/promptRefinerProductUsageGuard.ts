/**
 * The product's billed-usage check: the vNext evaluation guard
 * (guardPromptRefinerVnextBilledUsage, frozen in the evaluation contract and its
 * source closure) applied to the product's own price pin. Same rules, same
 * 29,918 micro-USD ceiling; only the rates differ.
 *
 * Pure: no provider, database or route import.
 */
import { calculateProviderUsageCost } from "@/lib/providerUsageCost";
import {
    PROMPT_REFINER_PRODUCT_MAX_INPUT_TOKENS,
    PROMPT_REFINER_PRODUCT_MAX_OUTPUT_TOKENS,
    PROMPT_REFINER_PRODUCT_PRICE_PIN,
    PROMPT_REFINER_PRODUCT_REQUEST_CEILING_MICRO_USD,
} from "@/lib/promptRefinerProductPricePin";

export type PromptRefinerProductUsageGuardResult = Readonly<{
    complete: boolean;
    costUpperBoundMicroUsd: number | null;
    problems: readonly string[];
    reservationReleaseAuthorized: false;
}>;

const USAGE_FIELDS = [
    "inputTokens", "outputTokens", "cachedInputTokens",
    "cacheWriteInputTokens", "reasoningTokens",
] as const;
const PRICE_FIELDS = Object.keys(PROMPT_REFINER_PRODUCT_PRICE_PIN);

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
export function guardPromptRefinerProductBilledUsage(input: {
    usage: unknown;
    effectivePricePin: unknown;
}): PromptRefinerProductUsageGuardResult {
    const problems: string[] = [];
    const usage = ownDataRecord(input.usage, USAGE_FIELDS);
    const price = ownDataRecord(input.effectivePricePin, PRICE_FIELDS);
    if (!usage) problems.push("usage_shape_invalid");
    if (!price || PRICE_FIELDS.some((field) =>
        price[field] !== PROMPT_REFINER_PRODUCT_PRICE_PIN[field as keyof typeof PROMPT_REFINER_PRODUCT_PRICE_PIN]
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
            usage.inputTokens > PROMPT_REFINER_PRODUCT_MAX_INPUT_TOKENS) {
            problems.push("inputTokens_above_cap");
        }
        if (nonnegativeCount(usage.outputTokens) &&
            usage.outputTokens > PROMPT_REFINER_PRODUCT_MAX_OUTPUT_TOKENS) {
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
        inputUsdPerMillionTokens: PROMPT_REFINER_PRODUCT_PRICE_PIN.inputUsdPerMillionTokens,
        cachedInputPriceMultiplier: PROMPT_REFINER_PRODUCT_PRICE_PIN.cachedInputPriceMultiplier,
        cacheWriteUsdPerMillionTokens: PROMPT_REFINER_PRODUCT_PRICE_PIN.cacheWriteUsdPerMillionTokens,
        outputUsdPerMillionTokens: PROMPT_REFINER_PRODUCT_PRICE_PIN.outputUsdPerMillionTokens,
    });
    if (breakdown.unpricedCacheWriteTokens !== 0 ||
        breakdown.uncachedInputTokens + breakdown.cachedInputTokens +
            breakdown.cacheWriteInputTokens !== usage.inputTokens ||
        breakdown.totalCostMicroUsd > PROMPT_REFINER_PRODUCT_REQUEST_CEILING_MICRO_USD) {
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
