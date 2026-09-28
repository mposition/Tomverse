/**
 * Admission, cost ceiling, and one provider attempt for one stored deployment.
 *
 * The ordinary chat handler is a different route. This module never calls it,
 * and a refusal here is not a signal to call it. The flag being off is the
 * only way back to that handler, and it applies to a later request: a hold
 * already taken stays taken when the flag changes.
 *
 * No dollar amount is declared here. A missing limit is not zero, and it is
 * not permission to call a provider.
 */

import {
    ACTIVE_ESTIMATOR_VERSION,
    createTokenEstimateAccumulator,
    toReservedInputTokens,
} from "@/lib/chatTokenEstimate";

export const PINNED_DEPLOYMENT_EXECUTION_ENV = "PINNED_DEPLOYMENT_EXECUTION";
export const PINNED_DEPLOYMENT_ACCOUNT_ENV = "PINNED_DEPLOYMENT_ACCOUNT_ID";
export const PINNED_DEPLOYMENT_ID_ENV = "PINNED_DEPLOYMENT_ID";
export const PINNED_DEPLOYMENT_EXPERIMENT_ENV = "PINNED_DEPLOYMENT_EXPERIMENT_ID";

/** The SDK retry count for this path. The ordinary chat path does not read it. */
export const PINNED_INFERENCE_MAX_RETRIES = 0;

export const PINNED_EXPERIMENT_HOLD_STATUSES = [
    "held",
    "settled",
    "released",
    "occupied",
] as const;

export type PinnedExperimentHoldStatus = (typeof PINNED_EXPERIMENT_HOLD_STATUSES)[number];

const named = (value: string | undefined): string | null =>
    typeof value === "string" && value.length > 0 && value === value.trim() ? value : null;

const safeNonNegative = (value: number): boolean =>
    Number.isSafeInteger(value) && value >= 0;

export type PinnedDeploymentConfig = {
    enabled: boolean;
    accountId: string | null;
    deploymentId: string | null;
    experimentId: string | null;
};

export const readPinnedDeploymentConfig = (env: {
    PINNED_DEPLOYMENT_EXECUTION?: string;
    PINNED_DEPLOYMENT_ACCOUNT_ID?: string;
    PINNED_DEPLOYMENT_ID?: string;
    PINNED_DEPLOYMENT_EXPERIMENT_ID?: string;
}): PinnedDeploymentConfig => ({
    enabled: env.PINNED_DEPLOYMENT_EXECUTION === "on",
    accountId: named(env.PINNED_DEPLOYMENT_ACCOUNT_ID),
    deploymentId: named(env.PINNED_DEPLOYMENT_ID),
    experimentId: named(env.PINNED_DEPLOYMENT_EXPERIMENT_ID),
});

/**
 * `existing` means the ordinary handler runs and this path does nothing.
 * `entered` means this path owns the request, including when it then refuses.
 */
export const classifyPinnedDeployment = (
    config: PinnedDeploymentConfig,
    authenticatedAccountId: string | null
): "existing" | "entered" => {
    if (!config.enabled || !config.accountId) return "existing";
    if (!authenticatedAccountId || authenticatedAccountId !== config.accountId) {
        return "existing";
    }
    return "entered";
};

export type PinnedInferenceArguments = {
    maxRetries: 0;
    maxOutputTokens: number;
};

export const pinnedInferenceArguments = (
    plan: { maxOutputTokens: number }
): PinnedInferenceArguments => ({
    maxRetries: PINNED_INFERENCE_MAX_RETRIES,
    maxOutputTokens: plan.maxOutputTokens,
});

export type PinnedMessage = {
    role: "system" | "user" | "assistant";
    text: string;
};

const TEXT_ROLES = new Set<PinnedMessage["role"]>(["system", "user", "assistant"]);

const readTextParts = (value: unknown): string | null => {
    if (!Array.isArray(value)) return null;
    const parts: string[] = [];
    for (const part of value) {
        if (!part || typeof part !== "object") return null;
        const record = part as { type?: unknown; text?: unknown };
        if (record.type !== "text" || typeof record.text !== "string") return null;
        parts.push(record.text);
    }
    return parts.join("");
};

