import "server-only";

/**
 * What one attempt cost, written when that attempt ends.
 *
 * ## Why not at settlement, where it used to live
 *
 * `settleChatUsage` is the last thing a turn does, and until now it was the
 * only writer of `ChatAttemptUsage`. That is fine for the attempt that
 * answered -- its usage is not known any earlier -- and wrong for every
 * attempt before it.
 *
 * A fallback turn ends attempt 0 the moment the primary fails, and then keeps
 * running for as long as the second model takes to answer. If the process dies
 * in that window, attempt 0 is already terminal, so the stale-attempt sweep
 * never looks at it (it only considers `pending`), and settlement never ran.
 * The provider was called, was paid, and nothing anywhere records it. Not a
 * wrong number -- no number.
 *
 * So the cost row is written in the same transaction as the close that says
 * the attempt is over. The compare-and-set on `pending` decides who writes:
 * whoever wins the predicate carries the cost row in their transaction, and
 * the loser's transaction writes nothing. There is no window between the two
 * for a crash to fall into.
 *
 * ## Why an insert that fails is not an error
 *
 * `ChatAttemptUsage` is unique on `(reservationId, attemptIndex)` and refuses
 * updates outright, so the second writer of an attempt is skipped rather than
 * applied. That silence is right for a replayed settlement and wrong for the
 * one case where the second writer knows more than the first: the sweep wrote
 * a reserved upper bound for an attempt nobody observed, and the real usage
 * has since arrived. Dropping it would leave the estimate standing for ever
 * while the truth was known and discarded.
 *
 * The base row stays immutable and the observation is appended as a
 * `ChatAttemptUsageAdjustment` carrying the signed difference, applied to the
 * same rollup in the same transaction. Resolved provider cost is the base row
 * plus its adjustments; nothing is rewritten for that to be true.
 */

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { calculateProviderUsageCost } from "@/lib/providerUsageCost";
import { recordInternalProviderUsage } from "@/lib/providerUsageAccounting";
import type { PricedAttempt } from "@/lib/chatMultiAttemptSettlement";
import {
    closeAttempt,
    type RoutingAttemptOutcome,
    type RoutingFailureLayer,
} from "@/lib/routingAttemptStore";

/** Identifiers come from providers, so they are bounded before storage. */
export const boundedProviderIdentifier = (value: string | null | undefined) => {
    const normalized = value?.trim();
    if (!normalized) return null;
    return normalized.replace(/[^A-Za-z0-9._:/-]/g, "").slice(0, 240) || null;
};

/**
 * How the numbers on a cost row were arrived at.
 *
 * A column rather than a note inside `pricingSnapshot`, because the reports
 * that read this ledger have to separate measured spend from estimated spend,
 * and a provenance nobody can filter on is a provenance nobody uses.
 */
export const attemptUsageSource = (attempt: LedgerAttempt) =>
    attempt.costSource === "reserved_upper_bound"
        ? "crash_reconciliation"
        : attempt.costSource === "provider_response"
          ? "provider_response_cost"
          : attempt.usageFromProvider
            ? "provider_usage_metadata"
            : "fallback_estimator";

/** Cached input can never exceed input; providers occasionally say otherwise. */
const cachedInputTokensOf = (attempt: LedgerAttempt) =>
    Math.min(attempt.inputTokens, attempt.cachedInputTokens);

/**
 * An attempt as this ledger accepts it.
 *
 * Two values wider than `PricedAttempt`, and both belong to the sweep alone:
 * an outcome nobody observed, and a cost nobody measured. They are deliberately
 * *not* added to `PricedAttempt` -- that type feeds `combineAttemptUsage`,
 * where "which attempt does the user pay for" is decided, and an attempt whose
 * outcome is unknown must never be a candidate for that answer.
 */
export type LedgerAttempt = Omit<PricedAttempt, "outcome" | "costSource"> & {
    outcome: PricedAttempt["outcome"] | "unknown_after_dispatch";
    costSource: PricedAttempt["costSource"] | "reserved_upper_bound";
};

