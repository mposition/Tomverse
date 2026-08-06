/**
 * Stage 2 of the context-window rollout, as pure arithmetic
 * (`docs/ops/tomverse-chat-context-window-rollout.md`).
 *
 * The rollout is staged because connecting a window is not a no-op. The chat
 * route's guard reads `modelConfig.contextWindowTokens && ...`, so a model with
 * no declared window is not clamped to a safe default — it is not checked at
 * all. Declaring one *switches on* a rejection that was previously skipped, and
 * stage 2 exists so the blast radius is a number before anyone decides.
 *
 * There is also a live discrepancy here, not only a future one. The guard
 * compares `estimatedInputTokens + maxOutputTokens`, while the credit
 * reservation books `inputTokens = estimatedInputTokens +
 * estimateToolInputTokenOverhead(...)` — up to 6,400 more for a turn with
 * provider-native search, and those tokens are really sent. On the models that
 * already declare a window the guard therefore under-counts the very request it
 * is protecting. The rollout's formula is the reserved one:
 *
 *     budget.inputTokens + budget.maxOutputTokens > contextWindowTokens
 *
 * Nothing here reads a database or prints. The caller supplies rows; this
 * decides what they mean, so the judgement is testable without traffic.
 */

/** A model's window, and where the number came from. */
export type WindowSource = "verified" | "catalogue";

export type ModelWindow = {
    modelId: string;
    contextWindowTokens: number;
    source: WindowSource;
    /**
     * Whether the provider's published window covers output as well as input.
     * Reported rather than acted on: a window that excludes output cannot be
     * compared against an input+output sum without deciding what to do with
     * the difference, and that decision belongs to stage 3.
     */
    includesOutput: boolean | null;
};

export type ReservationPlan = "Guest" | "Free" | "Pro" | "Max";

export type ReservationRow = {
    modelId: string;
    /** Guest rows carry no account, and are counted as their own cohort. */
    plan: ReservationPlan;
    /** What the reservation booked: raw estimate plus tool overhead. */
    inputTokens: number;
    maxOutputTokens: number;
    /** Provider-reported, present only once the reservation settled. */
    settledInputTokens?: number;
    settledOutputTokens?: number;
    /** True when the provider itself refused the request for length. */
    providerContextError?: boolean;
};

/**
 * The largest overhead `estimateToolInputTokenOverhead` can add: 6,000 for
 * retrieved search text plus 400 for the tool definition
 * (`lib/chatTokenEstimate.ts`).
 *
 * A bound rather than a lookup, because the reservation stores the sum and not
 * its parts. That limit is load-bearing for how this report is worded — see
 * `blockedDependsOnToolOverhead`.
 */
export const MAX_TOOL_INPUT_TOKEN_OVERHEAD = 6_400;

export type PlanCounts = Record<ReservationPlan, number>;

const emptyPlanCounts = (): PlanCounts => ({
    Guest: 0,
    Free: 0,
    Pro: 0,
    Max: 0,
});

export type ModelImpact = {
    modelId: string;
    contextWindowTokens: number;
    source: WindowSource;
    includesOutput: boolean | null;
    requests: number;
    /** Rows the rollout's reserved-token formula would refuse. */
    blocked: number;
    blockedShare: number;
    blockedByPlan: PlanCounts;
    /**
     * Of those, the rows today's guard refuses as well — over the limit even
     * with the entire tool overhead subtracted. Connecting the corrected
     * formula changes nothing for these.
     */
    blockedRegardlessOfToolOverhead: number;
    /**
     * The rest: rows whose current fate depends on an overhead the reservation
     * did not record. If the turn carried search, today's guard let it through
     * and the corrected one would not; if it carried no tools, both refuse it.
     *
     * This is an upper bound on "newly rejected", and it is deliberately not
     * collapsed into a point estimate. The split is not derivable from stored
     * reservations, and inventing it would be inventing traffic — so the
     * honest output is the band, plus the note that closing it needs the
     * estimate and the overhead recorded separately.
     */
    blockedDependsOnToolOverhead: number;
    /** Reserved input+output, for sizing the tail. */
    p95ReservedTokens: number;
    p99ReservedTokens: number;
    /**
     * Settled rows whose *actual* provider usage exceeded the window. Ground
     * truth rather than estimate, and available only for settled rows.
     */
    settledRows: number;
    settledOverWindow: number;
    /** Turns the provider already refused for length, today, unaided. */
    providerContextErrors: number;
};

/**
 * A provider refusing a request for length — the one signal here that needs no
 * estimate at all, because the provider itself said the request was too long.
 *
 * Matched on the provider's wording rather than on any Tomverse error code:
 * this is meant to catch refusals the guard never saw coming.
 */
export const PROVIDER_CONTEXT_ERROR_PATTERN =
    /context[_ ]?(length|window)|too many tokens|maximum context/i;

/** The stored shape, as much of it as this report reads. */
export type StoredReservation = {
    modelId: string;
    reservationPayload: unknown;
    status: string;
    lastError: string | null;
    settledInputTokens: number;
    settledOutputTokens: number;
    user: { plan: string | null } | null;
};

/**
 * One stored reservation as a row this report can judge, or `null` when the
 * payload cannot be read.
 *
 * Null rather than a zeroed row on purpose. A payload this cannot parse is
 * missing traffic, and quietly substituting zero would move it into the "well
 * inside the window" bucket — turning missing evidence into reassurance. The
 * caller counts the nulls and states them alongside the denominator.
 */