const readPinnedMessage = (message: object): PinnedMessage | null => {
    const record = message as {
        role?: unknown;
        content?: unknown;
        parts?: unknown;
        attachments?: unknown;
    };
    if (record.attachments !== undefined) {
        if (!Array.isArray(record.attachments) || record.attachments.length > 0) return null;
    }
    if (typeof record.role !== "string" || !TEXT_ROLES.has(record.role as PinnedMessage["role"])) {
        return null;
    }
    if (record.content !== undefined && record.parts !== undefined) return null;
    const text = typeof record.content === "string"
        ? record.content
        : readTextParts(record.content ?? record.parts);
    if (text === null) return null;
    return { role: record.role as PinnedMessage["role"], text };
};

export const pinnedRequestHasUnpricedSideCost = (input: {
    webSearchMode?: string | null;
    deepResearchDepth?: unknown;
    messages: readonly object[];
}): boolean => {
    if (typeof input.webSearchMode === "string" && input.webSearchMode !== "off") return true;
    if (input.deepResearchDepth !== null && input.deepResearchDepth !== undefined) {
        if (typeof input.deepResearchDepth !== "string") return true;
        if (input.deepResearchDepth.trim().length > 0) return true;
    }
    return input.messages.some((message) => {
        if (!message || typeof message !== "object") return true;
        const attachments = (message as { attachments?: unknown }).attachments;
        return attachments !== undefined && (!Array.isArray(attachments) || attachments.length > 0);
    });
};

export type PinnedPriceRates = {
    costSource: string;
    reasoningTokenBilling: string;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    cacheWriteUsdPerMillionTokens: number | null;
    maxOutputTokens: number;
};

export type PinnedQuote = {
    messages: readonly PinnedMessage[];
    tokenizerVersion: string;
    estimatedInputTokens: number;
    reservedInputTokens: number;
    maxOutputTokens: number;
    contextWindowTokens: number;
    reservedMicroUsd: number;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    cacheWriteUsdPerMillionTokens: number;
};

const ceilMicroUsd = (tokens: number, usdPerMillionTokens: number): number | null => {
    if (!safeNonNegative(tokens) || !Number.isFinite(usdPerMillionTokens) || usdPerMillionTokens < 0) {
        return null;
    }
    const cost = Math.ceil(tokens * usdPerMillionTokens);
    return Number.isSafeInteger(cost) ? cost : null;
};

/**
 * Extra tokens a provider may add around each message. A BPE token is at
 * least one byte of the text itself, so the byte length plus this ceiling
 * is the input count the reservation prices. The point estimate is not
 * that count: dense text can be several tokens per few bytes, and a count
 * that sits just below a price-tier boundary would otherwise reserve the
 * cheaper rate for a prompt the provider can bill on the higher one.
 */
export const PINNED_MESSAGE_FRAMING_TOKEN_CEILING = 64;

export const pinnedBillablePromptCeiling = (
    messages: readonly object[]
): number | null => {
    let bytes = 0;
    let count = 0;
    for (const message of messages) {
        if (!message || typeof message !== "object") return null;
        const pinned = readPinnedMessage(message);
        if (!pinned) return null;
        const encoded = new TextEncoder().encode(pinned.text).length;
        if (!safeNonNegative(encoded)) return null;
        bytes += encoded;
        count += 1;
    }
    const ceiling = bytes + count * PINNED_MESSAGE_FRAMING_TOKEN_CEILING;
    return safeNonNegative(bytes) && safeNonNegative(ceiling) ? ceiling : null;
};

/** The input count the reservation prices: the byte ceiling, or the estimate when that is higher. */
export const pinnedReservedInputTokens = (
    messages: readonly object[]
): number | null => {
    const ceiling = pinnedBillablePromptCeiling(messages);
    if (ceiling === null) return null;
    const accumulator = createTokenEstimateAccumulator();
    for (const message of messages) {
        if (!message || typeof message !== "object") return null;
        const pinned = readPinnedMessage(message);
        if (!pinned) return null;
        accumulator.addText(pinned.text);
    }
    const estimated = toReservedInputTokens(accumulator.breakdown());
    const reserved = Math.max(estimated, ceiling);
    return safeNonNegative(estimated) && safeNonNegative(reserved) ? reserved : null;
};

/**
 * The most the provider can bill for this text at the approved rates.
 * The input count is the billable ceiling, not the point estimate.
 * Cache-write tokens are not known yet, so the reservation adds the write
 * premium on every one of those input tokens when a write rate exists. A
 * missing write rate is not zero: the cap is then not a cap, and the quote
 * fails. The rates must already be the tier that ceiling can reach.
 */
