// How much of production is running on a price we have not verified.
//
// A premium model with no explicit pricing profile is billed internally at the
// conservative fallback (US$15 input / US$60 output per million tokens). That
// is deliberately above any real list price, so it is safe against under-
// reservation -- but it over-sizes the reservation, which rejects some requests
// earlier than the true price would, and wherever settlement uses the
// reservation rates it also records an internal cost above what the provider
// actually charged.
//
// Neither effect is visible from the pending register alone: the register says
// which models are unverified, not whether anyone is being blocked by it. These
// aggregations answer that from data the system already writes --
// `ChatLimitDecisionEvent` for the share and the refusals,
// `ChatCreditReservation` for reserved-versus-settled.
//
// Pure functions over already-selected rows: no Prisma, no `server-only`, so
// the arithmetic is unit-testable. See lib/fallbackPricingMetrics.ts for the
// queries and docs/policy/credit-and-cost-limits.md for the policy.

import { classifyChatLimitCode } from "@/lib/chatCostSafetyCore";

/** `costSource` written by `resolveModelPricing` when no profile matched. */
export const FALLBACK_COST_SOURCE = "conservative_fallback";

export type FallbackDecisionModelSample = {
    modelId: string;
    costSource: string | null;
};

export type FallbackDecisionSample = {
    decision: string;
    errorCode: string | null;
    limitLayer: string | null;
    models: FallbackDecisionModelSample[];
};

export type FallbackDecisionModelBreakdown = {
    modelId: string;
    decisions: number;
    rejections: number;
};

export type FallbackDecisionSummary = {
    decisions: number;
    /** Decisions where at least one model priced off the fallback. */
    fallbackDecisions: number;
    /** `fallbackDecisions / decisions`, or `null` when there were none. */
    fallbackShare: number | null;
    rejections: number;
    /**
     * Cost- or credit-code refusals that involved a fallback-priced model.
     *
     * An upper bound on the harm, not a proven cause: the request may well have
     * exceeded the limit at the real price too. It is the population to
     * re-price against, which is what makes it worth counting.
     */
    fallbackAttributableRejections: number;
    /** Fallback-attributable refusals by error code. */
    rejectionsByErrorCode: Record<string, number>;
    /** Per fallback-priced model, most-used first. */
    byModel: FallbackDecisionModelBreakdown[];
};

const usesFallback = (model: FallbackDecisionModelSample) =>
    model.costSource === FALLBACK_COST_SOURCE;

export const summarizeFallbackPricingDecisions = (
    rows: readonly FallbackDecisionSample[]
): FallbackDecisionSummary => {
    const byModel = new Map<string, FallbackDecisionModelBreakdown>();
    const rejectionsByErrorCode: Record<string, number> = {};
    let fallbackDecisions = 0;
    let rejections = 0;
    let fallbackAttributableRejections = 0;

    for (const row of rows) {
        const rejected = row.decision === "rejected";
        if (rejected) rejections += 1;

        const fallbackModels = row.models.filter(usesFallback);
        if (fallbackModels.length === 0) continue;
        fallbackDecisions += 1;

        // A refusal only counts against the fallback when a cost or credit
        // limit produced it -- either layer, since an over-sized estimate can
        // exhaust an entitlement as easily as it can trip a guardrail. A
        // rejection for, say, an oversized attachment says nothing about price.
        const costRefusal =
            rejected && classifyChatLimitCode(row.errorCode) !== "other";
        if (costRefusal) {
            fallbackAttributableRejections += 1;
            const code = row.errorCode as string;
            rejectionsByErrorCode[code] =
                (rejectionsByErrorCode[code] ?? 0) + 1;
        }

        for (const model of new Set(
            fallbackModels.map((model) => model.modelId)
        )) {
            const entry = byModel.get(model) ?? {
                modelId: model,
                decisions: 0,
                rejections: 0,
            };
            entry.decisions += 1;
            if (costRefusal) entry.rejections += 1;
            byModel.set(model, entry);
        }
    }

    return {
        decisions: rows.length,
        fallbackDecisions,
        fallbackShare: rows.length === 0 ? null : fallbackDecisions / rows.length,
        rejections,
        fallbackAttributableRejections,
        rejectionsByErrorCode,
        byModel: [...byModel.values()].sort(
            (left, right) =>
                right.decisions - left.decisions ||
                left.modelId.localeCompare(right.modelId)
        ),
    };
};

export type FallbackReservationSample = {
    modelId: string;
    /** `pricingSnapshot.reservationCostSource`, absent on older rows. */
    reservationCostSource: string | null;
    reservedCostMicroUsd: number;
    settledCostMicroUsd: number;
    /** Whether the reservation reached a terminal settled state. */
    settled: boolean;
};

export type FallbackReservationModelBreakdown = {
    modelId: string;
    reservations: number;
    settledReservations: number;
    reservedCostMicroUsd: number;
    settledCostMicroUsd: number;
    reservedToSettledRatio: number | null;
};

export type FallbackReservationSummary = {
    reservations: number;
    settledReservations: number;
    reservedCostMicroUsd: number;
    settledCostMicroUsd: number;
    /**
     * Reserved over settled across settled reservations only.
     *
     * Unsettled rows have no settled figure to divide by, and including their
     * zero would report an over-reservation that has not been measured yet.
     * A ratio far above 1 is the evidence that the fallback is too conservative
     * for this model; `null` means nothing settled in the window.
     */
    reservedToSettledRatio: number | null;
    byModel: FallbackReservationModelBreakdown[];
};

const ratio = (reserved: number, settled: number) =>
    settled > 0 ? reserved / settled : null;

/**
 * Reserved-versus-settled for the reservations that were priced off the
 * fallback. Rows priced from a real profile are ignored: their ratio measures
 * output-length estimation, which is a different question.
 */
export const summarizeFallbackReservations = (
    rows: readonly FallbackReservationSample[]
): FallbackReservationSummary => {
    const byModel = new Map<string, FallbackReservationModelBreakdown>();
    let reservations = 0;
    let settledReservations = 0;
    let reservedCostMicroUsd = 0;
    let settledCostMicroUsd = 0;

    for (const row of rows) {
        if (row.reservationCostSource !== FALLBACK_COST_SOURCE) continue;
        reservations += 1;

        const entry = byModel.get(row.modelId) ?? {
            modelId: row.modelId,
            reservations: 0,
            settledReservations: 0,
            reservedCostMicroUsd: 0,
            settledCostMicroUsd: 0,
            reservedToSettledRatio: null,
        };
        entry.reservations += 1;

        if (row.settled) {
            settledReservations += 1;
            reservedCostMicroUsd += row.reservedCostMicroUsd;
            settledCostMicroUsd += row.settledCostMicroUsd;
            entry.settledReservations += 1;
            entry.reservedCostMicroUsd += row.reservedCostMicroUsd;
            entry.settledCostMicroUsd += row.settledCostMicroUsd;
        }
        byModel.set(row.modelId, entry);
    }

    for (const entry of byModel.values()) {
        entry.reservedToSettledRatio = ratio(
            entry.reservedCostMicroUsd,
            entry.settledCostMicroUsd
        );
    }

    return {
        reservations,
        settledReservations,
        reservedCostMicroUsd,
        settledCostMicroUsd,
        reservedToSettledRatio: ratio(reservedCostMicroUsd, settledCostMicroUsd),
        byModel: [...byModel.values()].sort(
            (left, right) =>
                right.reservations - left.reservations ||
                left.modelId.localeCompare(right.modelId)
        ),
    };
};
