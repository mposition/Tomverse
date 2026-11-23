/** Cost observation for the existing optimizer. No reservations or settlement. */
import { calculateProviderUsageCost } from "@/lib/providerUsageCost";

export type OptimizerCallKind = "synthesize" | "generate" | "route" | "answer" | "judge";
type Usage = {
    inputTokens: number; outputTokens: number;
    /** Present only where the adapter reported a cache split (observeOptimizerUsageCost). */
    cachedInputTokens?: number; cacheWriteInputTokens?: number; reasoningTokens?: number;
};
type Prices = {
    inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number;
    cachedInputPriceMultiplier?: number; cacheWriteUsdPerMillionTokens?: number | null;
};
export type OptimizerCost =
    | { state: "known"; amountMicroUsd: number; usage?: Usage; prices?: Prices }
    | { state: "no_dispatch"; reason: "model_unavailable" | "unpriced" | "pre_dispatch_refusal" }
    | { state: "unknown"; dispatch: "dispatched" | "unknown"; reason: "missing_usage" | "invalid_usage" | "invalid_price" | "invalid_cost" | "unpriced_cache_write" | "exception" }
    /**
     * A call that ended in an exception (a timeout, a dropped connection, a
     * provider error) after it may have been sent, with no reported usage.
     * Counted at the most it could have cost -- every input byte as a token
     * and the whole output cap, at full price -- against the run, the caps
     * and the provider's bucket, so the run can go on without understating
     * spend. Never "known": the report shows it as an upper bound.
     */
    | { state: "bounded"; amountMicroUsd: number; reason: "exception"; bound: { inputTokens: number; outputTokens: number; prices: Prices } };
/**
 * Which evaluation call this was, so a report can attribute spend to a case,
 * a model and an arm. Ids and roles only, never message or answer text.
 */
export type OptimizerCallIdentity = {
    objective?: string;
    caseId?: string;
    modelId?: string;
    /** baseline_guidance / candidate_guidance for routes; incumbent / challenger / candidate_pick for answers; direct / replay for judges. */
    arm?: string;
    /** 1-based try of the same answer; a retry is a second spend, never a free one. */
    attempt?: number;
};
export type OptimizerCallResult<T> = {
    value: T | null;
    /** Known subtotal only. Null always means unknown, never free. */
    costMicroUsd: number | null;
    provider: string;
    cost: OptimizerCost;
};
export type OptimizerCostCoverage = {
    version: "optimizer-cost-v1";
    basis: "reported_usage_configured_prices";
    complete: boolean;
    /** Spend from reported usage only. */
    knownMicroUsd: number;
    /** Upper bounds counted for calls that ended in an exception (state "bounded"); absent on older records. */
    boundedMicroUsd?: number;
    started: number;
    completed: number;
    notStarted: number;
    failed: number;
    knownCalls: number;
    noDispatchCalls: number;
    unknownCalls: number;
    /** Absent on older records, which had none. */
    boundedCalls?: number;
    usagePricedCalls: number;
    calls: ({ kind: OptimizerCallKind; provider: string; failed: boolean; identity?: OptimizerCallIdentity } & OptimizerCost)[];
};

const valid = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export const observeOptimizerCost = (
    usage: { inputTokens?: number; outputTokens?: number } | undefined,
    prices: Prices
): OptimizerCost => {
    if (!valid(prices.inputUsdPerMillionTokens) || !valid(prices.outputUsdPerMillionTokens))
        return { state: "unknown", dispatch: "dispatched", reason: "invalid_price" };
    if (usage?.inputTokens === undefined || usage.outputTokens === undefined)
        return { state: "unknown", dispatch: "dispatched", reason: "missing_usage" };
    if (!valid(usage.inputTokens) || !valid(usage.outputTokens))
        return { state: "unknown", dispatch: "dispatched", reason: "invalid_usage" };
    const amountMicroUsd = Math.ceil(usage.inputTokens * prices.inputUsdPerMillionTokens + usage.outputTokens * prices.outputUsdPerMillionTokens);
    return valid(amountMicroUsd)
        ? { state: "known", amountMicroUsd, usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
            prices: { inputUsdPerMillionTokens: prices.inputUsdPerMillionTokens, outputUsdPerMillionTokens: prices.outputUsdPerMillionTokens } }
        : { state: "unknown", dispatch: "dispatched", reason: "invalid_cost" };
};