export type AttemptCostOutcome =
    /** This call wrote the row and moved the rollup. */
    | "inserted"
    /** A crash-reconciled estimate was here; the real usage was appended. */
    | "corrected"
    /**
     * The correction was appended and the rollup row it belongs to was not
     * there to receive it.
     *
     * Distinct from `corrected` because the two are not the same state and
     * reporting them as one is how a lost delta stays lost. The adjustment
     * keeps `appliedAt` NULL, which is what
     * `applyPendingAttemptCostAdjustments` looks for.
     */
    | "adjustment_pending"
    /** Somebody already recorded this attempt with equal standing. */
    | "duplicate"
    /**
     * The observation names a different model or provider than the row it
     * would correct.
     *
     * Refused rather than applied. A delta is a difference between two prices
     * for the same call; moving one model's difference onto another model's
     * rollup is not a correction, it is two wrong numbers.
     */
    | "identity_mismatch";

export type AttemptCostRecord = {
    reservationId: string;
    attempt: LedgerAttempt;
    /** Merged into `pricingSnapshot` beside the rates, for attribution. */
    snapshot?: Record<string, unknown>;
    /**
     * The `ProviderDailyUsage` day this row belongs to.
     *
     * Passed rather than read from a clock here so the caller can give the
     * row and its rollup one value. Defaults to today at midnight UTC.
     */
    rollupDate?: Date;
    /**
     * The cost split to roll up, when the caller has a better one than the
     * token calculator produces.
     *
     * Perplexity reports its own component costs and settlement already
     * resolved them; recomputing from tokens here would write a different
     * split for the same total. Omitted, the tokens decide.
     */
    rollup?: {
        uncachedInputCostMicroUsd: number;
        cachedInputCostMicroUsd: number;
        outputCostMicroUsd: number;
    };
    /**
     * Nobody counted this call's tokens, so the row records none.
     *
     * NULL rather than 0, which would be a measurement. The cost still stands:
     * the money was committed, and that is a different kind of claim from a
     * token count nobody took. The rollup takes the cost with a zero split for
     * the same reason -- apportioning it would be inventing three numbers to
     * make one look complete.
     */
    unknownTokens?: boolean;
};

/** Midnight UTC, matching `ProviderDailyUsage.date`. */
export const rollupDayOf = (at = new Date()) =>
    new Date(
        Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate())
    );

/**
 * One attempt's cost row and its rollup, in the caller's transaction.
 *
 * Per attempt, never a batch gated on "did all of them insert". That gate was
 * correct only while every row was written at one moment; now that an attempt
 * records its own cost when it ends, a settlement legitimately finds one row
 * present and one absent, and an all-or-nothing gate would drop the rollup for
 * the one it did write.
 */
