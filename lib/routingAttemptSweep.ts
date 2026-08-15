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

import {
    closeAttemptWithCost,
    type AttemptCostRecord,
} from "@/lib/chatAttemptCostLedger";
import { costIntentFor, type AttemptCostIntent } from "@/lib/chatProviderHolds";
import { deserializeReservation } from "@/lib/chatSecurity";
import type { AiModel } from "@/lib/models";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";

/** How long an attempt may stay open before the sweep will consider it. */
export const STALE_ATTEMPT_AFTER_MS = 30 * 60 * 1000;

/** Recorded on every row this sweep writes, so a later fix is attributable. */
export const SWEEP_VERSION = "attempt-sweep-v1";

/** Bounded so one sweep cannot hold a connection for an unbounded time. */
export const STALE_ATTEMPT_SWEEP_BATCH = 200;

export type StaleAttemptSweepResult = {
    examined: number;
    /** Closed with the reserved upper bound written by this call. */
    closedCostInserted: number;
    /**
     * Closed, and a cost row was already there.
     *
     * A normal race, not a loss: settlement got to the row first, so the spend
     * is recorded and this call had nothing to add. Counted apart from
     * `closedCostInserted` because this call wrote no cost, and apart from
     * `closedWithoutCostIntent` because the cost is not missing.
     */
    closedWithExistingCost: number;
    /**
     * Closed with no cost row, because nothing could honestly price it.
     *
     * Counted apart from the two above on purpose. These are attempts whose
     * provider spend nobody can now state, and folding them into a success
     * count would report a permanent hole in the ledger as an ordinary sweep.
     */
    closedWithoutCostIntent: number;
    /** Lost the compare-and-set: the live request closed it first. */
    alreadyClosed: number;
    /**
     * Neither closed nor recorded, and still `pending`.
     *
     * The transaction took the close back with whatever failed, which is the
     * point of binding them: a database that is briefly unavailable costs a
     * delay until the next sweep, not a record nobody can rebuild.
     */
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

    let closedCostInserted = 0;
    let closedWithExistingCost = 0;
    let closedWithoutCostIntent = 0;
    let alreadyClosed = 0;
    let failed = 0;
    for (const row of rows) {
        try {
            // The reservation is read inside the transaction that closes the
            // attempt, not before it. Two reasons, and both are failure modes
            // that reading first would leave open: the payload can change
            // between a read and a write, and a read that fails outside the
            // transaction cannot take the close back with it -- so a database
            // blip would close the attempt with no cost row, permanently,
            // because the sweep only ever looks at `pending` again.
            const closed = await closeAttemptWithCost({
                attemptId: row.id,
                outcome: "unknown_after_dispatch",
                failureLayer: "process",
                errorClass: "process_stopped_after_dispatch",
                resolveCost: (tx) => crashCostRecord(tx, row),
            });
            if (!closed.closed) {
                alreadyClosed += 1;
                continue;
            }
            // Counted from what was written, not from what was attempted.
            if (closed.cost === "inserted") closedCostInserted += 1;
            else if (closed.cost === "skipped") closedWithoutCostIntent += 1;
            else closedWithExistingCost += 1;
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

    return {
        examined: rows.length,
        closedCostInserted,
        closedWithExistingCost,
        closedWithoutCostIntent,
        alreadyClosed,
        failed,
    };
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
 * Returns null when there is nothing that can honestly be priced, and says
 * which kind of nothing it was. A payload written before cost intents existed
 * is a known, closed set that shrinks to zero as those reservations age out; a
 * payload that fails to read is a defect happening now. Reporting both as
 * "swept" would hide the second inside the first.
 */
const crashCostRecord = async (
    tx: Prisma.TransactionClient,
    row: SweepRow
): Promise<AttemptCostRecord | null> => {
    // No reservation at all: an instrumentation-only run, with no money to
    // account for. Ordinary, and silent.
    if (!row.reservationId) return null;

    // Deliberately outside the try below. A read that fails is the database
    // being unavailable, and the caller has to see that as a failure -- the
    // throw takes the close back with it and leaves the attempt `pending` for
    // the next sweep. Swallowing it would close the attempt with no cost row,
    // which nothing can ever rebuild.
    const reservation = await tx.chatCreditReservation.findUnique({
        where: { id: row.reservationId },
    });
    if (!reservation) {
        // The row is gone while a run still points at it. Not the legacy case
        // and not a payload defect: a reference with nothing behind it.
        console.error(
            JSON.stringify({
                event: "routing_attempt_sweep_cost_unavailable",
                reason: "dangling_reservation",
                attemptId: row.id,
                reservationId: row.reservationId,
            })
        );
        return null;
    }

    let intent: AttemptCostIntent | null = null;
    try {
        // Pure validation of a payload already in hand. This is the only thing
        // the catch below may be about, which is what makes the reason it logs
        // mean something.
        const canonical = deserializeReservation(reservation.reservationPayload);
        intent = costIntentFor(canonical.attemptCostIntents, row.attemptIndex);
    } catch (error) {
        console.error(
            JSON.stringify({
                event: "routing_attempt_sweep_cost_unavailable",
                reason: "invalid_cost_intent_payload",
                attemptId: row.id,
                reservationId: row.reservationId,
                error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
            })
        );
        return null;
    }

    if (!intent) {
        console.warn(
            JSON.stringify({
                event: "routing_attempt_sweep_cost_unavailable",
                reason: "legacy_missing_cost_intent",
                attemptId: row.id,
                reservationId: row.reservationId,
            })
        );
        return null;
    }

    return {
        reservationId: row.reservationId,
        attempt: {
            attemptIndex: row.attemptIndex,
            price: {
                provider: intent.provider as AiModel["provider"],
                modelId: intent.modelId,
                inputUsdPerMillionTokens: intent.inputUsdPerMillionTokens,
                outputUsdPerMillionTokens: intent.outputUsdPerMillionTokens,
                cachedInputPriceMultiplier: intent.cachedInputPriceMultiplier,
                pricingVersion: intent.pricingVersion ?? null,
            },
            // Zero here, NULL in the row: `unknownTokens` strips them. Nothing
            // measured these, and the database refuses a non-crash row that
            // leaves them out.
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            usageFromProvider: false,
            outcome: "unknown_after_dispatch",
            costMicroUsd: intent.reservedCostMicroUsd,
            costSource: "reserved_upper_bound",
            userBilled: false,
        },
        snapshot: { sweptBy: SWEEP_VERSION },
        unknownTokens: true,
    };
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
