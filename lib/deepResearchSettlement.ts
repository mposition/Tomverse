import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { deserializeReservation, settleChatUsage } from "@/lib/chatSecurity";
import { prisma } from "@/lib/prisma";
import { safeErrorMetadata } from "@/lib/providerErrorClassification";

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
 */

/**
 * What a terminal deep research job owes.
 *
 * Deliberately the settlement inputs and nothing else -- no timestamps, no
 * status mirror, no copy of the report. Anything else recorded here would be a
 * second copy of something that already has an owner, and the value of this
 * column is that it is the one thing nowhere else holds.
 */
export const deepResearchSettlementUsageSchema = z
  .object({
    inputTokens: z.number().int().min(0).optional(),
    outputTokens: z.number().int().min(0).optional(),
    outcome: z.enum(["completed", "failed", "empty"]),
    /**
     * Perplexity's own reported cost for the job, when it reported one.
     *
     * Read back through the same schema that wrote it rather than trusted:
     * this is stored JSON, and a row written by an older deployment is not
     * required to match today's shape. `passthrough()` because the snapshot's
     * own fields belong to lib/perplexityUsageCore.ts, which validates them
     * where it consumes them; this schema's job is to refuse a value that is
     * not an object at all.
     */
    providerUsageSnapshot: z.object({}).passthrough().nullish(),
  })
  .strict();

export type DeepResearchSettlementUsage = z.infer<
  typeof deepResearchSettlementUsageSchema
>;

/**
 * The column value for a settlement payload.
 *
 * Not a cast. `undefined` is not JSON, and a Prisma `Json` field will not take
 * a shape that admits it -- so the absent fields are dropped here rather than
 * asserted away, and what lands in the column is exactly what
 * `deepResearchSettlementUsageSchema` will parse back out of it.
 */
export const serializeDeepResearchSettlementUsage = (
  usage: DeepResearchSettlementUsage
): Prisma.InputJsonObject => ({
  outcome: usage.outcome,
  ...(usage.inputTokens === undefined ? {} : { inputTokens: usage.inputTokens }),
  ...(usage.outputTokens === undefined
    ? {}
    : { outputTokens: usage.outputTokens }),
  ...(usage.providerUsageSnapshot === undefined ||
  usage.providerUsageSnapshot === null
    ? {}
    : {
        providerUsageSnapshot:
          usage.providerUsageSnapshot as Prisma.InputJsonObject,
      }),
});

export type DeepResearchSettlementOutcome =
  /** This call applied the settlement. */
  | { settled: true; alreadySettled: false }
  /** Somebody else got there first, or the reservation is already terminal. */
  | { settled: false; alreadySettled: true }
  /** Nothing to do: no stored usage, or no reservation row to settle. */
  | { settled: false; alreadySettled: false; reason: DeepResearchSettlementSkip }
  /** Tried and failed. The caller decides whether that is fatal. */
  | { settled: false; alreadySettled: false; reason: "error"; error: unknown };

export type DeepResearchSettlementSkip =
  | "no_stored_usage"
  | "unreadable_stored_usage"
  | "no_reservation";

/**
 * Settle one terminal job's reservation, if it still needs it.
 *
 * Safe to call from a poll, from the sweep, and from both at once. It never
 * throws: settlement failing is a thing to report and retry, not a reason to
 * fail the poll that noticed -- the caller has already answered the user's
 * question correctly, and the job's own row is not in doubt.
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
    return { settled: false, alreadySettled: false, reason: "no_stored_usage" };
  }
  const parsed = deepResearchSettlementUsageSchema.safeParse(job.settlementUsage);
  if (!parsed.success) {
    console.error(
      JSON.stringify({
        event: "deep_research_settlement_usage_unreadable",
        jobId: job.id,
        traceId: job.traceId,
        timestamp: new Date().toISOString(),
      })
    );
    return {
      settled: false,
      alreadySettled: false,
      reason: "unreadable_stored_usage",
    };
  }

  const reservationRow = await prisma.chatCreditReservation.findUnique({
    where: { id: job.reservationId },
    select: { status: true, reservationPayload: true },
  });
  if (!reservationRow) {
    return { settled: false, alreadySettled: false, reason: "no_reservation" };
  }
  // Not the guarantee -- settleChatUsage's own lock is. This only avoids
  // taking that lock on the hot path, where a second open tab polls a job
  // that settled minutes ago and there is nothing to do.
  if (reservationRow.status !== "reserved") {
    return { settled: false, alreadySettled: true };
  }

  try {
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
    // `applied: false` is the race resolving under the lock: another poller
    // or the sweep settled between the read above and this call.
    return result.applied
      ? { settled: true, alreadySettled: false }
      : { settled: false, alreadySettled: true };
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "deep_research_settlement_failed",
        jobId: job.id,
        traceId: job.traceId,
        ...safeErrorMetadata(error),
        timestamp: new Date().toISOString(),
      })
    );
    return { settled: false, alreadySettled: false, reason: "error", error };
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

/**
 * Finish the settlements that a killed process left open.
 *
 * Rides the fifteen-minute maintenance pass, and must run BEFORE
 * `reconcileExpiredChatCreditReservations` in it. Both are idempotent and
 * either order is safe, but they disagree about what a stuck deep research
 * reservation owes: this one settles it at what the job actually cost, and
 * that one refunds it in full. Running first means the true cost wins when
 * both would act.
 */
export const reconcileUnsettledDeepResearchSettlements = async (
  now = new Date(),
  maximum = 200
) => {
  const limit = Math.min(1_000, Math.max(1, maximum));
  const jobs = await prisma.perplexityAsyncJob.findMany({
    where: {
      status: { in: ["completed", "failed"] },
      settlementUsage: { not: Prisma.DbNull },
      completedAt: { lte: new Date(now.getTime() - DEEP_RESEARCH_SETTLEMENT_GRACE_MS) },
    },
    orderBy: [{ completedAt: "asc" }],
    take: limit,
    select: {
      id: true,
      reservationId: true,
      settlementUsage: true,
      traceId: true,
    },
  });

  let settled = 0;
  let alreadySettled = 0;
  let failed = 0;
  for (const job of jobs) {
    const outcome = await settleDeepResearchJob(job);
    if (outcome.settled) settled += 1;
    else if (outcome.alreadySettled) alreadySettled += 1;
    else if ("reason" in outcome && outcome.reason === "error") failed += 1;
  }
  return { examined: jobs.length, settled, alreadySettled, failed };
};

/** Never throws, so it cannot turn a successful maintenance pass into a failed one. */
export const reconcileUnsettledDeepResearchSettlementsQuietly = async () =>
  reconcileUnsettledDeepResearchSettlements().catch(() => ({
    examined: 0,
    settled: 0,
    alreadySettled: 0,
    failed: 0,
  }));
