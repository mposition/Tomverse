import "server-only";

import { prisma } from "@/lib/prisma";
import { isMissingDatabaseSchemaError } from "@/lib/databaseError";
import {
    FALLBACK_COST_SOURCE,
    summarizeFallbackPricingDecisions,
    summarizeFallbackReservations,
    type FallbackDecisionSample,
    type FallbackReservationSample,
} from "@/lib/fallbackPricingMetricsCore";
import {
    daysUntil,
    PENDING_VERIFIED_PRICE_REGISTER,
} from "@/lib/modelPricing";

const MAX_WINDOW_DAYS = 90;
const DEFAULT_WINDOW_DAYS = 7;
/**
 * Row cap per query. The summary is a monitoring read, not a report: a window
 * busy enough to hit this is answered by a narrower window, and reporting the
 * truncation is better than a slow admin page or a silently partial share.
 */
const MAX_ROWS = 5_000;

const clampWindowDays = (value: number | undefined) => {
    if (!Number.isFinite(value)) return DEFAULT_WINDOW_DAYS;
    return Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.round(value as number)));
};

const toNumber = (value: bigint | number | null | undefined) => {
    if (typeof value === "bigint") {
        return Number.isSafeInteger(Number(value)) ? Number(value) : 0;
    }
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
};

const readDecisionModels = (value: unknown): FallbackDecisionSample["models"] => {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        if (!entry || typeof entry !== "object") return [];
        const record = entry as Record<string, unknown>;
        const modelId = record.modelId;
        if (typeof modelId !== "string" || modelId.length === 0) return [];
        return [
            {
                modelId,
                costSource:
                    typeof record.costSource === "string"
                        ? record.costSource
                        : null,
            },
        ];
    });
};

const readReservationCostSource = (value: unknown) => {
    if (!value || typeof value !== "object") return null;
    const source = (value as Record<string, unknown>).reservationCostSource;
    return typeof source === "string" ? source : null;
};

export type FallbackPricingReport = Awaited<
    ReturnType<typeof getFallbackPricingReport>
>;

/**
 * Operational view of the models still on the conservative pricing fallback:
 * the register itself, how much traffic it covers, how many refusals it was
 * involved in, and how far its reservations sat above what settled.
 *
 * Never throws on a missing table -- the decision and reservation tables are
 * migrated separately, and a monitoring page failing outright is worse than one
 * reporting that its source is not available yet.
 */
export const getFallbackPricingReport = async ({
    windowDays,
    now = new Date(),
}: { windowDays?: number; now?: Date } = {}) => {
    const days = clampWindowDays(windowDays);
    const since = new Date(now.getTime() - days * 86_400_000);
    const registeredModelIds = PENDING_VERIFIED_PRICE_REGISTER.map(
        (entry) => entry.modelId
    );

    let decisionRows: FallbackDecisionSample[] = [];
    let decisionsUnavailable = false;
    try {
        const rows = await prisma.chatLimitDecisionEvent.findMany({
            where: { createdAt: { gte: since } },
            orderBy: { createdAt: "desc" },
            take: MAX_ROWS,
            select: {
                decision: true,
                errorCode: true,
                limitLayer: true,
                models: true,
            },
        });
        decisionRows = rows.map((row) => ({
            decision: row.decision,
            errorCode: row.errorCode,
            limitLayer: row.limitLayer,
            models: readDecisionModels(row.models),
        }));
    } catch (error) {
        if (!isMissingDatabaseSchemaError(error)) throw error;
        decisionsUnavailable = true;
    }

    let reservationRows: FallbackReservationSample[] = [];
    let reservationsUnavailable = false;
    try {
        const rows = await prisma.chatCreditReservation.findMany({
            where: { createdAt: { gte: since } },
            orderBy: { createdAt: "desc" },
            take: MAX_ROWS,
            select: {
                modelId: true,
                status: true,
                settledAt: true,
                reservedCostMicroUsd: true,
                settledCostMicroUsd: true,
                pricingSnapshot: true,
            },
        });
        reservationRows = rows.map((row) => ({
            modelId: row.modelId,
            reservationCostSource: readReservationCostSource(
                row.pricingSnapshot
            ),
            reservedCostMicroUsd: toNumber(row.reservedCostMicroUsd),
            settledCostMicroUsd: toNumber(row.settledCostMicroUsd),
            settled: row.status === "settled" && row.settledAt !== null,
        }));
    } catch (error) {
        if (!isMissingDatabaseSchemaError(error)) throw error;
        reservationsUnavailable = true;
    }

    const decisions = summarizeFallbackPricingDecisions(decisionRows);
    const reservations = summarizeFallbackReservations(reservationRows);

    return {
        generatedAt: now.toISOString(),
        windowDays: days,
        since: since.toISOString(),
        fallbackCostSource: FALLBACK_COST_SOURCE,
        register: PENDING_VERIFIED_PRICE_REGISTER.map((entry) => ({
            ...entry,
            daysUntilExpiry: daysUntil(entry.expiresAt, now),
        })),
        decisions: {
            ...decisions,
            unavailable: decisionsUnavailable,
            truncated: decisionRows.length >= MAX_ROWS,
        },
        reservations: {
            ...reservations,
            unavailable: reservationsUnavailable,
            truncated: reservationRows.length >= MAX_ROWS,
        },
        /**
         * Fallback-priced models seen in traffic that nobody registered. The
         * register is the tracked list; anything here is untracked drift.
         */
        unregisteredFallbackModels: decisions.byModel
            .map((entry) => entry.modelId)
            .filter((modelId) => !registeredModelIds.includes(modelId)),
    };
};
