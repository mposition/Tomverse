import "server-only";

import { deserializeReservation, settleChatUsage } from "@/lib/chatSecurity";
import {
  deepResearchSettlementUsageSchema,
  type DeepResearchSettlementUsage,
} from "@/lib/deepResearchSettlementHandoff";
import { prisma } from "@/lib/prisma";
import { safeErrorMetadata } from "@/lib/providerErrorClassification";

export {
  deepResearchSettlementUsageSchema,
  findDeepResearchHandoff,
  serializeDeepResearchSettlementUsage,
  type DeepResearchSettlementUsage,
} from "@/lib/deepResearchSettlementHandoff";

/**
 * Exactly-once settlement for the one model that finishes after its request
 * has returned.
 *
 * Issue: https://github.com/mposition/Tomverse/issues/1285
 *
 * ## Two polls answering "completed" is not two claims
 *
 * `app/api/chat/deep-research/status/route.ts` has two paths that answer
 * `completed`, and only one of them settles anything.
 *
 * The **claim path** finalizes the job and the Message in a single
 * transaction whose `updateMany` is a compare-and-set on the job's status. A
 * second concurrent poll either sees `count: 0` or blocks until the first
 * commits and then sees `count: 0`; the loser returns `in_progress` and
 * settles nothing.
 *
 * The **cached path** runs before any of that: a poll whose first read already
 * finds a terminal job returns the stored outcome. That poll made no claim,
 * and answering `completed` is the correct answer to the caller, because the
 * job *is* completed.
 *
 * So a test that asserts "exactly one response said completed" is asserting a
 * scheduling accident. What must be exactly once is the **settlement**, and
 * that is enforced where it belongs: `settleChatUsage` takes an advisory lock
 * on the reservation and returns without applying anything unless the row is
 * still `reserved`. Every function here may therefore be called by any number
 * of racing pollers and by the sweep at the same time.
 *
 * ## Why a poll settles at all, rather than only the claimer
 *
 * Settlement runs after the finalize transaction commits, and has to -- it
 * takes the credit account lock, and holding that inside the finalize
 * transaction would serialize every poll of every job behind one account.
 * A process killed in that gap used to leave no way back: the poll holding
 * the provider's token counts had returned, and every later poll took the
 * cached early return, which never reached settlement. The reservation then
 * expired and `reconcileExpiredChatCreditReservations` settled it as `failed`
 * with zero tokens -- a full refund for a job that really ran and really cost
 * money, so the ledger recorded no cost and the user was under-charged.
 *
 * `PerplexityAsyncJob.settlementUsage` closes it. The finalize transaction
 * writes what settlement will need, and both the next poll and the sweep can
 * finish the job from stored fact. Presence of that column means "this job is
 * terminal and here is what it owes" -- never "it has been settled". Whether
 * it settled is the reservation's `status`, which stays the only place that
 * fact lives.
 *
 * ## Ordering is not the guarantee
 *
 * The sweep below runs before the expiry reconciliation in the fifteen-minute
 * maintenance route, and that is a preference, not a mechanism:
 * `lib/maintenance.ts` calls the expiry reconciliation on its own, and
 * `startScheduledJob` records a run rather than holding a lock, so nothing
 * stops the two passes overlapping. The guarantee lives in
 * `reconcileExpiredChatCreditReservations` itself, which looks for this
 * handoff before it refunds anything and settles at the real cost when it
 * finds one.
 */

export type DeepResearchSettlementOutcome =
  /** This call applied the settlement. */
  | { kind: "settled" }
  /** Somebody else got there first, and settled it the way this job says. */
  | { kind: "already_settled" }
  /**
   * Already terminal, and NOT as this job says it should have been -- a
   * pre-fix deployment refunded work that really ran. Unfixable here: the
   * money already moved and re-settling a terminal reservation is exactly
   * what the lock forbids. Reported so it is countable rather than invisible.
   */
  | {
      kind: "settlement_mismatch";
      storedOutcome: string;
      reservationOutcome: string | null;
    }
  /** No stored usage: a job still in flight, or one finalized before the column existed. */
  | { kind: "no_stored_usage" }
  /** Stored usage this deployment cannot read. Never guessed at. */
  | { kind: "unreadable" }
  /** The reservation row is gone. */
  | { kind: "missing_reservation" }
  /** Tried and failed. The caller decides whether that is fatal. */
  | { kind: "failed"; error: unknown };

