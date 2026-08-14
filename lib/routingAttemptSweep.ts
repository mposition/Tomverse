/**
 * Attempts whose process stopped reporting, closed honestly.
 *
 * A dispatch is recorded before the provider's stream is read and the outcome
 * is written after it. Between those two the process can die -- a deploy, an
 * OOM, a host going away -- and the attempt stays `pending` for ever. That is
 * not an exotic failure to wave at: it is an ordinary condition of running
 * anything, and a permanently unclassified attempt keeps polluting the
 * reliability numbers and ROUTE-06's evidence long after the incident.
 *
 * ## What the sweep is allowed to conclude
 *
 * Very little, and that is the point. It does **not** record
 * `failed_pre_token`: nobody observed the provider call, so a failure would be
 * a claim about an outcome nothing saw. `unknown_after_dispatch` says the two
 * things that are actually true -- a dispatch was recorded, and the turn never
 * came back to say how it ended -- and `process` names the layer that failed,
 * which was this process and not the provider. Filing it under `provider`
 * would put a host restart into provider health, and §8's recovery decides
 * which model a conversation goes back to from exactly those counters.
 *
 * The manifest and `dispatchedAt` are left untouched. They are the record of
 * what reached a provider, they are still true, and a sweep is not a licence
 * to edit them.
 *
 * ## Why all three conditions
 *
 * An attempt is only stale if nothing is still working on it:
 *
 * 1. **Old enough.** A turn can legitimately stream for minutes; the window is
 *    generous because closing a live attempt is worse than closing a dead one
 *    late.
 * 2. **No lease.** A live request holds a concurrency lease and renews it. A
 *    lease that is gone means no process is claiming this turn.
 * 3. **Its reservation is finished or expired.** The money is the last thing
 *    to move, so a reservation still `reserved` and unexpired means the turn
 *    may yet settle -- and a sweep that closed the attempt first would race the
 *    settlement that was about to.
 *
 * `closeAttempt` is a compare-and-set on `pending`, so even if all three are
 * wrong the sweep and the live request cannot both win.
 */

import { costIntentFor } from "@/lib/chatProviderHolds";
import { deserializeReservation } from "@/lib/chatSecurity";
import type { AiModel } from "@/lib/models";
import { prisma } from "@/lib/prisma";
import { recordInternalProviderUsage } from "@/lib/providerUsageAccounting";
import { closeAttempt } from "@/lib/routingAttemptStore";

/** How long an attempt may stay open before the sweep will consider it. */
export const STALE_ATTEMPT_AFTER_MS = 30 * 60 * 1000;

/** Recorded on every row this sweep writes, so a later fix is attributable. */
export const SWEEP_VERSION = "attempt-sweep-v1";

/** Bounded so one sweep cannot hold a connection for an unbounded time. */
export const STALE_ATTEMPT_SWEEP_BATCH = 200;

export type StaleAttemptSweepResult = {
    examined: number;
    closed: number;
    /** Lost the compare-and-set: the live request closed it first. */
    alreadyClosed: number;
    /** Cost rows written at the reserved upper bound. */
    costRecorded: number;
    failed: number;
};

type SweepRow = {
    id: string;
    runId: string;
    attemptIndex: number;
    subjectKey: string | null;
    reservationId: string | null;
};

export const sweepStaleRoutingAttempts = async (
    now = new Date(),
    batch = STALE_ATTEMPT_SWEEP_BATCH
): Promise<StaleAttemptSweepResult> => {
    const cutoff = new Date(now.getTime() - STALE_ATTEMPT_AFTER_MS);
    const limit = Math.min(1_000, Math.max(1, batch));

    // Dispatched, old, no live lease, and its reservation is done or expired.
    // Written as one query so the three conditions are evaluated against one
    // snapshot rather than three reads that can disagree between them.
    const rows = await prisma.$queryRaw<SweepRow[]>`
        SELECT a."id", a."runId", a."attemptIndex", r."subjectKey", r."reservationId"
        FROM "RoutingAttempt" a
        JOIN "RoutingRun" r ON r."id" = a."runId"
        LEFT JOIN "ChatCreditReservation" c ON c."id" = r."reservationId"
        WHERE a."outcome" = 'pending'
          AND a."dispatchedAt" IS NOT NULL
          AND a."createdAt" < ${cutoff}
          AND NOT EXISTS (
              SELECT 1 FROM "ChatRequestLease" l
              WHERE l."subjectKey" = r."subjectKey"
          )
          AND (
              c."id" IS NULL
              OR c."status" <> 'reserved'
              OR c."expiresAt" <= ${now}
          )
        ORDER BY a."createdAt" ASC
        LIMIT ${limit}
    `;

    let closed = 0;
    let alreadyClosed = 0;
    let costRecorded = 0;
    let failed = 0;
    for (const row of rows) {
        try {
            const won = await closeAttempt({
                attemptId: row.id,
                outcome: "unknown_after_dispatch",
                failureLayer: "process",
                errorClass: "process_stopped_after_dispatch",
            });
            if (!won) {
                alreadyClosed += 1;
                continue;
            }
            closed += 1;
            if (await recordCrashCost(row)) costRecorded += 1;
        } catch (error) {
            failed += 1;
            console.error(
                JSON.stringify({
                    event: "routing_attempt_sweep_failed",
                    attemptId: row.id,
                    error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
                })
            );
        }
    }

    return { examined: rows.length, closed, alreadyClosed, costRecorded, failed };
};

