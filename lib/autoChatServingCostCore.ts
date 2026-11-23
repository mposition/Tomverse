/**
 * What real Auto Chat turns cost to serve, from records that already exist:
 * AutoRouterDecision.traceId -> ChatCreditReservation.traceId -> the
 * resolved attempt costs (base row plus adjustments), RoutingRun for
 * provenance and the `${traceId}:server` latency sample. No new ledger.
 *
 * Only the answer attempts are attributed to a request today, so the
 * coverage is `answer_cost_only`: the router's tokens are recorded without a
 * price snapshot, and the Prompt Refiner and app-managed search are not linked
 * to the request. Those are reported as unknown or unattributed, never as
 * zero, and never estimated from a provider's daily totals. Native search is
 * already inside the attempt cost, so nothing is added for it.
 */
export const AUTO_CHAT_SERVING_COST_VERSION = "auto-chat-serving-cost-v1";

export type ServingTraceRecord = {
    traceId: string;
    pickedModelId: string | null;
    outcome: string;
    router: { inputTokens: number | null; outputTokens: number | null };
    /** Chat answer reservations with this trace id. */
    reservations: { id: string; status: string; settledCredits: number }[];
    /** resolvedAttemptCosts rows of those reservations. */
    attempts: { reservationId: string; modelId: string; outcome: string; costMicroUsd: bigint | number; estimated: boolean }[];
    routingRun: boolean;
    firstContentMs: number | null;
};

type Bucket = {
    traces: number;
    linked: number;
    settledCredits: number;
    answer: { knownTraces: number; unknownTraces: number; knownMicroUsd: number; attempts: number; failedAttempts: number; retriedTraces: number };
    router: { tokenTraces: number; inputTokens: number; outputTokens: number };
    routingRunTraces: number;
    firstContentMs: number[];
};

const emptyBucket = (): Bucket => ({
    traces: 0, linked: 0, settledCredits: 0,
    answer: { knownTraces: 0, unknownTraces: 0, knownMicroUsd: 0, attempts: 0, failedAttempts: 0, retriedTraces: 0 },
    router: { tokenTraces: 0, inputTokens: 0, outputTokens: 0 },
    routingRunTraces: 0, firstContentMs: [],
});

/** Known only when a settled reservation has attempts and none of them is an unmeasured estimate. */
export const traceAnswerCost = (record: ServingTraceRecord): { state: "known"; microUsd: number } | { state: "unknown" | "unlinked" } => {
    if (record.reservations.length === 0) return { state: "unlinked" };
    // Every linked reservation needs its own attempts: one reservation's cost never stands in for another's.
    if (record.reservations.some(reservation => !record.attempts.some(attempt => attempt.reservationId === reservation.id)) ||
        record.attempts.some(attempt => attempt.estimated) ||
        record.reservations.some(reservation => reservation.status !== "settled" && reservation.status !== "refunded")) return { state: "unknown" };
    const microUsd = record.attempts.reduce((sum, attempt) => sum + Number(attempt.costMicroUsd), 0);
    return Number.isSafeInteger(microUsd) && microUsd >= 0 ? { state: "known", microUsd } : { state: "unknown" };
};

const add = (bucket: Bucket, record: ServingTraceRecord) => {
    bucket.traces += 1;
    if (record.reservations.length > 0) bucket.linked += 1;
    bucket.settledCredits += record.reservations.reduce((sum, reservation) => sum + reservation.settledCredits, 0);
    const answer = traceAnswerCost(record);
    if (answer.state === "known") {
        bucket.answer.knownTraces += 1;
        bucket.answer.knownMicroUsd += answer.microUsd;
    } else if (answer.state === "unknown") bucket.answer.unknownTraces += 1;
    bucket.answer.attempts += record.attempts.length;
    bucket.answer.failedAttempts += record.attempts.filter(attempt => attempt.outcome !== "completed").length;
    if (record.attempts.length > 1) bucket.answer.retriedTraces += 1;
    if (record.router.inputTokens !== null && record.router.outputTokens !== null) {
        bucket.router.tokenTraces += 1;
        bucket.router.inputTokens += record.router.inputTokens;
        bucket.router.outputTokens += record.router.outputTokens;
    }
    if (record.routingRun) bucket.routingRunTraces += 1;
    if (record.firstContentMs !== null) bucket.firstContentMs.push(record.firstContentMs);
};

const view = (bucket: Bucket) => {
    const { firstContentMs, ...rest } = bucket;
    const sorted = [...firstContentMs].sort((left, right) => left - right);
    return {
        ...rest,
        firstContentMsP50: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)] : null,
        latencySamples: sorted.length,
        /** Per linked request with a known answer cost; null without one. */
        answerMicroUsdPerKnownTrace: bucket.answer.knownTraces ? Math.round(bucket.answer.knownMicroUsd / bucket.answer.knownTraces) : null,
    };
};

export const summarizeChatServingCost = (records: readonly ServingTraceRecord[], window: { since: string; until: string }) => {
    const total = emptyBucket();
    const byModel = new Map<string, Bucket>();
    for (const record of records) {
        add(total, record);
        const key = record.pickedModelId ?? "(not picked)";
        const bucket = byModel.get(key) ?? emptyBucket();
        add(bucket, record);
        byModel.set(key, bucket);
    }
    return {
        version: AUTO_CHAT_SERVING_COST_VERSION,
        basis: "reported_usage_configured_prices" as const,
        coverage: "answer_cost_only" as const,
        window,
        components: {
            answerAttempts: "attributed_per_request",
            nativeSearch: "inside_attempt_cost",
            router: "tokens_recorded_without_price_snapshot",
            promptRefiner: "unattributed",
            appManagedSearch: "unattributed",
        } as const,
        total: view(total),
        byModel: [...byModel.entries()]
            .map(([modelId, bucket]) => ({ modelId, ...view(bucket) }))
            .sort((left, right) => right.traces - left.traces || left.modelId.localeCompare(right.modelId)),
    };
};
export type ChatServingCostSummary = ReturnType<typeof summarizeChatServingCost>;