const logSettlementEvent = (event: string, detail: Record<string, unknown>) => {
  console.error(
    JSON.stringify({ event, ...detail, timestamp: new Date().toISOString() })
  );
};

/**
 * Whether a reservation that is already terminal ended the way this job says
 * it should have.
 *
 * A job whose stored outcome is `completed` beside a reservation that was
 * refunded is the damage this fix arrives too late for. Nothing here can undo
 * it, but a count nobody can see is the state this whole issue was about, so
 * it is separated from the ordinary "somebody else settled it" case rather
 * than folded in with it.
 */
const terminalReservationOutcome = (
  job: { id: string; traceId?: string },
  usage: DeepResearchSettlementUsage,
  reservationOutcome: string | null
): DeepResearchSettlementOutcome => {
  const agrees =
    usage.outcome === "completed"
      ? reservationOutcome === "completed"
      : reservationOutcome !== "completed";
  if (agrees) return { kind: "already_settled" };
  logSettlementEvent("deep_research_settlement_mismatch", {
    jobId: job.id,
    traceId: job.traceId,
    storedOutcome: usage.outcome,
    reservationOutcome,
  });
  return {
    kind: "settlement_mismatch",
    storedOutcome: usage.outcome,
    reservationOutcome,
  };
};

/**
 * Settle one terminal job's reservation, if it still needs it.
 *
 * Safe to call from a poll, from the sweep, and from both at once. It never
 * throws -- settlement failing is a thing to report and retry, not a reason to
 * fail the poll that noticed, which has already answered the user's question
 * correctly. "Never throws" is a contract, so every database read is inside
 * the guard rather than only the settlement call: the reservation lookup sat
 * outside it once, and a dropped connection there would have escaped into the
 * route.
 */
export const settleDeepResearchJob = async (job: {
  id: string;
  reservationId: string;
  settlementUsage: unknown;
  traceId?: string;
}): Promise<DeepResearchSettlementOutcome> => {
  if (job.settlementUsage === null || job.settlementUsage === undefined) {
    // A job finalized before this column existed, or one still in flight.
    // Inventing numbers for it would be writing a charge nobody measured.
    return { kind: "no_stored_usage" };
  }
  const parsed = deepResearchSettlementUsageSchema.safeParse(
    job.settlementUsage
  );
  if (!parsed.success) {
    logSettlementEvent("deep_research_settlement_usage_unreadable", {
      jobId: job.id,
      traceId: job.traceId,
    });
    return { kind: "unreadable" };
  }

  try {
    const reservationRow = await prisma.chatCreditReservation.findUnique({
      where: { id: job.reservationId },
      select: { status: true, outcome: true, reservationPayload: true },
    });
    if (!reservationRow) {
      logSettlementEvent("deep_research_settlement_reservation_missing", {
        jobId: job.id,
        traceId: job.traceId,
      });
      return { kind: "missing_reservation" };
    }
    // Not the exactly-once guarantee -- settleChatUsage's own lock is. This
    // avoids taking that lock on the hot path, where a second open tab polls a
    // job that settled minutes ago and there is nothing to do.
    if (reservationRow.status !== "reserved") {
      return terminalReservationOutcome(
        job,
        parsed.data,
        reservationRow.outcome
      );
    }

    const result = await settleChatUsage(
      deserializeReservation(reservationRow.reservationPayload),
      {
        inputTokens: parsed.data.inputTokens,
        outputTokens: parsed.data.outputTokens,
        outcome: parsed.data.outcome,
      },
      {
        providerUsageSnapshot:
          (parsed.data.providerUsageSnapshot as never) ?? null,
      }
    );
    if (result.applied) return { kind: "settled" };
    // The race resolving under the lock: another poller or a sweep settled
    // between the read above and this call.
    return terminalReservationOutcome(job, parsed.data, result.status ?? null);
  } catch (error) {
    logSettlementEvent("deep_research_settlement_failed", {
      jobId: job.id,
      traceId: job.traceId,
      ...safeErrorMetadata(error),
    });
    return { kind: "failed", error };
  }
};

/**
 * How long a terminal job may sit unsettled before the sweep takes it.
 *
 * Zero would race the poll that is settling it right now -- harmlessly, since
 * both go through the same lock, but it would also report every healthy
 * settlement as a sweep recovery and make the count useless as a signal. One
 * minute is far longer than the gap between the finalize commit and the settle
 * call, and far shorter than the reservation TTL that would otherwise refund
 * the job.
 */