export const recordAttemptCost = async (
    tx: Prisma.TransactionClient,
    {
        reservationId,
        attempt,
        snapshot,
        rollupDate,
        rollup,
        unknownTokens,
    }: AttemptCostRecord
): Promise<AttemptCostOutcome> => {
    const cachedInputTokens = cachedInputTokensOf(attempt);
    // One value for the row and its rollup. Read once, here, so the two
    // cannot land on different days when a turn settles across midnight.
    const day = rollupDate ?? rollupDayOf();
    const written = await tx.chatAttemptUsage.createMany({
        skipDuplicates: true,
        data: [
            {
                reservationId,
                attemptIndex: attempt.attemptIndex,
                modelId: attempt.price.modelId,
                provider: attempt.price.provider,
                outcome: attempt.outcome,
                providerRequestId: boundedProviderIdentifier(
                    attempt.providerRequestId
                ),
                providerResponseId: boundedProviderIdentifier(
                    attempt.providerResponseId
                ),
                inputTokens: unknownTokens ? null : attempt.inputTokens,
                cachedInputTokens: unknownTokens ? null : cachedInputTokens,
                outputTokens: unknownTokens ? null : attempt.outputTokens,
                reasoningTokens:
                    !unknownTokens && Number.isSafeInteger(attempt.reasoningTokens)
                        ? Math.max(0, attempt.reasoningTokens!)
                        : null,
                costMicroUsd: BigInt(attempt.costMicroUsd),
                usageSource: attemptUsageSource(attempt),
                costSource: attempt.costSource,
                rollupDate: day,
                pricingSnapshot: {
                    ...attempt.price,
                    costSource: attempt.costSource,
                    ...(snapshot ?? {}),
                } as Prisma.InputJsonValue,
            },
        ],
    });

    if (written.count !== 1) {
        return correctExistingAttemptCost(tx, { reservationId, attempt });
    }

    // A call that used nothing and cost nothing moves no rollup. The row above
    // still stands: it is the record that the attempt happened.
    if (
        attempt.inputTokens === 0 &&
        attempt.outputTokens === 0 &&
        attempt.costMicroUsd === 0
    ) {
        return "inserted";
    }

    const breakdown =
        rollup ??
        (unknownTokens
            ? {
                  uncachedInputCostMicroUsd: 0,
                  cachedInputCostMicroUsd: 0,
                  outputCostMicroUsd: 0,
              }
            : null) ??
        calculateProviderUsageCost({
            inputTokens: attempt.inputTokens,
            cachedInputTokens: attempt.cachedInputTokens,
            outputTokens: attempt.outputTokens,
            inputUsdPerMillionTokens: attempt.price.inputUsdPerMillionTokens,
            outputUsdPerMillionTokens: attempt.price.outputUsdPerMillionTokens,
            cachedInputPriceMultiplier: attempt.price.cachedInputPriceMultiplier,
        });
    await recordInternalProviderUsage({
        client: tx,
        date: day,
        provider: attempt.price.provider,
        modelId: attempt.price.modelId,
        inputTokens: unknownTokens ? 0 : attempt.inputTokens,
        cachedInputTokens: unknownTokens ? 0 : cachedInputTokens,
        outputTokens: unknownTokens ? 0 : attempt.outputTokens,
        estimatedCostMicroUsd: attempt.costMicroUsd,
        uncachedInputCostMicroUsd: breakdown.uncachedInputCostMicroUsd,
        cachedInputCostMicroUsd: breakdown.cachedInputCostMicroUsd,
        outputCostMicroUsd: breakdown.outputCostMicroUsd,
    });
    return "inserted";
};

/**
 * Real usage arriving after the sweep guessed, appended rather than applied.
 *
 * Only a `crash_reconciliation` row is corrected. Every other provenance was
 * written by somebody who observed the call, and a second writer with the same
 * standing is a replay -- moving the ledger for it would double the spend.
 */