/**
 * The same observation priced by the existing provider-cost helper, with the
 * cache-read and cache-write lines the adapter reported. Reasoning tokens are
 * already inside `outputTokens` (AI SDK usage) and are kept for the record
 * only. A cache write with no verified rate is understated by a known token
 * count, so the cost is unknown rather than a silent discount.
 */
export const observeOptimizerUsageCost = (
    usage: {
        inputTokens?: number; outputTokens?: number;
        inputTokenDetails?: { cacheReadTokens?: number; cacheWriteTokens?: number };
        outputTokenDetails?: { reasoningTokens?: number };
    } | undefined,
    prices: Prices
): OptimizerCost => {
    const plain = observeOptimizerCost(usage, prices);
    if (plain.state !== "known" || !usage) return plain;
    const cached = usage.inputTokenDetails?.cacheReadTokens;
    const written = usage.inputTokenDetails?.cacheWriteTokens;
    const reasoning = usage.outputTokenDetails?.reasoningTokens;
    if ([cached, written, reasoning].some(value => value !== undefined && !valid(value)))
        return { state: "unknown", dispatch: "dispatched", reason: "invalid_usage" };
    const breakdown = calculateProviderUsageCost({
        inputTokens: usage.inputTokens!, cachedInputTokens: cached, cacheWriteInputTokens: written,
        outputTokens: usage.outputTokens!,
        inputUsdPerMillionTokens: prices.inputUsdPerMillionTokens, outputUsdPerMillionTokens: prices.outputUsdPerMillionTokens,
        cachedInputPriceMultiplier: prices.cachedInputPriceMultiplier,
        cacheWriteUsdPerMillionTokens: prices.cacheWriteUsdPerMillionTokens ?? null,
    });
    if (breakdown.unpricedCacheWriteTokens > 0) return { state: "unknown", dispatch: "dispatched", reason: "unpriced_cache_write" };
    if (!valid(breakdown.totalCostMicroUsd)) return { state: "unknown", dispatch: "dispatched", reason: "invalid_cost" };
    return {
        state: "known", amountMicroUsd: breakdown.totalCostMicroUsd,
        usage: {
            inputTokens: breakdown.inputTokens, outputTokens: breakdown.outputTokens,
            cachedInputTokens: breakdown.cachedInputTokens, cacheWriteInputTokens: breakdown.cacheWriteInputTokens,
            ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
        },
        prices: {
            inputUsdPerMillionTokens: breakdown.inputUsdPerMillionTokens, outputUsdPerMillionTokens: breakdown.outputUsdPerMillionTokens,
            cachedInputPriceMultiplier: breakdown.cachedInputPriceMultiplier, cacheWriteUsdPerMillionTokens: breakdown.cacheWriteUsdPerMillionTokens,
        },
    };
};

/**
 * The most a call could have cost: input and output token counts that cannot
 * be exceeded, at full (uncached) price. Unknown when a price is invalid.
 */
export const optimizerBoundedCost = (bound: { inputTokens: number; outputTokens: number; prices: Prices }): OptimizerCost => {
    const { inputTokens, outputTokens, prices } = bound;
    if (![inputTokens, outputTokens, prices.inputUsdPerMillionTokens, prices.outputUsdPerMillionTokens].every(valid))
        return { state: "unknown", dispatch: "unknown", reason: "exception" };
    const amountMicroUsd = Math.ceil(inputTokens * prices.inputUsdPerMillionTokens + outputTokens * prices.outputUsdPerMillionTokens);
    return valid(amountMicroUsd)
        ? { state: "bounded", amountMicroUsd, reason: "exception",
            bound: { inputTokens, outputTokens, prices: { inputUsdPerMillionTokens: prices.inputUsdPerMillionTokens, outputUsdPerMillionTokens: prices.outputUsdPerMillionTokens } } }
        : { state: "unknown", dispatch: "unknown", reason: "exception" };
};

export const optimizerCostFields = (cost: OptimizerCost) => ({
    cost, costMicroUsd: cost.state === "known" ? cost.amountMicroUsd : cost.state === "no_dispatch" ? 0 : null,
});

const zeroByKind = (): Record<OptimizerCallKind, number> => ({ synthesize: 0, generate: 0, route: 0, answer: 0, judge: 0 });

