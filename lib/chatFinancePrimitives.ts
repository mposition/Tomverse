import "server-only";

import type { Prisma } from "@prisma/client";

/**
 * Workflow-neutral financial primitives shared by every path that reserves
 * money (docs/policy/credit-and-cost-limits.md §9).
 *
 * These used to live inside `lib/chatSecurity.ts`, where they were reachable
 * only from the chat admission function. Release B's memory extraction has to
 * reserve credits and provider budget from a *different* orchestration — no
 * chat lease, no IP admission — while producing exactly the same financial
 * outcome, and duplicating this arithmetic is how two billing paths drift
 * apart.
 *
 * Two properties keep the seam honest:
 *
 *   - **Workflow-neutral.** Nothing here knows what a chat, a comparison
 *     review or an extraction run is. `source` is audit metadata recorded by
 *     the caller, never a branch (§9).
 *   - **Transaction-scoped.** Every function takes a `tx`, so a caller can put
 *     a decision and its reservation in one boundary. Split across two
 *     transactions, concurrent callers see the same remaining budget and all
 *     pass — which is the bug this shape exists to prevent.
 *
 * Errors are raised through a caller-supplied factory rather than thrown from
 * here. Chat's budget-exhaustion error carries chat-specific detail
 * (alternative models to offer), and extraction has its own code from §18 of
 * the import/memory policy; a shared primitive must not have to know either.
 */

export type UsagePeriod = "minute" | "day" | "month";

/**
 * Every workflow that can commit money to a model call.
 *
 * Recorded on the reservation so an operator can tell a chat turn from a
 * comparison review from a background extraction run. It is **not** a
 * behaviour switch: reservation, settlement, release and the expiry sweep all
 * treat these identically, and adding a value here must never require adding
 * a branch anywhere (docs/policy/credit-and-cost-limits.md §9).
 */
export const RESERVATION_SOURCES = [
    "chat",
    "comparison_review",
    "memory_extraction",
] as const;

export type ReservationSource = (typeof RESERVATION_SOURCES)[number];

export type ReservationEntry = {
    key: string;
    period: string;
    periodStart: Date;
    amount: number;
    metric:
        | "tokens"
        | "cost"
        | "credits"
        | "plan-credits"
        | "plan-cost"
        | "pro-response";
};

/** UTC window start for a usage bucket. */
export const usagePeriodStart = (period: UsagePeriod, now: Date) => {
    if (period === "minute") {
        return new Date(
            Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth(),
                now.getUTCDate(),
                now.getUTCHours(),
                now.getUTCMinutes()
            )
        );
    }
    if (period === "day") {
        return new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
        );
    }
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
};

/**
 * Conditionally consumes `amount` from a usage bucket, returning whether it
 * fit. The check and the write are one statement: the `WHERE` on the upsert is
 * what makes two concurrent callers unable to both pass a limit they can only
 * jointly exceed.
 */
export const incrementUsageBucket = async (
    tx: Prisma.TransactionClient,
    key: string,
    period: string,
    start: Date,
    limit: number,
    amount = 1
) => {
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > limit) {
        return false;
    }
    const rows = await tx.$queryRaw<Array<{ count: number }>>`
        INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
        VALUES (${key}, ${period}, ${start}, ${amount}, NOW())
        ON CONFLICT ("key", "period", "periodStart")
        DO UPDATE SET
            "count" = "ChatUsageBucket"."count" + ${amount},
            "updatedAt" = NOW()
        WHERE "ChatUsageBucket"."count" <= ${limit - amount}
        RETURNING "count"
    `;
    return rows.length > 0;
};

export type ProviderBudgetScope = "provider_cost_day" | "provider_cost_month";

/**
 * Reserves one provider's day and month cost budget in the caller's
 * transaction, appending what it consumed so the caller can release it.
 *
 * `onExhausted` never returns: it is the caller's own error. Passing it in is
 * what lets chat keep offering alternative models while extraction answers
 * with its own §18 code, without this function knowing either exists.
 */