const correctExistingAttemptCost = async (
    tx: Prisma.TransactionClient,
    { reservationId, attempt }: Omit<AttemptCostRecord, "snapshot">
): Promise<AttemptCostOutcome> => {
    const existing = await tx.chatAttemptUsage.findUnique({
        where: {
            reservationId_attemptIndex: {
                reservationId,
                attemptIndex: attempt.attemptIndex,
            },
        },
    });
    // Not logged. Since an attempt records its own cost when it ends, a
    // settlement finding the primary's row already there is the ordinary case,
    // not an anomaly -- and a warning on every fallback turn is a warning
    // nobody reads. The outcome is returned instead, so a caller that did not
    // expect one can say so with the context to make it meaningful.
    if (existing?.usageSource !== "crash_reconciliation") return "duplicate";

    // A guess may not correct a guess. Only an observation -- somebody who saw
    // the call -- has standing to replace a reserved upper bound; another
    // upper bound would append an adjustment of zero and call it a correction.
    if (attempt.costSource === "reserved_upper_bound") return "duplicate";

    // The row is the authority on which rollup it moved: it recorded the
    // provider, the model and the day it landed on. An observation that names
    // a different model is not describing the same call, and its delta belongs
    // to no row here.
    if (
        existing.provider !== attempt.price.provider ||
        existing.modelId !== attempt.price.modelId
    ) {
        console.error(
            JSON.stringify({
                event: "chat_attempt_usage_identity_mismatch",
                reservationId,
                attemptIndex: attempt.attemptIndex,
                recorded: `${existing.provider}/${existing.modelId}`,
                observed: `${attempt.price.provider}/${attempt.price.modelId}`,
            })
        );
        return "identity_mismatch";
    }

    // Identifies the observation, so the same one twice is one adjustment. A
    // provider request id when there is one, because a reconciliation file
    // replayed a week later carries that and not this turn's identity.
    const observationId =
        boundedProviderIdentifier(attempt.providerRequestId) ||
        `settlement:${reservationId}:${attempt.attemptIndex}`;
    const delta = BigInt(attempt.costMicroUsd) - existing.costMicroUsd;

    const appended = await tx.chatAttemptUsageAdjustment.createMany({
        skipDuplicates: true,
        data: [
            {
                reservationId,
                attemptIndex: attempt.attemptIndex,
                kind: "late_provider_actual",
                observedInputTokens: attempt.inputTokens,
                observedCachedInputTokens: cachedInputTokensOf(attempt),
                observedOutputTokens: attempt.outputTokens,
                observedCostMicroUsd: BigInt(attempt.costMicroUsd),
                costDeltaMicroUsd: delta,
                observationId,
                providerRequestId: boundedProviderIdentifier(
                    attempt.providerRequestId
                ),
                // Unapplied until the rollup has actually taken it. Claiming
                // otherwise would make `ChatAttemptUsageAdjustment_unapplied_idx`
                // -- an index whose entire purpose is finding deltas the rollup
                // never received -- structurally unable to find one.
                appliedAt: null,
            },
        ],
    });
    if (appended.count !== 1) return "duplicate";

    // The difference, in the same transaction as the adjustment that
    // justifies it, against the day the base row recorded as its own.
    //
    // An UPDATE and not an upsert: this delta belongs to the rollup row the
    // base row already moved, and a row that is not there is an anomaly to
    // surface rather than a row to invent. `applyPendingAttemptCostAdjustments`
    // is the path that repairs it, and it is the one allowed to create.
    const moved = await applyAdjustmentDelta(tx, {
        // All three from the row, which is the only record of where the base
        // accrual actually went. Taking the day from it and the identity from
        // the observation was how the two could point at different rows.
        provider: existing.provider,
        modelId: existing.modelId,
        rollupDate: existing.rollupDate,
        costDeltaMicroUsd: delta,
        inputTokens: attempt.inputTokens,
        cachedInputTokens: cachedInputTokensOf(attempt),
        outputTokens: attempt.outputTokens,
        create: false,
    });

    if (moved) {
        await tx.chatAttemptUsageAdjustment.updateMany({
            where: {
                reservationId,
                attemptIndex: attempt.attemptIndex,
                observationId,
                appliedAt: null,
            },
            data: { appliedAt: new Date() },
        });
    }

    console.warn(
        JSON.stringify({
            event: moved
                ? "chat_attempt_usage_corrected"
                : "chat_attempt_usage_correction_pending",
            reservationId,
            attemptIndex: attempt.attemptIndex,
            costDeltaMicroUsd: delta.toString(),
        })
    );
    return moved ? "corrected" : "adjustment_pending";
};

/**
 * Moves one adjustment's delta into the rollup it belongs to.
 *
 * `create: false` refuses to invent the row -- the base cost row already moved
 * it, so its absence means something is wrong and the caller records that.
 * `create: true` is the repair path, where the row's absence is the thing
 * being repaired and a missing row must not block the delta for ever.
 *
 * Token counts are added rather than adjusted: the row a correction targets
 * was written by the sweep, which knew the money and not the split, so it
 * contributed none. `requestCount` is untouched -- the call was counted when
 * it was recorded, and learning what it used does not make it a second call.
 */