/**
 * Existing actual-spend admission; unknown stops new calls and drains
 * in-flight work. A bounded call counts at its upper bound toward the budget,
 * the kind and the provider, and does not stop the run.
 */
export const optimizerSpend = (budgetMicroUsd: number) => {
    let spent = 0;
    let known = 0;
    let bounded = 0;
    let closedReason: "budget_exhausted" | "cost_unknown" | null = null;
    const spentByKind = zeroByKind(), failedByKind = zeroByKind();
    const spentByProvider = new Map<string, number>();
    const coverage: OptimizerCostCoverage = {
        version: "optimizer-cost-v1", basis: "reported_usage_configured_prices", complete: true,
        knownMicroUsd: 0, boundedMicroUsd: 0, started: 0, completed: 0, notStarted: 0, failed: 0,
        knownCalls: 0, noDispatchCalls: 0, unknownCalls: 0, boundedCalls: 0, usagePricedCalls: 0, calls: [],
    };
    const call = async <T>(
        kind: OptimizerCallKind,
        run: () => Promise<OptimizerCallResult<T>>,
        meta?: {
            identity?: OptimizerCallIdentity;
            /** Told what this started call cost, known or not, once it has ended. */
            observe?: (entry: { cost: OptimizerCost; failed: boolean }) => void;
        }
    ): Promise<T | null> => {
        if (closedReason || spent >= budgetMicroUsd) {
            closedReason ??= "budget_exhausted";
            coverage.notStarted += 1;
            return null;
        }
        coverage.started += 1;
        let cost: OptimizerCost = { state: "unknown", dispatch: "unknown", reason: "exception" };
        let provider = "unknown", failed = false;
        try {
            const result = await run();
            provider = result.provider;
            // Numeric-only injected adapters predate observation metadata.
            // Production adapters must supply `cost`; promotion also requires
            // usage/price coverage for every known call.
            cost = result.cost ?? (valid(result.costMicroUsd)
                ? { state: "known", amountMicroUsd: Math.ceil(result.costMicroUsd) }
                : { state: "unknown", dispatch: "unknown", reason: "invalid_cost" });
            if ((cost.state === "known" || cost.state === "bounded") && !valid(cost.amountMicroUsd))
                cost = { state: "unknown", dispatch: "unknown", reason: "invalid_cost" };
            failed = result.value === null;
            return result.value;
        } catch {
            failed = true;
            failedByKind[kind] += 1;
            return null;
        } finally {
            coverage.completed += 1;
            if (failed) coverage.failed += 1;
            // A bounded call is an adapter's caught exception: a failed call of its kind, like a thrown one.
            if (cost.state === "bounded" && failed) failedByKind[kind] += 1;
            coverage.calls.push({ kind, provider, failed, ...(meta?.identity ? { identity: meta.identity } : {}), ...cost });
            meta?.observe?.({ cost, failed });
            if (cost.state === "unknown") {
                coverage.unknownCalls += 1;
                coverage.complete = false;
                closedReason = "cost_unknown";
            } else if (cost.state === "no_dispatch") coverage.noDispatchCalls += 1;
            else {
                if (cost.state === "bounded") {
                    coverage.boundedCalls = (coverage.boundedCalls ?? 0) + 1;
                    bounded += cost.amountMicroUsd;
                } else {
                    coverage.knownCalls += 1;
                    if (cost.usage && cost.prices) coverage.usagePricedCalls += 1;
                    known += cost.amountMicroUsd;
                }
                spent += cost.amountMicroUsd;
                spentByKind[kind] += cost.amountMicroUsd;
                if (cost.amountMicroUsd > 0) spentByProvider.set(provider, (spentByProvider.get(provider) ?? 0) + cost.amountMicroUsd);
            }
            coverage.knownMicroUsd = known;
            coverage.boundedMicroUsd = bounded;
        }
    };
    return {
        call,
        exhausted: () => closedReason !== null,
        closedReason: () => closedReason,
        totals: () => ({
            spentMicroUsd: spent, spentByKind: { ...spentByKind }, spentByProvider: new Map(spentByProvider) as ReadonlyMap<string, number>,
            failedCalls: Object.values(failedByKind).reduce((sum, count) => sum + count, 0), failedByKind: { ...failedByKind },
            costCoverage: { ...coverage, calls: [...coverage.calls] },
        }),
    };
};