export const quotePinnedTextCost = (input: {
    messages: readonly object[];
    pricing: PinnedPriceRates | null;
    contextWindowTokens: number | null;
    billableInputTokens?: number;
}): { ok: true; quote: PinnedQuote } | { ok: false; reason: "unpriced" } => {
    const pricing = input.pricing;
    if (!pricing) return { ok: false, reason: "unpriced" };
    if (
        pricing.costSource.length === 0 ||
        pricing.costSource.startsWith("conservative_fallback") ||
        pricing.reasoningTokenBilling === "billed_separately"
    ) {
        return { ok: false, reason: "unpriced" };
    }
    const contextWindowTokens = input.contextWindowTokens;
    const cacheWriteUsdPerMillionTokens = pricing.cacheWriteUsdPerMillionTokens;
    if (
        contextWindowTokens === null ||
        !Number.isSafeInteger(contextWindowTokens) ||
        contextWindowTokens <= 0 ||
        !Number.isSafeInteger(pricing.maxOutputTokens) ||
        pricing.maxOutputTokens <= 0 ||
        cacheWriteUsdPerMillionTokens === null
    ) {
        return { ok: false, reason: "unpriced" };
    }

    const messages: PinnedMessage[] = [];
    for (const message of input.messages) {
        if (!message || typeof message !== "object") return { ok: false, reason: "unpriced" };
        const pinned = readPinnedMessage(message);
        if (!pinned) return { ok: false, reason: "unpriced" };
        messages.push(pinned);
    }

    const accumulator = createTokenEstimateAccumulator();
    for (const message of messages) accumulator.addText(message.text);
    const breakdown = accumulator.breakdown();
    const estimatedInputTokens = toReservedInputTokens(breakdown);
    const ceiling = pinnedBillablePromptCeiling(input.messages);
    const reservedInputTokens = ceiling === null
        ? null
        : Math.max(estimatedInputTokens, ceiling);
    if (
        reservedInputTokens === null ||
        !safeNonNegative(breakdown.rawTotal) ||
        !safeNonNegative(estimatedInputTokens) ||
        !safeNonNegative(reservedInputTokens) ||
        (
            input.billableInputTokens !== undefined &&
            input.billableInputTokens !== reservedInputTokens
        ) ||
        reservedInputTokens + pricing.maxOutputTokens > contextWindowTokens
    ) {
        return { ok: false, reason: "unpriced" };
    }

    const inputCost = ceilMicroUsd(reservedInputTokens, pricing.inputUsdPerMillionTokens);
    const outputCost = ceilMicroUsd(pricing.maxOutputTokens, pricing.outputUsdPerMillionTokens);
    const writePremium = ceilMicroUsd(
        reservedInputTokens,
        Math.max(0, cacheWriteUsdPerMillionTokens - pricing.inputUsdPerMillionTokens)
    );
    if (inputCost === null || outputCost === null || writePremium === null) {
        return { ok: false, reason: "unpriced" };
    }
    const reservedMicroUsd = inputCost + outputCost + writePremium;
    if (!safeNonNegative(reservedMicroUsd)) return { ok: false, reason: "unpriced" };

    return {
        ok: true,
        quote: {
            messages,
            tokenizerVersion: ACTIVE_ESTIMATOR_VERSION,
            estimatedInputTokens: breakdown.rawTotal,
            reservedInputTokens,
            maxOutputTokens: pricing.maxOutputTokens,
            contextWindowTokens,
            reservedMicroUsd,
            inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
            outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
            cacheWriteUsdPerMillionTokens,
        },
    };
};

/**
 * Reported usage is trustworthy only when input, output, and cache-write
 * counts are all present. `inputTokens` already includes write tokens, so
 * those are moved onto the write rate instead of being billed twice.
 * A missing count is not zero.
 */
