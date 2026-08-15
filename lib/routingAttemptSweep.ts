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
import { Prisma } from "@prisma/client";

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
     *
     * The total alone cannot carry an alarm, which is what `noCostReasons`
     * is for: one of its reasons is intended, one is history that ages out,
     * and the rest are defects. Alerting on the sum would either shout about
     * instrumentation-only runs or stay silent about a broken writer.
     */
    closedWithoutCostIntent: number;
    /** The same total, split by why nothing could be priced. */
    noCostReasons: NoCostReasonCounts;
    /**
     * Which models reserved nothing, as `provider/modelId` counts.
     *
     * The reason this is not buried in a per-occurrence log line. A free model
     * and a price an administrator flattened to zero are indistinguishable
     * from inside the sweep, and the difference between them is which model it
     * is -- so the models are what the run reports. One name appearing here
     * that nobody meant to be free is the whole signal.
     */
    zeroReservedCostModels: Record<string, number>;
    /**
     * Closed, and the cost writer returned something the sweep cannot produce.
     *
     * `corrected`, `adjustment_pending` and `identity_mismatch` all describe a
     * cost row this call did not write for a reason that is not a race and not
     * a missing intent. None of them is reachable from here today -- the sweep
     * writes a reserved upper bound, and a guess is refused before it can
     * correct anything -- so a non-zero count means either the ledger grew a
     * path nobody expected or this sweep started producing a record it should
     * not. Counted rather than folded into a success for exactly that reason.
     */
    unexpectedCostOutcome: number;
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

/**
 * When cost intents began being written, as an ISO timestamp.
 *
 * A reservation created before this cannot carry one, and a sweep that finds
 * none is describing history rather than a defect. A reservation created after
 * it and carrying none is a defect, with no grace period: the writer that was
 * supposed to record the intent did not.
 *
 * Unset is neither. It is not treated as "everything is legacy" -- that would
 * silently disable the alarm this distinction exists to raise -- but as its
 * own unclassified state, reported so the missing configuration is the thing
 * an operator sees.
 */
export const COST_INTENT_CUTOVER_ENV = "AUTO_ROUTER_COST_INTENT_CUTOVER_AT";

const costIntentCutover = (): Date | null => {
    const raw = process.env[COST_INTENT_CUTOVER_ENV]?.trim();
    if (!raw) return null;
    const parsed = new Date(raw);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
};

/**
 * What acquisition would have reserved, recomputed from the frozen payload.
 *
 * Deliberately the same arithmetic `getChatBudgetReservedCostMicroUsd` uses --
 * `Math.ceil` per component -- because the question is exactly "would the
 * `reservedCost > 0` guard have taken a hold". Rounding up means any positive
 * rate on a positive token count reserves at least one micro-dollar, so zero
 * here is only reachable when every applicable rate is zero.
 *
 * Answerable only for attempt 0, whose price the reservation froze. A fallback
 * ran on a model the payload does not carry the rates for, so its own intent
 * is the only record -- and if that is missing, the reservation cannot say
 * what it would have been.
 */
const frozenReservedCostMicroUsd = (
    canonical: { inputTokens: number; reservedOutputTokens: number; inputUsdPerMillionTokens: number; outputUsdPerMillionTokens: number },
    attemptIndex: number
): number => {
    if (attemptIndex !== 0) return 0;
    return (
        Math.ceil(canonical.inputTokens * canonical.inputUsdPerMillionTokens) +
        Math.ceil(
            canonical.reservedOutputTokens * canonical.outputUsdPerMillionTokens
        )
    );
};

/** Why an attempt was closed without a cost row. */
export type NoCostReason =
    /** No reservation at all: an instrumentation-only run. Intended. */
    | "no_reservation"
    /** Created before cost intents existed. History, and it ages out. */
    | "legacy_missing_cost_intent"
    /** Created after the cutover and carrying no intent. A defect. */
    | "missing_cost_intent"
    /**
     * Nothing was reserved for this attempt, so there is no intent to carry.
     *
     * Not "the call was free" -- it is the narrower fact that the provider
     * budget had zero reserved against it, which every rate being zero is the
     * only way to reach: `microdollarsFor` rounds up, so any positive rate on
     * a positive token count reserves at least one micro-dollar. A native web
     * search's own per-call charge is outside this and is not covered by it.
     *
     * Counted rather than alerted per occurrence -- a turn with nothing
     * reserved has nothing the sweep could have recorded -- but the models it
     * happens on are reported, because "every call on this model is free" is
     * usually a bad price override rather than a free model.
     */
    | "zero_reserved_provider_cost"
    /**
     * A reservation that froze a positive cost and holds nothing for it.
     *
     * The two are written together under one condition, so this combination
     * means one of them was lost. Money was authorized and the record of what
     * it authorized is gone.
     */
    | "invalid_zero_cost_reservation"
    /** No cutover is configured, so the two above cannot be told apart. */
    | "unclassified_missing_cost_intent"
    /** The run points at a reservation row that is not there. */
    | "dangling_reservation"
    /** The payload would not validate. A defect happening now. */
    | "invalid_cost_intent_payload";