export const reserveProviderCostBudget = async (
    tx: Prisma.TransactionClient,
    input: {
        provider: string;
        reservedCostMicroUsd: number;
        dailyLimit: number;
        monthlyLimit: number;
        now: Date;
    },
    onExhausted: (detail: {
        scope: ProviderBudgetScope;
        requiredCostMicroUsd: number;
        limitCostMicroUsd: number;
    }) => never
): Promise<ReservationEntry[]> => {
    const entries: ReservationEntry[] = [];
    if (input.reservedCostMicroUsd <= 0) return entries;

    const providerKey = `provider:${input.provider}`;

    const dayStart = usagePeriodStart("day", input.now);
    const dayAllowed = await incrementUsageBucket(
        tx,
        providerKey,
        "provider-cost-day",
        dayStart,
        input.dailyLimit,
        input.reservedCostMicroUsd
    );
    if (!dayAllowed) {
        onExhausted({
            scope: "provider_cost_day",
            requiredCostMicroUsd: input.reservedCostMicroUsd,
            limitCostMicroUsd: input.dailyLimit,
        });
    }
    entries.push({
        key: providerKey,
        period: "provider-cost-day",
        periodStart: dayStart,
        amount: input.reservedCostMicroUsd,
        metric: "cost",
    });

    const monthStart = usagePeriodStart("month", input.now);
    const monthAllowed = await incrementUsageBucket(
        tx,
        providerKey,
        "provider-cost-month",
        monthStart,
        input.monthlyLimit,
        input.reservedCostMicroUsd
    );
    if (!monthAllowed) {
        onExhausted({
            scope: "provider_cost_month",
            requiredCostMicroUsd: input.reservedCostMicroUsd,
            limitCostMicroUsd: input.monthlyLimit,
        });
    }
    entries.push({
        key: providerKey,
        period: "provider-cost-month",
        periodStart: monthStart,
        amount: input.reservedCostMicroUsd,
        metric: "cost",
    });

    return entries;
};

export type DurableReservationInput = {
    reservationId: string;
    userId: string | null;
    subjectKey: string;
    traceId: string;
    /** Audit metadata only — see RESERVATION_SOURCES. */
    source: ReservationSource;
    provider: string;
    modelId: string;
    /**
     * Supplied by the caller, because what makes two requests "the same" is a
     * workflow question. Chat derives it from the reservation id; memory
     * extraction binds it to one chunk attempt, so a retried attempt cannot
     * reserve twice.
     */
    idempotencyKey: string;
    reservationPayload: Prisma.InputJsonValue;
    reservedCredits: number;
    reservedCostMicroUsd: number;
    planReservedCredits: number;
    addOnReservedCredits: number;
    expiresAt: Date;
};

/**
 * Writes the durable reservation row in the caller's transaction.
 *
 * The row is the record that money was committed to a call before the call
 * happened, and it is what settlement, release and the expiry sweep all work
 * from — so every financial path has to create it the same way, whatever
 * admission it went through to get here.
 */
export const createDurableReservation = async (
    tx: Prisma.TransactionClient,
    input: DurableReservationInput
) => {
    await tx.chatCreditReservation.create({
        data: {
            id: input.reservationId,
            userId: input.userId,
            subjectKey: input.subjectKey,
            traceId: input.traceId,
            source: input.source,
            provider: input.provider,
            modelId: input.modelId,
            status: "reserved",
            idempotencyKey: input.idempotencyKey,
            reservationPayload: input.reservationPayload,
            reservedCredits: input.reservedCredits,
            reservedCostMicroUsd: BigInt(input.reservedCostMicroUsd),
            planReservedCredits: input.planReservedCredits,
            addOnReservedCredits: input.addOnReservedCredits,
            expiresAt: input.expiresAt,
        },
    });
};

export type PlanCreditScope = "daily_plan_credits" | "monthly_plan_credits";

/**
 * Consumes plan credits from a subject's monthly window, and from its daily
 * window when the caller enforces one.
 *
 * The windows themselves are the caller's: chat has a daily message rule that
 * a background extraction run does not, and only the caller knows which
 * subject key it is spending against. What is shared is the part that must
 * never differ — that plan credits are consumed by a conditional increment, so
 * two concurrent reservations cannot both fit into a balance that only holds
 * one, and that the daily window is charged before the monthly one so a
 * failure leaves the smaller of the two untouched.
 */
export const reservePlanCreditBuckets = async (
    tx: Prisma.TransactionClient,
    input: {
        subjectKey: string;
        credits: number;
        monthly: { start: Date; limit: number };
        daily?: { start: Date; limit: number } | null;
    },
    onConflict: (scope: PlanCreditScope) => never
): Promise<ReservationEntry[]> => {
    const entries: ReservationEntry[] = [];
    if (input.credits <= 0) return entries;

    if (input.daily) {
        const dailyAllowed = await incrementUsageBucket(
            tx,
            input.subjectKey,
            "day",
            input.daily.start,
            input.daily.limit,
            input.credits
        );
        if (!dailyAllowed) onConflict("daily_plan_credits");
        entries.push({
            key: input.subjectKey,
            period: "day",
            periodStart: input.daily.start,
            amount: input.credits,
            metric: "plan-credits",
        });
    }

    const monthlyAllowed = await incrementUsageBucket(
        tx,
        input.subjectKey,
        "month",
        input.monthly.start,
        input.monthly.limit,
        input.credits
    );
    if (!monthlyAllowed) onConflict("monthly_plan_credits");
    entries.push({
        key: input.subjectKey,
        period: "month",
        periodStart: input.monthly.start,
        amount: input.credits,
        metric: "plan-credits",
    });

    return entries;
};