export function toImpactRow(
    reservation: StoredReservation
): ReservationRow | null {
    const payload = reservation.reservationPayload as
        | Record<string, unknown>
        | null;
    const inputTokens = Number(payload?.inputTokens);
    const maxOutputTokens = Number(
        payload?.reservedOutputTokens ?? payload?.maxOutputTokens
    );
    if (!Number.isFinite(inputTokens) || !Number.isFinite(maxOutputTokens)) {
        return null;
    }
    const plan = reservation.user?.plan;
    return {
        modelId: reservation.modelId,
        // Anything that is not a known paid plan is a guest: a reservation
        // with no account is the guest cohort, and an unrecognised value must
        // not be silently promoted into a paid one.
        plan:
            plan === "Pro" || plan === "Max" || plan === "Free" ? plan : "Guest",
        inputTokens,
        maxOutputTokens,
        // Settled usage only counts once the reservation actually settled.
        // The columns default to 0, so reading them on a reserved row would
        // report every open request as having consumed nothing.
        ...(reservation.status === "settled"
            ? {
                  settledInputTokens: reservation.settledInputTokens,
                  settledOutputTokens: reservation.settledOutputTokens,
              }
            : {}),
        providerContextError: PROVIDER_CONTEXT_ERROR_PATTERN.test(
            reservation.lastError ?? ""
        ),
    };
}

export type ImpactReport = {
    models: ModelImpact[];
    /** Models with traffic but no window to measure against. */
    unmeasurableModels: Array<{ modelId: string; requests: number }>;
    totalRequests: number;
    totalBlocked: number;
};

/**
 * Nearest-rank percentile on a sorted array.
 *
 * Nearest-rank rather than interpolated because these are token counts of real
 * requests: the answer should be a size some request actually had, not an
 * average of two that did.
 */
export const percentile = (sorted: readonly number[], fraction: number) => {
    if (sorted.length === 0) return 0;
    const rank = Math.ceil(fraction * sorted.length);
    return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
};

export function buildContextWindowImpact(
    rows: readonly ReservationRow[],
    windows: readonly ModelWindow[]
): ImpactReport {
    const windowByModel = new Map(
        windows.map((window) => [window.modelId, window])
    );
    const grouped = new Map<string, ReservationRow[]>();
    for (const row of rows) {
        const bucket = grouped.get(row.modelId);
        if (bucket) bucket.push(row);
        else grouped.set(row.modelId, [row]);
    }

    const models: ModelImpact[] = [];
    const unmeasurableModels: Array<{ modelId: string; requests: number }> = [];

    for (const [modelId, modelRows] of grouped) {
        const window = windowByModel.get(modelId);
        if (!window) {
            // Named, not dropped. A model carrying traffic that stage 2 cannot
            // measure is the finding — omitting it silently would read as "no
            // impact" when it means "no evidence".
            unmeasurableModels.push({ modelId, requests: modelRows.length });
            continue;
        }

        const limit = window.contextWindowTokens;
        const blockedByPlan = emptyPlanCounts();
        let blocked = 0;
        let blockedRegardlessOfToolOverhead = 0;
        let settledRows = 0;
        let settledOverWindow = 0;
        let providerContextErrors = 0;
        const reservedTotals: number[] = [];

        for (const row of modelRows) {
            const reserved = row.inputTokens + row.maxOutputTokens;
            reservedTotals.push(reserved);
            if (row.providerContextError) providerContextErrors += 1;

            if (
                typeof row.settledInputTokens === "number" &&
                typeof row.settledOutputTokens === "number"
            ) {
                settledRows += 1;
                if (row.settledInputTokens + row.settledOutputTokens > limit) {
                    settledOverWindow += 1;
                }
            }

            if (reserved <= limit) continue;
            blocked += 1;
            blockedByPlan[row.plan] += 1;

            // Today's guard compares `estimatedInputTokens + maxOutputTokens`,
            // and the estimate is somewhere in
            // [inputTokens - MAX_TOOL_INPUT_TOKEN_OVERHEAD, inputTokens].
            // Its smallest possible value still exceeding the limit means the
            // guard refuses this row whatever the overhead was.
            const smallestPossibleGuardValue =
                Math.max(0, row.inputTokens - MAX_TOOL_INPUT_TOKEN_OVERHEAD) +
                row.maxOutputTokens;
            if (smallestPossibleGuardValue > limit) {
                blockedRegardlessOfToolOverhead += 1;
            }
        }

        const sorted = [...reservedTotals].sort((left, right) => left - right);
        models.push({
            modelId,
            contextWindowTokens: limit,
            source: window.source,
            includesOutput: window.includesOutput,
            requests: modelRows.length,
            blocked,
            blockedShare:
                modelRows.length === 0 ? 0 : blocked / modelRows.length,
            blockedByPlan,
            blockedRegardlessOfToolOverhead,
            blockedDependsOnToolOverhead:
                blocked - blockedRegardlessOfToolOverhead,
            p95ReservedTokens: percentile(sorted, 0.95),
            p99ReservedTokens: percentile(sorted, 0.99),
            settledRows,
            settledOverWindow,
            providerContextErrors,
        });
    }

    models.sort((left, right) => right.requests - left.requests);
    unmeasurableModels.sort((left, right) => right.requests - left.requests);

    return {
        models,
        unmeasurableModels,
        totalRequests: rows.length,
        totalBlocked: models.reduce((total, model) => total + model.blocked, 0),
    };
}