const applyAdjustmentDelta = async (
    tx: Prisma.TransactionClient,
    input: {
        provider: string;
        modelId: string;
        rollupDate: Date;
        costDeltaMicroUsd: bigint;
        inputTokens: number;
        cachedInputTokens: number;
        outputTokens: number;
        create: boolean;
    }
): Promise<boolean> => {
    // The delta stays a bigint all the way into the statement. `ProviderDailyUsage`
    // stores 32-bit integers and every other writer clamps before it gets there;
    // this one has to do the same, and it has to do the arithmetic in `bigint`
    // first. Clamping the *result* is not enough -- `int + int` overflows inside
    // Postgres before any clamp of ours could see it, and the statement raises
    // rather than saturating.
    const delta = input.costDeltaMicroUsd;
    const input_ = BigInt(Math.max(0, input.inputTokens));
    const cached_ = BigInt(Math.max(0, input.cachedInputTokens));
    const output_ = BigInt(Math.max(0, input.outputTokens));
    if (!input.create) {
        const rows = await tx.$executeRaw`
            UPDATE "ProviderDailyUsage"
            SET "estimatedCostMicroUsd" = LEAST(2000000000, GREATEST(0,
                    "estimatedCostMicroUsd"::bigint + ${delta}::bigint))::int,
                "inputTokens" = LEAST(2000000000, GREATEST(0,
                    "inputTokens"::bigint + ${input_}::bigint))::int,
                "cachedInputTokens" = LEAST(2000000000, GREATEST(0,
                    "cachedInputTokens"::bigint + ${cached_}::bigint))::int,
                "outputTokens" = LEAST(2000000000, GREATEST(0,
                    "outputTokens"::bigint + ${output_}::bigint))::int,
                "updatedAt" = NOW()
            WHERE "provider" = ${input.provider}
              AND "modelId" = ${input.modelId}
              AND "source" = 'internal'
              AND "date" = ${input.rollupDate}
        `;
        return rows === 1;
    }
    await tx.$executeRaw`
        INSERT INTO "ProviderDailyUsage" (
            "id", "provider", "modelId", "source", "date",
            "requestCount", "inputTokens", "cachedInputTokens", "outputTokens",
            "estimatedCostMicroUsd", "uncachedInputCostMicroUsd",
            "cachedInputCostMicroUsd", "outputCostMicroUsd",
            "createdAt", "updatedAt"
        )
        VALUES (
            ${`pdu_${input.provider}_${input.modelId}_${input.rollupDate.toISOString()}`},
            ${input.provider}, ${input.modelId}, 'internal', ${input.rollupDate},
            0,
            LEAST(2000000000, GREATEST(0, ${input_}::bigint))::int,
            LEAST(2000000000, GREATEST(0, ${cached_}::bigint))::int,
            LEAST(2000000000, GREATEST(0, ${output_}::bigint))::int,
            LEAST(2000000000, GREATEST(0, ${delta}::bigint))::int, 0, 0, 0,
            NOW(), NOW()
        )
        ON CONFLICT ("provider", "modelId", "source", "date")
        DO UPDATE SET
            "estimatedCostMicroUsd" = LEAST(2000000000, GREATEST(0,
                "ProviderDailyUsage"."estimatedCostMicroUsd"::bigint + ${delta}::bigint))::int,
            "inputTokens" = LEAST(2000000000, GREATEST(0,
                "ProviderDailyUsage"."inputTokens"::bigint + ${input_}::bigint))::int,
            "cachedInputTokens" = LEAST(2000000000, GREATEST(0,
                "ProviderDailyUsage"."cachedInputTokens"::bigint + ${cached_}::bigint))::int,
            "outputTokens" = LEAST(2000000000, GREATEST(0,
                "ProviderDailyUsage"."outputTokens"::bigint + ${output_}::bigint))::int,
            "updatedAt" = NOW()
    `;
    return true;
};

/**
 * Deltas the rollup never received, applied now.
 *
 * The partial index on `appliedAt IS NULL` marks the problem; without this it
 * would only ever mark it. Each adjustment is applied and marked in one
 * transaction, and the `appliedAt IS NULL` predicate on the mark is the
 * compare-and-set that keeps two replays from applying one delta twice.
 */
