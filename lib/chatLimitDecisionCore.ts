// Shape and redaction rules for limit-decision events, and the reset-instant
// rule they share with the error responses those events describe.
//
// A request rejected during preflight used to leave nothing behind but a
// console line, so an operator holding the user's Trace ID could not
// reconstruct why the block happened -- which prompt, which models, which
// price, which allowance. This builds the record that makes that
// reconstructible, while carrying no prompt text, no message content and no
// direct user identifier beyond the already-hashed usage subject key.

export type ChatLimitDecisionPhase =
    | "comparison_preflight"
    | "chat_reservation"
    | "availability_probe";

export type ChatLimitDecision = "allowed" | "rejected";

export type ChatLimitDecisionModel = {
    modelId: string;
    provider: string;
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    estimatedCostMicroUsd: number;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    pricingVersion: string;
    costSource: string;
    longContextThresholdTokens: number | null;
};

export type ChatLimitDecisionInput = {
    traceId: string;
    /** Already-hashed usage subject (`user:<sha256>` / `guest:<sha256>`). */
    subjectKey: string;
    userId?: string | null;
    plan: string;
    phase: ChatLimitDecisionPhase;
    decision: ChatLimitDecision;
    errorCode?: string | null;
    limitLayer?: string | null;
    limitScope?: string | null;
    models: ChatLimitDecisionModel[];
    enabledTools: string[];
    requiredCredits?: number | null;
    availableCredits?: number | null;
    usedAllowanceMicroUsd?: number | null;
    requiredAllowanceMicroUsd?: number | null;
    limitMicroUsd?: number | null;
    timeZone: string;
    resetAt?: Date | string | null;
    createdAt?: Date;
};

export type ChatLimitDecisionRecord = {
    traceId: string;
    subjectKey: string;
    userId: string | null;
    plan: string;
    phase: ChatLimitDecisionPhase;
    decision: ChatLimitDecision;
    errorCode: string | null;
    limitLayer: string | null;
    limitScope: string | null;
    modelIds: string[];
    enabledTools: string[];
    estimatedInputTokens: number;
    estimatedOutputTokens: number;
    estimatedCostMicroUsd: number;
    pricingVersions: string[];
    models: ChatLimitDecisionModel[];
    requiredCredits: number | null;
    availableCredits: number | null;
    usedAllowanceMicroUsd: number | null;
    requiredAllowanceMicroUsd: number | null;
    limitMicroUsd: number | null;
    timeZone: string;
    resetAt: Date | null;
    createdAt: Date;
};

const MAX_MODELS = 8;
const MAX_TOOLS = 12;

const boundedText = (value: unknown, maximum: number) =>
    typeof value === "string" ? value.trim().slice(0, maximum) : "";

const nonNegativeInteger = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value >= 0
        ? Math.round(value)
        : 0;

const optionalInteger = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value)
        ? Math.round(value)
        : null;