export const settlePinnedUsageCost = (
    rates: {
        inputUsdPerMillionTokens: number;
        outputUsdPerMillionTokens: number;
        cacheWriteUsdPerMillionTokens: number | null;
    },
    usage: {
        inputTokens: number | undefined;
        outputTokens: number | undefined;
        cacheWriteTokens: number | undefined;
    }
): number | null => {
    if (rates.cacheWriteUsdPerMillionTokens === null) return null;
    const cacheWriteUsdPerMillionTokens = rates.cacheWriteUsdPerMillionTokens;
    if (
        !safeNonNegative(usage.inputTokens ?? -1) ||
        !safeNonNegative(usage.outputTokens ?? -1) ||
        !safeNonNegative(usage.cacheWriteTokens ?? -1)
    ) {
        return null;
    }
    const inputTokens = usage.inputTokens as number;
    const outputTokens = usage.outputTokens as number;
    const cacheWriteTokens = usage.cacheWriteTokens as number;
    if (cacheWriteTokens > inputTokens) return null;
    const ordinaryInput = ceilMicroUsd(inputTokens - cacheWriteTokens, rates.inputUsdPerMillionTokens);
    const write = ceilMicroUsd(cacheWriteTokens, cacheWriteUsdPerMillionTokens);
    const output = ceilMicroUsd(outputTokens, rates.outputUsdPerMillionTokens);
    if (ordinaryInput === null || write === null || output === null) return null;
    const total = ordinaryInput + write + output;
    return safeNonNegative(total) ? total : null;
};

export type ExperimentCounters = {
    spentMicroUsd: number;
    reservedMicroUsd: number;
    limitMicroUsd: number | null;
};

export const decideExperimentReserve = (input: {
    spentMicroUsd: number;
    reservedMicroUsd: number;
    incomingMicroUsd: number;
    limitMicroUsd: number | null;
}): { ok: true } | { ok: false; reason: "no_limit" | "unpriced" | "over_limit" } => {
    if (
        input.limitMicroUsd === null ||
        !Number.isSafeInteger(input.limitMicroUsd) ||
        input.limitMicroUsd <= 0
    ) {
        return { ok: false, reason: "no_limit" };
    }
    if (!safeNonNegative(input.incomingMicroUsd)) return { ok: false, reason: "unpriced" };
    if (!safeNonNegative(input.spentMicroUsd) || !safeNonNegative(input.reservedMicroUsd)) {
        return { ok: false, reason: "unpriced" };
    }
    if (input.spentMicroUsd + input.reservedMicroUsd + input.incomingMicroUsd > input.limitMicroUsd) {
        return { ok: false, reason: "over_limit" };
    }
    return { ok: true };
};

export type PinnedHoldClose =
    | { outcome: "not_started" }
    | { outcome: "unknown" }
    | { outcome: "usage"; actualMicroUsd: number };

export type HoldSnapshot = {
    status: PinnedExperimentHoldStatus;
    reservedMicroUsd: number;
    experimentId: string;
};

/**
 * `not_started` drops the reservation. `unknown` keeps the whole reservation
 * as spent. `usage` records the measured cost on the hold. The experiment
 * ceiling keeps that measurement when it is at least the reservation, and
 * keeps the whole reservation when the measurement is smaller. A
 * second close finds a terminal status and changes nothing, so it cannot
 * release an occupied hold and it cannot add the same cost twice.
 */
export const applyExperimentClose = (
    counters: ExperimentCounters,
    hold: HoldSnapshot,
    request: { experimentId: string } & PinnedHoldClose
):
    | { ok: true; unchanged: true }
    | { ok: false; reason: "mismatch" | "unpriced" | "drift" }
    | {
        ok: true;
        unchanged: false;
        spentMicroUsd: number;
        reservedMicroUsd: number;
        status: PinnedExperimentHoldStatus;
        settledMicroUsd: number | null;
    } => {
    if (hold.experimentId !== request.experimentId) return { ok: false, reason: "mismatch" };
    if (hold.status !== "held") return { ok: true, unchanged: true };
    if (!safeNonNegative(hold.reservedMicroUsd)) return { ok: false, reason: "unpriced" };
    if (
        counters.limitMicroUsd === null ||
        !safeNonNegative(counters.spentMicroUsd) ||
        !safeNonNegative(counters.reservedMicroUsd)
    ) {
        return { ok: false, reason: "unpriced" };
    }
    if (counters.reservedMicroUsd < hold.reservedMicroUsd) return { ok: false, reason: "drift" };

    let added = 0;
    if (request.outcome === "usage") {
        if (!safeNonNegative(request.actualMicroUsd)) return { ok: false, reason: "unpriced" };
        added = Math.max(request.actualMicroUsd, hold.reservedMicroUsd);
    } else if (request.outcome === "unknown") {
        added = hold.reservedMicroUsd;
    }
    const nextSpent = counters.spentMicroUsd + added;
    const nextReserved = counters.reservedMicroUsd - hold.reservedMicroUsd;
    if (!safeNonNegative(nextSpent) || !safeNonNegative(nextReserved)) {
        return { ok: false, reason: "drift" };
    }
    const status: PinnedExperimentHoldStatus = request.outcome === "not_started"
        ? "released"
        : request.outcome === "unknown"
            ? "occupied"
            : "settled";
    return {
        ok: true,
        unchanged: false,
        spentMicroUsd: nextSpent,
        reservedMicroUsd: nextReserved,
        status,
        settledMicroUsd: request.outcome === "not_started"
            ? null
            : request.outcome === "unknown"
                ? hold.reservedMicroUsd
                : request.actualMicroUsd,
    };
};