/**
 * How much correction is still owed to the rollups, and how long it has waited.
 *
 * The count alone answers "is there work"; the age answers "is anything
 * getting through", which is the number that says whether the replay is
 * running at all. A backlog of zero on a replay nobody wired up looks
 * identical to a backlog of zero on one that keeps up -- which is exactly the
 * state this ledger was in until the maintenance run began calling it.
 */
export const pendingAttemptCostAdjustmentBacklog = async (now = new Date()) => {
    const rows = await prisma.$queryRaw<
        { pending: bigint; oldest_ms: number | null }[]
    >`
        SELECT
            COUNT(*)::bigint AS pending,
            MAX(EXTRACT(EPOCH FROM (${now}::timestamp - "createdAt")) * 1000)::float
                AS oldest_ms
        FROM "ChatAttemptUsageAdjustment"
        WHERE "appliedAt" IS NULL
    `;
    const row = rows[0];
    return {
        pending: Number(row?.pending ?? 0),
        oldestPendingMs: row?.oldest_ms == null ? null : Math.round(row.oldest_ms),
    };
};

export const applyPendingAttemptCostAdjustments = async (
    batch = 200
): Promise<{ examined: number; applied: number; failed: number }> => {
    const pending = await prisma.chatAttemptUsageAdjustment.findMany({
        where: { appliedAt: null },
        orderBy: { createdAt: "asc" },
        take: Math.min(1_000, Math.max(1, batch)),
        include: { attempt: true },
    });

    let applied = 0;
    let failed = 0;
    for (const adjustment of pending) {
        try {
            const moved = await prisma.$transaction(async (tx) => {
                // The mark first, on the `appliedAt IS NULL` predicate: a
                // replay that loses it wrote nothing, so the delta cannot be
                // applied twice by two runs racing.
                const claimed = await tx.chatAttemptUsageAdjustment.updateMany({
                    where: { id: adjustment.id, appliedAt: null },
                    data: { appliedAt: new Date() },
                });
                if (claimed.count !== 1) return false;
                await applyAdjustmentDelta(tx, {
                    provider: adjustment.attempt.provider,
                    modelId: adjustment.attempt.modelId,
                    rollupDate: adjustment.attempt.rollupDate,
                    costDeltaMicroUsd: adjustment.costDeltaMicroUsd,
                    inputTokens: adjustment.observedInputTokens ?? 0,
                    cachedInputTokens: adjustment.observedCachedInputTokens ?? 0,
                    outputTokens: adjustment.observedOutputTokens ?? 0,
                    create: true,
                });
                return true;
            });
            if (moved) applied += 1;
        } catch (error) {
            failed += 1;
            console.error(
                JSON.stringify({
                    event: "chat_attempt_usage_adjustment_replay_failed",
                    adjustmentId: adjustment.id,
                    error:
                        error instanceof Error
                            ? error.message.slice(0, 300)
                            : "unknown",
                })
            );
        }
    }
    return { examined: pending.length, applied, failed };
};

/**
 * What an attempt cost once everything known about it is counted.
 *
 * Base row plus its adjustments, because the base row is immutable and a
 * correction is appended rather than applied. Anything that reports provider
 * spend per attempt has to read it this way: reading `costMicroUsd` alone
 * gives the crash sweep's upper bound for ever, even after the real usage
 * arrived and was recorded.
 *
 * `ProviderDailyUsage` needs none of this -- the adjustment's delta is applied
 * to it in the same transaction that appends the adjustment, so the rollup is
 * already resolved. This is for reads that go row by row.
 */
