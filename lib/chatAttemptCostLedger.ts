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
export const attemptUsageSource = (attempt: PricedAttempt) =>
    attempt.costSource === "provider_response"
        ? "provider_response_cost"
        : attempt.usageFromProvider
          ? "provider_usage_metadata"
          : "fallback_estimator";

/** Cached input can never exceed input; providers occasionally say otherwise. */
const cachedInputTokensOf = (attempt: PricedAttempt) =>
    Math.min(attempt.inputTokens, attempt.cachedInputTokens);

export type AttemptCostOutcome =
    /** This call wrote the row and moved the rollup. */
    | "inserted"
    /** A crash-reconciled estimate was here; the real usage was appended. */
    | "corrected"
    /** Somebody already recorded this attempt with equal standing. */
    | "duplicate";

export type AttemptCostRecord = {
    reservationId: string;
    attempt: PricedAttempt;
    /** Merged into `pricingSnapshot` beside the rates, for attribution. */
    snapshot?: Record<string, unknown>;
};

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
    { reservationId, attempt, snapshot }: AttemptCostRecord
): Promise<AttemptCostOutcome> => {
    const cachedInputTokens = cachedInputTokensOf(attempt);
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
                inputTokens: attempt.inputTokens,
                cachedInputTokens,
                outputTokens: attempt.outputTokens,
                reasoningTokens: Number.isSafeInteger(attempt.reasoningTokens)
                    ? Math.max(0, attempt.reasoningTokens!)
                    : null,
                costMicroUsd: BigInt(attempt.costMicroUsd),
                usageSource: attemptUsageSource(attempt),
                costSource: attempt.costSource,
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

    const breakdown = calculateProviderUsageCost({
        inputTokens: attempt.inputTokens,
        cachedInputTokens: attempt.cachedInputTokens,
        outputTokens: attempt.outputTokens,
        inputUsdPerMillionTokens: attempt.price.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: attempt.price.outputUsdPerMillionTokens,
        cachedInputPriceMultiplier: attempt.price.cachedInputPriceMultiplier,
    });
    await recordInternalProviderUsage({
        client: tx,
        provider: attempt.price.provider,
        modelId: attempt.price.modelId,
        inputTokens: attempt.inputTokens,
        cachedInputTokens,
        outputTokens: attempt.outputTokens,
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
                appliedAt: new Date(),
            },
        ],
    });

    if (appended.count === 1) {
        // The difference, in the same transaction as the adjustment that
        // justifies it. Written against the day the estimate landed on, so
        // the correction reaches the row it corrects rather than today's.
        //
        // The tokens are added rather than adjusted: the row this corrects was
        // written by the sweep, which knew the money and not the split, so it
        // contributed zero tokens. `requestCount` is deliberately untouched --
        // the call was counted when it was recorded, and learning what it used
        // does not make it a second call.
        await tx.$executeRaw`
            UPDATE "ProviderDailyUsage"
            SET "estimatedCostMicroUsd" =
                    GREATEST(0, "estimatedCostMicroUsd" + ${delta}),
                "inputTokens" = "inputTokens" + ${attempt.inputTokens},
                "cachedInputTokens" = "cachedInputTokens" + ${cachedInputTokensOf(attempt)},
                "outputTokens" = "outputTokens" + ${attempt.outputTokens},
                "updatedAt" = NOW()
            WHERE "provider" = ${attempt.price.provider}
              AND "modelId" = ${attempt.price.modelId}
              AND "source" = 'internal'
              AND "date" = DATE_TRUNC('day', ${existing.createdAt}::timestamp)
        `;
    }

    console.warn(
        JSON.stringify({
            event: "chat_attempt_usage_corrected",
            reservationId,
            attemptIndex: attempt.attemptIndex,
            costDeltaMicroUsd: delta.toString(),
            appended: appended.count === 1,
        })
    );
    return appended.count === 1 ? "corrected" : "duplicate";
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
    cost: AttemptCostRecord | null;
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
    // No cost to bind the close to, so no transaction to bind it in. This is
    // the attempt that ends the turn -- its usage is not known until
    // settlement, which writes the row there -- and it is on the hot path.
    if (!input.cost) {
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
        const cost = await recordAttemptCost(tx, input.cost!);
        if (cost === "duplicate") {
            // This writer won the compare-and-set, so it is the first to
            // establish the attempt was over -- and a cost row already being
            // there means somebody recorded spend for an attempt nobody had
            // closed yet. Worth saying out loud; the row is left alone.
            console.warn(
                JSON.stringify({
                    event: "chat_attempt_usage_recorded_before_close",
                    reservationId: input.cost!.reservationId,
                    attemptIndex: input.cost!.attempt.attemptIndex,
                })
            );
        }
        return { closed: true, cost };
    });
};