/**
 * What a crashed attempt cost, as far as anyone can honestly say.
 *
 * Not zero. The dispatch was recorded, so the provider was called and was
 * paid; writing 0 would be a claim that a call which demonstrably happened
 * used nothing, and provider budgets and cost dashboards read this ledger.
 *
 * What is written instead is the attempt's own reserved cost -- the upper
 * bound it was authorized to spend -- with `costSource: reserved_upper_bound`
 * and `usageSource: crash_reconciliation` saying exactly that. Token counts
 * stay NULL rather than being invented: an estimate of the cost is defensible
 * because the money was really committed, and an estimate of the tokens is
 * just a number nobody measured.
 *
 * Silent when there is no reservation (nothing was committed), no cost intent
 * (a payload written before intents existed, which cannot be reconstructed),
 * or a row already exists (the settlement got there first).
 */
const recordCrashCost = async (row: SweepRow): Promise<boolean> => {
    if (!row.reservationId) return false;
    try {
        const reservation = await prisma.chatCreditReservation.findUnique({
            where: { id: row.reservationId },
        });
        if (!reservation) return false;
        const canonical = deserializeReservation(reservation.reservationPayload);
        const intent = costIntentFor(canonical.attemptCostIntents, row.attemptIndex);
        if (!intent) return false;

        const reservationId = row.reservationId;
        return await prisma.$transaction(async (tx) => {
            const written = await tx.chatAttemptUsage.createMany({
                skipDuplicates: true,
                data: [
                    {
                        reservationId,
                        attemptIndex: row.attemptIndex,
                        modelId: intent.modelId,
                        provider: intent.provider,
                        outcome: "unknown_after_dispatch",
                        inputTokens: null,
                        cachedInputTokens: null,
                        outputTokens: null,
                        costMicroUsd: BigInt(intent.reservedCostMicroUsd),
                        usageSource: "crash_reconciliation",
                        costSource: "reserved_upper_bound",
                        pricingSnapshot: {
                            ...intent,
                            sweptBy: SWEEP_VERSION,
                            reconciledAt: new Date().toISOString(),
                        },
                    },
                ],
            });
            if (written.count !== 1) return false;

            // The rollup moves with the row, in the same transaction.
            //
            // Not optional, and not deferrable to whoever finds the real usage
            // later: a correction is applied as a *delta* against what this row
            // already claimed, so a rollup that never received the estimate
            // would be short by it for ever once the delta landed.
            //
            // Zero tokens and a zero component breakdown, with the whole figure
            // in the total. The money is known -- it was committed -- and the
            // split between cached input, uncached input and output is not.
            // Apportioning it would be inventing three numbers to make one look
            // complete.
            await recordInternalProviderUsage({
                client: tx,
                provider: intent.provider as AiModel["provider"],
                modelId: intent.modelId,
                inputTokens: 0,
                cachedInputTokens: 0,
                outputTokens: 0,
                estimatedCostMicroUsd: intent.reservedCostMicroUsd,
                uncachedInputCostMicroUsd: 0,
                cachedInputCostMicroUsd: 0,
                outputCostMicroUsd: 0,
            });
            return true;
        });
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "routing_attempt_sweep_cost_failed",
                attemptId: row.id,
                error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
            })
        );
        return false;
    }
};

/**
 * What the sweep has left to do, and how far behind it is.
 *
 * Backlog alone answers "is there work"; the age answers "how long has an
 * attempt been unclassified", which is the number that says whether the sweep
 * is running at all. A backlog of zero on a sweep that never runs looks
 * identical to a backlog of zero on one that keeps up.
 */
export const staleAttemptBacklog = async (now = new Date()) => {
    const cutoff = new Date(now.getTime() - STALE_ATTEMPT_AFTER_MS);
    const rows = await prisma.$queryRaw<
        { backlog: bigint; oldest_ms: number | null }[]
    >`
        SELECT
            COUNT(*)::bigint AS backlog,
            MAX(EXTRACT(EPOCH FROM (${now}::timestamp - a."createdAt")) * 1000)::float
                AS oldest_ms
        FROM "RoutingAttempt" a
        WHERE a."outcome" = 'pending'
          AND a."dispatchedAt" IS NOT NULL
          AND a."createdAt" < ${cutoff}
    `;
    const row = rows[0];
    return {
        backlog: Number(row?.backlog ?? 0),
        oldestPendingMs: row?.oldest_ms == null ? null : Math.round(row.oldest_ms),
    };
};