export const resolvedAttemptCosts = async (reservationId: string) => {
    const [rows, adjustments] = await Promise.all([
        prisma.chatAttemptUsage.findMany({
            where: { reservationId },
            orderBy: { attemptIndex: "asc" },
        }),
        prisma.chatAttemptUsageAdjustment.findMany({ where: { reservationId } }),
    ]);
    const deltaByAttempt = new Map<number, bigint>();
    for (const adjustment of adjustments) {
        deltaByAttempt.set(
            adjustment.attemptIndex,
            (deltaByAttempt.get(adjustment.attemptIndex) ?? BigInt(0)) +
                adjustment.costDeltaMicroUsd
        );
    }
    return rows.map((row) => {
        const delta = deltaByAttempt.get(row.attemptIndex) ?? BigInt(0);
        return {
            attemptIndex: row.attemptIndex,
            modelId: row.modelId,
            provider: row.provider,
            outcome: row.outcome,
            usageSource: row.usageSource,
            costSource: row.costSource,
            /** What the row itself claimed when it was written. */
            recordedCostMicroUsd: row.costMicroUsd,
            correctionMicroUsd: delta,
            /** The figure to report. Never below zero, whatever arrived late. */
            costMicroUsd:
                row.costMicroUsd + delta < BigInt(0)
                    ? BigInt(0)
                    : row.costMicroUsd + delta,
            /** True while the only figure is one nobody measured. */
            estimated: row.costSource === "reserved_upper_bound" && delta === BigInt(0),
        };
    });
};

export type AttemptCloseWithCost = {
    attemptId: string;
    outcome: RoutingAttemptOutcome;
    failureLayer?: RoutingFailureLayer;
    firstVisibleTokenAt?: Date | null;
    actualInputTokens?: number | null;
    actualOutputTokens?: number | null;
    errorClass?: string | null;
    /** Absent when there is no reservation to charge -- nothing was held. */
    cost?: AttemptCostRecord | null;
    /**
     * Works out what to record, inside the transaction that will record it.
     *
     * Given instead of `cost` when the answer has to be read from the database:
     * a caller that read first and wrote second would be deciding from a state
     * that can change in between, and any read failure would happen outside the
     * transaction, where a throw cannot take the close back with it.
     *
     * Called only after the compare-and-set has been won, so no read happens
     * for an attempt this call is not going to close. Returning null means
     * "close it, record nothing"; throwing means "record nothing and do not
     * close it either", which leaves the next sweep something to find.
     */
    resolveCost?: (
        tx: Prisma.TransactionClient
    ) => Promise<AttemptCostRecord | null>;
};

/**
 * Ends an attempt and records what it cost, or does neither.
 *
 * Returns `closed: false` when the compare-and-set lost -- the sweep got here
 * first, or a second close was attempted -- and in that case nothing was
 * written, including the cost row. That is deliberate: the row belongs to
 * whichever writer established the attempt was over, and a loser that wrote
 * one anyway would be recording a cost against an outcome it did not set.
 */
export const closeAttemptWithCost = async (
    input: AttemptCloseWithCost
): Promise<{ closed: boolean; cost: AttemptCostOutcome | "skipped" }> => {
    // Nothing to bind the close to, so no transaction to bind it in. This is
    // the attempt that ends the turn -- its usage is not known until
    // settlement, which writes the row there -- and it is on the hot path.
    if (!input.cost && !input.resolveCost) {
        const closed = await closeAttempt(input);
        return { closed, cost: "skipped" };
    }
    return prisma.$transaction(async (tx) => {
        const closed = await closeAttempt({
            client: tx,
            attemptId: input.attemptId,
            outcome: input.outcome,
            failureLayer: input.failureLayer,
            firstVisibleTokenAt: input.firstVisibleTokenAt,
            actualInputTokens: input.actualInputTokens,
            actualOutputTokens: input.actualOutputTokens,
            errorClass: input.errorClass,
        });
        if (!closed) return { closed: false, cost: "skipped" as const };

        const record = input.resolveCost
            ? await input.resolveCost(tx)
            : (input.cost ?? null);
        if (!record) return { closed: true, cost: "skipped" as const };

        const cost = await recordAttemptCost(tx, record);
        if (cost === "duplicate") {
            // This writer won the compare-and-set, so it is the first to
            // establish the attempt was over -- and a cost row already being
            // there means somebody recorded spend for an attempt nobody had
            // closed yet. Worth saying out loud; the row is left alone.
            console.warn(
                JSON.stringify({
                    event: "chat_attempt_usage_recorded_before_close",
                    reservationId: record.reservationId,
                    attemptIndex: record.attempt.attemptIndex,
                })
            );
        }
        return { closed: true, cost };
    });
};