export type NoCostReasonCounts = Record<NoCostReason, number>;

const emptyNoCostReasons = (): NoCostReasonCounts => ({
    no_reservation: 0,
    legacy_missing_cost_intent: 0,
    missing_cost_intent: 0,
    zero_reserved_provider_cost: 0,
    invalid_zero_cost_reservation: 0,
    unclassified_missing_cost_intent: 0,
    dangling_reservation: 0,
    invalid_cost_intent_payload: 0,
});

/**
 * Exactly what the sweep will act on, as one predicate used by both readers.
 *
 * Written once and shared because a backlog that counts something else is
 * worse than no backlog: `staleAttemptBacklog` used to check age alone, so a
 * deep-research turn legitimately streaming past thirty minutes counted as
 * work the sweep had not got to. An alarm on that number would fire on healthy
 * traffic.
 */
const eligibleStaleAttempts = (now: Date, cutoff: Date) => Prisma.sql`
    a."outcome" = 'pending'
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
`;

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
        WHERE ${eligibleStaleAttempts(now, cutoff)}
        ORDER BY a."createdAt" ASC
        LIMIT ${limit}
    `;

    let closedCostInserted = 0;
    let closedWithExistingCost = 0;
    let closedWithoutCostIntent = 0;
    let unexpectedCostOutcome = 0;
    let alreadyClosed = 0;
    const noCostReasons = emptyNoCostReasons();
    const zeroReservedCostModels: Record<string, number> = {};
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
            // The reason travels back through a holder rather than the return
            // value, because `resolveCost` owes its caller a cost record and
            // nothing else. Only read when the record came back null.
            const noCost: { reason?: NoCostReason; model?: string } = {};
            const closed = await closeAttemptWithCost({
                attemptId: row.id,
                outcome: "unknown_after_dispatch",
                failureLayer: "process",
                errorClass: "process_stopped_after_dispatch",
                resolveCost: (tx) => crashCostRecord(tx, row, noCost),
            });
            if (!closed.closed) {
                alreadyClosed += 1;
                continue;
            }
            // Counted from what was written, not from what was attempted, and
            // every outcome named. The `default` is unreachable by
            // construction -- `never` makes adding a sixth outcome a compile
            // error here rather than a silent extra success.
            switch (closed.cost) {
                case "inserted":
                    closedCostInserted += 1;
                    break;
                case "duplicate":
                    closedWithExistingCost += 1;
                    break;
                case "skipped":
                    closedWithoutCostIntent += 1;
                    noCostReasons[noCost.reason ?? "no_reservation"] += 1;
                    if (noCost.model) {
                        zeroReservedCostModels[noCost.model] =
                            (zeroReservedCostModels[noCost.model] ?? 0) + 1;
                    }
                    break;
                case "corrected":
                case "adjustment_pending":
                case "identity_mismatch":
                    unexpectedCostOutcome += 1;
                    console.error(
                        JSON.stringify({
                            event: "routing_attempt_sweep_unexpected_cost_outcome",
                            attemptId: row.id,
                            outcome: closed.cost,
                        })
                    );
                    break;
                default: {
                    const unreachable: never = closed.cost;
                    unexpectedCostOutcome += 1;
                    console.error(
                        JSON.stringify({
                            event: "routing_attempt_sweep_unexpected_cost_outcome",
                            attemptId: row.id,
                            outcome: String(unreachable),
                        })
                    );
                }
            }
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
        noCostReasons,
        zeroReservedCostModels,
        unexpectedCostOutcome,
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
    row: SweepRow,
    noCost: { reason?: NoCostReason; model?: string }
): Promise<AttemptCostRecord | null> => {
    const unavailable = (reason: NoCostReason, extra?: Record<string, unknown>) => {
        noCost.reason = reason;
        // `no_reservation` is the intended shape of an instrumentation-only
        // run, so it is counted and not logged. Every other reason is
        // something an operator may need to see the individual case for.
        if (reason !== "no_reservation") {
            console.error(
                JSON.stringify({
                    event: "routing_attempt_sweep_cost_unavailable",
                    reason,
                    attemptId: row.id,
                    reservationId: row.reservationId,
                    ...(extra ?? {}),
                })
            );
        }
        return null;
    };

    if (!row.reservationId) return unavailable("no_reservation");

    // Deliberately outside the try below. A read that fails is the database
    // being unavailable, and the caller has to see that as a failure -- the
    // throw takes the close back with it and leaves the attempt `pending` for
    // the next sweep. Swallowing it would close the attempt with no cost row,
    // which nothing can ever rebuild.
    const reservation = await tx.chatCreditReservation.findUnique({
        where: { id: row.reservationId },
    });
    if (!reservation) {
        // The row is gone while a run still points at it. Not history and not
        // a payload defect: a reference with nothing behind it.
        return unavailable("dangling_reservation");
    }

    let intent: AttemptCostIntent | null = null;
    let canonical: ReturnType<typeof deserializeReservation> | null = null;
    try {
        // Pure validation of a payload already in hand. This is the only thing
        // the catch below may be about, which is what makes the reason it logs
        // mean something.
        canonical = deserializeReservation(reservation.reservationPayload);
        intent = costIntentFor(canonical.attemptCostIntents, row.attemptIndex);
    } catch (error) {
        return unavailable("invalid_cost_intent_payload", {
            error: error instanceof Error ? error.message.slice(0, 300) : "unknown",
        });
    }

    if (!intent) {
        // Four different facts arrive here, and only two of them are defects.
        //
        // The shape of the payload decides first. A payload with no
        // `attemptHolds` field at all predates the field: history before the
        // cutover, and after it a writer producing the old shape, which is a
        // defect. A payload that *has* the field and no hold for this attempt
        // reserved nothing for it -- and whether that is fine depends on
        // whether it froze a cost it then failed to hold.
        //
        // Per attempt index, never on the array being empty: a fallback turn
        // has a hold for the other attempt, and asking whether the list is
        // empty would call that "reserved" for an attempt that reserved
        // nothing.
        if (!canonical || !canonical.attemptHolds) {
            const cutover = costIntentCutover();
            if (!cutover) {
                return unavailable("unclassified_missing_cost_intent", {
                    configured: COST_INTENT_CUTOVER_ENV,
                });
            }
            return unavailable(
                reservation.createdAt < cutover
                    ? "legacy_missing_cost_intent"
                    : "missing_cost_intent",
                { reservationCreatedAt: reservation.createdAt.toISOString() }
            );
        }

        const heldForAttempt = canonical.attemptHolds.some(
            (hold) => hold.attemptIndex === row.attemptIndex
        );
        // A hold with no intent never reaches here: the payload validator
        // refuses that pair on read, and the catch above reported it. Kept as
        // a named outcome so a validator that ever stops refusing it does not
        // land silently in the benign branch below.
        if (heldForAttempt) {
            return unavailable("invalid_cost_intent_payload", {
                detail: "hold without intent survived validation",
            });
        }

        // Nothing held. The only defensible reason is that nothing was
        // reservable: the reservation's own frozen price, recomputed exactly
        // as acquisition computed it, comes to zero. Anything else means a
        // reservation authorized money and lost the record of it.
        const frozen = frozenReservedCostMicroUsd(canonical, row.attemptIndex);
        if (frozen > 0) {
            return unavailable("invalid_zero_cost_reservation", {
                frozenReservedCostMicroUsd: frozen,
            });
        }
        noCost.model = `${canonical.provider}/${canonical.modelId}`;
        return unavailable("zero_reserved_provider_cost", {
            model: noCost.model,
        });
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
        { aged: bigint; eligible: bigint; oldest_ms: number | null }[]
    >`
        SELECT
            COUNT(*)::bigint AS aged,
            COUNT(*) FILTER (WHERE ${eligibleStaleAttempts(now, cutoff)})::bigint
                AS eligible,
            MAX(EXTRACT(EPOCH FROM (${now}::timestamp - a."createdAt")) * 1000)
                FILTER (WHERE ${eligibleStaleAttempts(now, cutoff)})::float
                AS oldest_ms
        FROM "RoutingAttempt" a
        JOIN "RoutingRun" r ON r."id" = a."runId"
        LEFT JOIN "ChatCreditReservation" c ON c."id" = r."reservationId"
        WHERE a."outcome" = 'pending'
          AND a."dispatchedAt" IS NOT NULL
          AND a."createdAt" < ${cutoff}
    `;
    const row = rows[0];
    return {
        /**
         * Old and still open, whether or not the sweep may touch it.
         *
         * Includes a turn legitimately streaming past the window -- deep
         * research does -- so it is a health number and never an alarm.
         */
        agedPending: Number(row?.aged ?? 0),
        /** What the sweep would act on right now. The number worth alarming on. */
        eligiblePending: Number(row?.eligible ?? 0),
        /** Age of the oldest eligible one, which says whether anything is getting through. */
        oldestEligibleMs: row?.oldest_ms == null ? null : Math.round(row.oldest_ms),
    };
};