export type ExperimentLedger = {
    reserve(input: {
        experimentId: string;
        amountMicroUsd: number;
        deploymentId: string;
        logicalModelId: string;
    }): Promise<
        | { ok: true; holdId: string }
        | { ok: false; reason: "no_limit" | "unpriced" | "over_limit" }
    >;
    close(input: {
        holdId: string;
        experimentId: string;
    } & PinnedHoldClose): Promise<{ ok: true } | { ok: false }>;
    snapshot(): {
        spentMicroUsd: number;
        reservedMicroUsd: number;
        holds: readonly { id: string; status: PinnedExperimentHoldStatus; reservedMicroUsd: number }[];
    };
};

/**
 * One in-process experiment, with the same reserve predicate as the database
 * ledger. The queue is the stand-in for `FOR UPDATE`: two reservations cannot
 * both read the same remainder.
 */
export const createSerialExperimentLedger = (
    limitMicroUsd: number | null
): ExperimentLedger => {
    let spentMicroUsd = 0;
    let reservedMicroUsd = 0;
    const holds = new Map<string, {
        status: PinnedExperimentHoldStatus;
        reservedMicroUsd: number;
        experimentId: string;
    }>();
    let chain = Promise.resolve();
    const exclusive = <T>(work: () => T | Promise<T>): Promise<T> => {
        const run = chain.then(() => work(), () => work());
        chain = run.then(() => undefined, () => undefined);
        return run;
    };
    return {
        snapshot: () => ({
            spentMicroUsd,
            reservedMicroUsd,
            holds: [...holds.entries()].map(([id, hold]) => ({ id, ...hold })),
        }),
        reserve: (input) => exclusive(() => {
            if (!named(input.experimentId) || !named(input.deploymentId) || !named(input.logicalModelId)) {
                return { ok: false as const, reason: "no_limit" as const };
            }
            const decision = decideExperimentReserve({
                spentMicroUsd,
                reservedMicroUsd,
                incomingMicroUsd: input.amountMicroUsd,
                limitMicroUsd,
            });
            if (!decision.ok) return decision;
            const holdId = `hold_${holds.size + 1}`;
            reservedMicroUsd += input.amountMicroUsd;
            holds.set(holdId, {
                status: "held",
                reservedMicroUsd: input.amountMicroUsd,
                experimentId: input.experimentId,
            });
            return { ok: true as const, holdId };
        }),
        close: (input) => exclusive(() => {
            const hold = holds.get(input.holdId);
            if (!hold) return { ok: false as const };
            const decision = applyExperimentClose(
                { spentMicroUsd, reservedMicroUsd, limitMicroUsd },
                hold,
                input
            );
            if (!decision.ok) return { ok: false as const };
            if (decision.unchanged) return { ok: true as const };
            spentMicroUsd = decision.spentMicroUsd;
            reservedMicroUsd = decision.reservedMicroUsd;
            holds.set(input.holdId, {
                status: decision.status,
                reservedMicroUsd: hold.reservedMicroUsd,
                experimentId: hold.experimentId,
            });
            return { ok: true as const };
        }),
    };
};

export type PinnedLoadedDeployment =
    | {
        ok: true;
        deploymentId: string;
        logicalModelId: string;
        provider: string;
        contextWindowTokens: number | null;
    }
    | { ok: false; reason: "deployment_mismatch" };

