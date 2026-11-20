/** Cost observation for the existing optimizer. No reservations or settlement. */
export type OptimizerCallKind = "synthesize" | "generate" | "route" | "answer" | "judge";
type Usage = { inputTokens: number; outputTokens: number };
type Prices = { inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number };
export type OptimizerCost =
    | { state: "known"; amountMicroUsd: number; usage?: Usage; prices?: Prices }
    | { state: "no_dispatch"; reason: "model_unavailable" | "unpriced" | "pre_dispatch_refusal" }
    | { state: "unknown"; dispatch: "dispatched" | "unknown"; reason: "missing_usage" | "invalid_usage" | "invalid_price" | "invalid_cost" | "exception" };
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
    knownMicroUsd: number;
    started: number;
    completed: number;
    notStarted: number;
    failed: number;
    knownCalls: number;
    noDispatchCalls: number;
    unknownCalls: number;
    usagePricedCalls: number;
    calls: ({ kind: OptimizerCallKind; provider: string; failed: boolean } & OptimizerCost)[];
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

export const optimizerCostFields = (cost: OptimizerCost) => ({
    cost, costMicroUsd: cost.state === "known" ? cost.amountMicroUsd : cost.state === "no_dispatch" ? 0 : null,
});

const zeroByKind = (): Record<OptimizerCallKind, number> => ({ synthesize: 0, generate: 0, route: 0, answer: 0, judge: 0 });

/** Existing actual-spend admission; unknown stops new calls and drains in-flight work. */
export const optimizerSpend = (budgetMicroUsd: number) => {
    let spent = 0;
    let closedReason: "budget_exhausted" | "cost_unknown" | null = null;
    const spentByKind = zeroByKind(), failedByKind = zeroByKind();
    const spentByProvider = new Map<string, number>();
    const coverage: OptimizerCostCoverage = {
        version: "optimizer-cost-v1", basis: "reported_usage_configured_prices", complete: true,
        knownMicroUsd: 0, started: 0, completed: 0, notStarted: 0, failed: 0,
        knownCalls: 0, noDispatchCalls: 0, unknownCalls: 0, usagePricedCalls: 0, calls: [],
    };
    const call = async <T>(kind: OptimizerCallKind, run: () => Promise<OptimizerCallResult<T>>): Promise<T | null> => {
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
            if (cost.state === "known" && !valid(cost.amountMicroUsd))
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
            coverage.calls.push({ kind, provider, failed, ...cost });
            if (cost.state === "unknown") {
                coverage.unknownCalls += 1;
                coverage.complete = false;
                closedReason = "cost_unknown";
            } else if (cost.state === "no_dispatch") coverage.noDispatchCalls += 1;
            else {
                coverage.knownCalls += 1;
                if (cost.usage && cost.prices) coverage.usagePricedCalls += 1;
                spent += cost.amountMicroUsd;
                spentByKind[kind] += cost.amountMicroUsd;
                if (cost.amountMicroUsd > 0) spentByProvider.set(provider, (spentByProvider.get(provider) ?? 0) + cost.amountMicroUsd);
            }
            coverage.knownMicroUsd = spent;
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