export const DEEP_RESEARCH_SETTLEMENT_GRACE_MS = 60_000;

export type DeepResearchSweepResult = {
  examined: number;
  settled: number;
  alreadySettled: number;
  settlementMismatch: number;
  unreadable: number;
  missingReservation: number;
  failed: number;
  /**
   * The sweep could not read its own work list.
   *
   * Its own field because `examined: 0, failed: 0` is also what a healthy pass
   * with nothing to do reports, and those two must never look the same: one
   * says the ledger is clean and the other says nobody knows.
   */
  queryFailed: boolean;
};

const EMPTY_SWEEP: DeepResearchSweepResult = {
  examined: 0,
  settled: 0,
  alreadySettled: 0,
  settlementMismatch: 0,
  unreadable: 0,
  missingReservation: 0,
  failed: 0,
  queryFailed: false,
};

/**
 * Finish the settlements that a killed process left open.
 *
 * ## Why the work list is selected on the reservation, not only on the job
 *
 * A settled job keeps its `settlementUsage`: the handoff is evidence of what a
 * recovered settlement was computed from, not a queue token, and clearing it
 * would delete the only record of that. So a query asking "terminal job with a
 * handoff, oldest first" would return the same long-settled rows every pass --
 * past `take`, the oldest N settled jobs starve every unsettled one behind
 * them forever while the sweep reports a clean `alreadySettled`.
 *
 * The backlog is therefore "jobs whose reservation is still `reserved`", which
 * is the real debt and shrinks as it is worked. `reservationId` is a plain
 * column with no Prisma relation, so the join is raw SQL; the predicate is the
 * point, not the syntax.
 */
export const reconcileUnsettledDeepResearchSettlements = async (
  now = new Date(),
  maximum = 200
): Promise<DeepResearchSweepResult> => {
  const limit = Math.min(1_000, Math.max(1, maximum));
  const cutoff = new Date(now.getTime() - DEEP_RESEARCH_SETTLEMENT_GRACE_MS);

  type SweepRow = {
    id: string;
    reservationId: string;
    settlementUsage: unknown;
    traceId: string;
  };
  let jobs: SweepRow[];
  try {
    jobs = await prisma.$queryRaw<SweepRow[]>`
      SELECT j."id", j."reservationId", j."settlementUsage", j."traceId"
      FROM "PerplexityAsyncJob" j
      JOIN "ChatCreditReservation" r ON r."id" = j."reservationId"
      WHERE j."status" IN ('completed', 'failed')
        AND j."settlementUsage" IS NOT NULL
        AND j."completedAt" <= ${cutoff}
        AND r."status" = 'reserved'
      ORDER BY j."completedAt" ASC
      LIMIT ${limit}
    `;
  } catch (error) {
    logSettlementEvent("deep_research_settlement_sweep_query_failed", {
      ...safeErrorMetadata(error),
    });
    return { ...EMPTY_SWEEP, queryFailed: true };
  }

  const result: DeepResearchSweepResult = {
    ...EMPTY_SWEEP,
    examined: jobs.length,
  };
  for (const job of jobs) {
    const outcome = await settleDeepResearchJob(job);
    switch (outcome.kind) {
      case "settled":
        result.settled += 1;
        break;
      case "already_settled":
        result.alreadySettled += 1;
        break;
      case "settlement_mismatch":
        result.settlementMismatch += 1;
        break;
      case "unreadable":
        result.unreadable += 1;
        break;
      case "missing_reservation":
        result.missingReservation += 1;
        break;
      case "failed":
        result.failed += 1;
        break;
      case "no_stored_usage":
        // Unreachable: the query requires a handoff. Counted rather than
        // dropped, because reaching it would mean the predicate and this loop
        // disagree about what was selected.
        result.unreadable += 1;
        break;
    }
  }
  return result;
};

/**
 * Never throws, so it cannot turn a successful maintenance pass into a failed
 * one -- and never reports silence as success either. A pass that could not
 * run says `queryFailed: true` rather than the `examined: 0, failed: 0` a
 * healthy pass with nothing to do also reports.
 */
export const reconcileUnsettledDeepResearchSettlementsQuietly =
  async (): Promise<DeepResearchSweepResult> =>
    reconcileUnsettledDeepResearchSettlements().catch((error) => {
      logSettlementEvent("deep_research_settlement_sweep_failed", {
        ...safeErrorMetadata(error),
      });
      return { ...EMPTY_SWEEP, queryFailed: true };
    });