export type PinnedTransportResult = {
    started: boolean;
    pending?: boolean;
    response?: unknown;
    usage?: {
        inputTokens: number | undefined;
        outputTokens: number | undefined;
        cacheWriteTokens: number | undefined;
    } | null;
};

export type PinnedRunPorts = {
    loadDeployment: (deploymentId: string) => Promise<PinnedLoadedDeployment>;
    resolvePricing: (
        logicalModelId: string,
        promptTokens: number
    ) => Promise<PinnedPriceRates | null>;
    ledger: ExperimentLedger;
    record: (plan: PinnedQuote & {
        deploymentId: string;
        logicalModelId: string;
        provider: string;
    }) => Promise<{ ok: true; attemptId: string } | { ok: false }>;
    transport: (args: PinnedInferenceArguments & {
        logicalModelId: string;
        provider: string;
        messages: readonly PinnedMessage[];
        holdId: string;
        experimentId: string;
        inputUsdPerMillionTokens: number;
        outputUsdPerMillionTokens: number;
        cacheWriteUsdPerMillionTokens: number;
    }) => Promise<PinnedTransportResult>;
};

export type PinnedRefusalReason =
    | "side_cost"
    | "deployment_mismatch"
    | "unpriced"
    | "no_limit"
    | "over_limit"
    | "record_required"
    | "not_started"
    | "provider_error";

export type PinnedRunResult =
    | { route: "existing"; providerCalls: 0 }
    | { route: "refused"; reason: PinnedRefusalReason; providerCalls: number }
    | {
        route: "dispatched";
        providerCalls: 1;
        hold: "in_flight" | "settled" | "occupied" | "released";
        response?: unknown;
    };

const refused = (
    reason: PinnedRefusalReason,
    providerCalls = 0
): PinnedRunResult => ({ route: "refused", reason, providerCalls });

export const pinnedRefusalHttp = (reason: PinnedRefusalReason): {
    status: number;
    code: string;
    message: string;
} => {
    if (reason === "no_limit" || reason === "over_limit") {
        return {
            status: 409,
            code: "PINNED_EXPERIMENT_BUDGET",
            message: "The experiment budget does not cover this request.",
        };
    }
    if (reason === "record_required") {
        return {
            status: 503,
            code: "PINNED_RECORD_REQUIRED",
            message: "The pinned request has no dispatch record.",
        };
    }
    if (reason === "provider_error") {
        return {
            status: 502,
            code: "PINNED_DEPLOYMENT_REJECTED",
            message: "The pinned provider call failed.",
        };
    }
    if (reason === "side_cost" || reason === "unpriced") {
        return {
            status: 409,
            code: "PINNED_DEPLOYMENT_REJECTED",
            message: "This pinned request has no confirmed cost cap.",
        };
    }
    return {
        status: 409,
        code: "PINNED_DEPLOYMENT_REJECTED",
        message: "The stored deployment does not match the live call target.",
    };
};