const toDate = (value: Date | string | null | undefined) => {
    if (!value) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * Reset instants are only useful if they are in the future when the client
 * reads them -- a past `resetAt` tells a blocked user to wait for something
 * that has already happened. Any candidate at or before `now` is treated as
 * missing rather than shown.
 */
export const futureResetAt = (
    candidate: Date | string | null | undefined,
    now: Date
) => {
    const date = toDate(candidate);
    if (!date) return null;
    return date.getTime() > now.getTime() ? date : null;
};

/**
 * A daily reset instant that is always in the future.
 *
 * A day window's end is normally ahead of `now`, but it is derived from stored
 * settings and can go stale -- for instance in the moments around a DST shift
 * or right after a time-zone change moved the current bucket. Telling a blocked
 * user to wait for an instant that has already passed is worse than useless, so
 * a stale boundary is rolled forward whole days until it is ahead of now.
 *
 * Whole days rather than a clamp to "in a moment": the boundary is a daily one,
 * and the next one is a day later. It lives here with the other two reset-instant
 * rules because a caller that knows the period is the only thing that can repair
 * a stale instant rather than drop it.
 */
export const safeDailyResetAt = (windowEnd: Date, now: Date) => {
    const future = futureResetAt(windowEnd, now);
    if (future) return future;
    const dayMs = 86_400_000;
    const elapsed = now.getTime() - windowEnd.getTime();
    return new Date(
        windowEnd.getTime() + (Math.floor(elapsed / dayMs) + 1) * dayMs
    );
};

/**
 * The same rule applied to what the blocked caller is actually handed.
 *
 * `futureResetAt` above has always guarded the limit-decision *record*, and the
 * error response describing the very same decision was left to whichever call
 * site built it. Most of them derive an instant that cannot be stale -- the
 * first of next month, the start of this minute plus sixty seconds. The daily
 * ones are derived from a stored time zone, which is exactly the case the
 * record-side guard was written for, so the audit trail could carry a rolled
 * forward instant while the response for the same rejection carried the raw
 * one.
 *
 * This is the last thing between a details bag and the wire, so it drops rather
 * than repairs: a call site that knows the period can roll a stale boundary
 * forward meaningfully, and this one cannot. "We are not telling you when"
 * degrades to a message with no reset line, which the client already renders.
 * "Wait until an instant that has passed" does not degrade at all.
 */
export const withFutureResetAt = <Details extends Record<string, unknown>>(
    details: Details,
    now: Date
): Details => {
    const candidate = details.resetAt;
    if (candidate === undefined) return details;
    const usable =
        (typeof candidate === "string" || candidate instanceof Date) &&
        futureResetAt(candidate, now) !== null;
    if (usable) return details;
    const rest = { ...details };
    delete rest.resetAt;
    return rest as Details;
};

export const buildChatLimitDecisionRecord = (
    input: ChatLimitDecisionInput
): ChatLimitDecisionRecord => {
    const createdAt = input.createdAt ?? new Date();
    const models = input.models.slice(0, MAX_MODELS).map((model) => ({
        modelId: boundedText(model.modelId, 160),
        provider: boundedText(model.provider, 80),
        estimatedInputTokens: nonNegativeInteger(model.estimatedInputTokens),
        estimatedOutputTokens: nonNegativeInteger(model.estimatedOutputTokens),
        estimatedCostMicroUsd: nonNegativeInteger(model.estimatedCostMicroUsd),
        inputUsdPerMillionTokens: Number(model.inputUsdPerMillionTokens) || 0,
        outputUsdPerMillionTokens: Number(model.outputUsdPerMillionTokens) || 0,
        pricingVersion: boundedText(model.pricingVersion, 120),
        costSource: boundedText(model.costSource, 60),
        longContextThresholdTokens:
            typeof model.longContextThresholdTokens === "number"
                ? model.longContextThresholdTokens
                : null,
    }));

    return {
        traceId: boundedText(input.traceId, 120) || "unknown",
        subjectKey: boundedText(input.subjectKey, 240),
        userId: input.userId ? boundedText(input.userId, 100) : null,
        plan: boundedText(input.plan, 24) || "Free",
        phase: input.phase,
        decision: input.decision,
        errorCode: input.errorCode ? boundedText(input.errorCode, 80) : null,
        limitLayer: input.limitLayer ? boundedText(input.limitLayer, 40) : null,
        limitScope: input.limitScope ? boundedText(input.limitScope, 60) : null,
        modelIds: models.map((model) => model.modelId),
        enabledTools: Array.from(
            new Set(
                input.enabledTools
                    .map((tool) => boundedText(tool, 60))
                    .filter(Boolean)
            )
        ).slice(0, MAX_TOOLS),
        estimatedInputTokens: models.reduce(
            (sum, model) => sum + model.estimatedInputTokens,
            0
        ),
        estimatedOutputTokens: models.reduce(
            (sum, model) => sum + model.estimatedOutputTokens,
            0
        ),
        estimatedCostMicroUsd: models.reduce(
            (sum, model) => sum + model.estimatedCostMicroUsd,
            0
        ),
        pricingVersions: Array.from(
            new Set(models.map((model) => model.pricingVersion).filter(Boolean))
        ),
        models,
        requiredCredits: optionalInteger(input.requiredCredits),
        availableCredits: optionalInteger(input.availableCredits),
        usedAllowanceMicroUsd: optionalInteger(input.usedAllowanceMicroUsd),
        requiredAllowanceMicroUsd: optionalInteger(
            input.requiredAllowanceMicroUsd
        ),
        limitMicroUsd: optionalInteger(input.limitMicroUsd),
        timeZone: boundedText(input.timeZone, 100) || "UTC",
        resetAt: futureResetAt(input.resetAt, createdAt),
        createdAt,
    };
};