export const runPinnedDeployment = async (
    input: {
        env: PinnedDeploymentConfig | {
            PINNED_DEPLOYMENT_EXECUTION?: string;
            PINNED_DEPLOYMENT_ACCOUNT_ID?: string;
            PINNED_DEPLOYMENT_ID?: string;
            PINNED_DEPLOYMENT_EXPERIMENT_ID?: string;
        };
        authenticatedAccountId: string | null;
        messages: readonly object[];
        webSearchMode?: string | null;
        deepResearchDepth?: unknown;
    },
    ports: PinnedRunPorts
): Promise<PinnedRunResult> => {
    const envRecord = input.env as {
        enabled?: unknown;
        PINNED_DEPLOYMENT_EXECUTION?: string;
        PINNED_DEPLOYMENT_ACCOUNT_ID?: string;
        PINNED_DEPLOYMENT_ID?: string;
        PINNED_DEPLOYMENT_EXPERIMENT_ID?: string;
    };
    const config = typeof envRecord.enabled === "boolean"
        ? input.env as PinnedDeploymentConfig
        : readPinnedDeploymentConfig(envRecord);
    if (classifyPinnedDeployment(config, input.authenticatedAccountId) === "existing") {
        return { route: "existing", providerCalls: 0 };
    }
    if (pinnedRequestHasUnpricedSideCost(input)) return refused("side_cost");
    if (!config.deploymentId) return refused("deployment_mismatch");
    if (!config.experimentId) return refused("no_limit");

    const deploymentId = config.deploymentId;
    const experimentId = config.experimentId;
    let loaded: PinnedLoadedDeployment;
    try {
        loaded = await ports.loadDeployment(deploymentId);
    } catch {
        return refused("deployment_mismatch");
    }
    if (!loaded.ok || loaded.deploymentId !== deploymentId) return refused("deployment_mismatch");

    const billableInputTokens = pinnedReservedInputTokens(input.messages);
    if (billableInputTokens === null) return refused("unpriced");

    let pricing: PinnedPriceRates | null;
    try {
        pricing = await ports.resolvePricing(loaded.logicalModelId, billableInputTokens);
    } catch {
        return refused("unpriced");
    }
    const quoted = quotePinnedTextCost({
        messages: input.messages,
        pricing,
        contextWindowTokens: loaded.contextWindowTokens,
        billableInputTokens,
    });
    if (!quoted.ok) return refused("unpriced");
    const plan = {
        ...quoted.quote,
        deploymentId,
        logicalModelId: loaded.logicalModelId,
        provider: loaded.provider,
    };

    let holdId: string | null = null;
    let transportInvoked = false;
    try {
        const reserved = await ports.ledger.reserve({
            experimentId,
            amountMicroUsd: plan.reservedMicroUsd,
            deploymentId,
            logicalModelId: plan.logicalModelId,
        });
        if (!reserved.ok) return refused(reserved.reason);
        const reservedHoldId = reserved.holdId;
        holdId = reservedHoldId;
        const recorded = await ports.record(plan);
        if (!recorded.ok) {
            await ports.ledger.close({ holdId: reservedHoldId, experimentId, outcome: "not_started" });
            return refused("record_required");
        }
        transportInvoked = true;
        const outcome = await ports.transport({
            ...pinnedInferenceArguments(plan),
            logicalModelId: plan.logicalModelId,
            provider: plan.provider,
            messages: plan.messages,
            holdId: reservedHoldId,
            experimentId,
            inputUsdPerMillionTokens: plan.inputUsdPerMillionTokens,
            outputUsdPerMillionTokens: plan.outputUsdPerMillionTokens,
            cacheWriteUsdPerMillionTokens: plan.cacheWriteUsdPerMillionTokens,
        });
        if (!outcome.started) {
            await ports.ledger.close({ holdId: reservedHoldId, experimentId, outcome: "not_started" });
            return refused("not_started");
        }
        if (outcome.usage) {
            let settledRates: PinnedPriceRates | null = null;
            if (typeof outcome.usage.inputTokens === "number") {
                try {
                    settledRates = await ports.resolvePricing(
                        plan.logicalModelId,
                        outcome.usage.inputTokens
                    );
                } catch {
                    settledRates = null;
                }
            }
            const actual = settledRates === null
                ? null
                : settlePinnedUsageCost(settledRates, outcome.usage);
            const closed = await ports.ledger.close(actual === null
                ? { holdId: reservedHoldId, experimentId, outcome: "unknown" }
                : { holdId: reservedHoldId, experimentId, outcome: "usage", actualMicroUsd: actual });
            if (!closed.ok) {
                return { route: "dispatched", providerCalls: 1, hold: "in_flight", response: outcome.response };
            }
            return {
                route: "dispatched",
                providerCalls: 1,
                hold: actual === null ? "occupied" : "settled",
                response: outcome.response,
            };
        }
        if (outcome.pending) {
            return {
                route: "dispatched",
                providerCalls: 1,
                hold: "in_flight",
                response: outcome.response,
            };
        }
        await ports.ledger.close({ holdId: reservedHoldId, experimentId, outcome: "unknown" });
        return { route: "dispatched", providerCalls: 1, hold: "occupied", response: outcome.response };
    } catch {
        if (holdId && transportInvoked) {
            await ports.ledger.close({ holdId, experimentId, outcome: "unknown" }).catch(() => undefined);
            return refused("provider_error", 1);
        }
        if (holdId) {
            await ports.ledger.close({ holdId, experimentId, outcome: "not_started" }).catch(() => undefined);
        }
        return refused(transportInvoked ? "provider_error" : "record_required", transportInvoked ? 1 : 0);
    }
};
