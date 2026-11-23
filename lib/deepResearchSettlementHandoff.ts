import "server-only";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

/**
 * What a terminal deep research job owes, and how to find it.
 *
 * Issue: https://github.com/mposition/Tomverse/issues/1285
 *
 * Deliberately a module with no dependency on `lib/chatSecurity.ts`. The
 * expiry reconciliation lives there and has to read this -- an expired
 * reservation whose job really completed must be settled at what it cost, not
 * refunded -- while the settlement side reads chatSecurity, so the shared
 * piece has to sit below both or the import graph closes into a cycle.
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

export type DeepResearchHandoff = {
  jobId: string;
  traceId: string;
  usage: DeepResearchSettlementUsage;
};

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

/**
 * The handoff a reservation's own deep research job left, if any.
 *
 * Used by the expiry reconciliation to answer "would refunding this be
 * wrong?", which it is exactly when a terminal job says the work really ran.
 * Returns `null` for every reservation that is not a deep research one, which
 * is nearly all of them, so the common path is one indexed lookup finding
 * nothing.
 */
/**
 * A Prisma client or an open transaction's client.
 *
 * The expiry reconciliation passes its transaction so the read happens under
 * the reservation lock that call already holds; everything else passes
 * nothing and gets the ordinary client.
 */
type JobReader = Pick<typeof prisma, "perplexityAsyncJob">;

export const findDeepResearchHandoff = async (
  reservationId: string,
  reader: JobReader = prisma
): Promise<DeepResearchHandoff | null> => {
  const job = await reader.perplexityAsyncJob.findFirst({
    where: {
      reservationId,
      status: { in: ["completed", "failed"] },
      settlementUsage: { not: Prisma.DbNull },
    },
    select: { id: true, traceId: true, settlementUsage: true },
  });
  if (!job) return null;
  const parsed = deepResearchSettlementUsageSchema.safeParse(
    job.settlementUsage
  );
  if (!parsed.success) {
    // Reported, never guessed at. A payload this cannot read is a payload
    // nothing may settle from, and saying so beats inventing a charge --
    // the caller then refunds, which is the conservative direction when the
    // record of what the job cost is unreadable.
    console.error(
      JSON.stringify({
        event: "deep_research_settlement_usage_unreadable",
        jobId: job.id,
        traceId: job.traceId,
        timestamp: new Date().toISOString(),
      })
    );
    return null;
  }
  return { jobId: job.id, traceId: job.traceId, usage: parsed.data };
};

// Research Preview shares this lower-level settlement adapter with async research.
export class ResearchPreviewRunError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
    this.name = "ResearchPreviewRunError";
  }
}

export type ResearchPreviewSettlementUsage = {
  inputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
  usageFromProvider: boolean;
  outcome: "completed" | "cancelled" | "failed" | "empty";
  searchSurchargeCredits?: number;
  searchExecuted?: boolean;
  searchQueryCount?: number;
  searchBackendRequestCount?: number;
  searchQueriesObserved: boolean;
};

const boundedCount = (value: unknown, maximum: number) =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum
    ? Number(value)
    : null;

export const parseResearchPreviewSettlementUsage = (
  value: unknown
): ResearchPreviewSettlementUsage | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const optionalToken = (entry: unknown) =>
    entry === undefined ? undefined : boundedCount(entry, Number.MAX_SAFE_INTEGER);
  const inputTokens = optionalToken(row.inputTokens);
  const cachedInputTokens = optionalToken(row.cachedInputTokens);
  const cacheWriteInputTokens = optionalToken(row.cacheWriteInputTokens);
  const outputTokens = optionalToken(row.outputTokens);
  const reasoningTokens = optionalToken(row.reasoningTokens);
  const searchQueryCount = optionalToken(row.searchQueryCount);
  const searchBackendRequestCount = optionalToken(row.searchBackendRequestCount);
  const searchSurchargeCredits = optionalToken(row.searchSurchargeCredits);
  if (
    [inputTokens, cachedInputTokens, cacheWriteInputTokens, outputTokens, reasoningTokens,
      searchQueryCount, searchBackendRequestCount, searchSurchargeCredits].some((entry) => entry === null) ||
    typeof row.usageFromProvider !== "boolean" ||
    typeof row.searchQueriesObserved !== "boolean" ||
    !["completed", "cancelled", "failed", "empty"].includes(String(row.outcome)) ||
    (row.searchExecuted !== undefined && typeof row.searchExecuted !== "boolean")
  ) return null;
  return {
    ...(typeof inputTokens === "number" ? { inputTokens } : {}),
    ...(typeof cachedInputTokens === "number" ? { cachedInputTokens } : {}),
    ...(typeof cacheWriteInputTokens === "number" ? { cacheWriteInputTokens } : {}),
    ...(typeof outputTokens === "number" ? { outputTokens } : {}),
    ...(typeof reasoningTokens === "number" ? { reasoningTokens } : {}),
    usageFromProvider: row.usageFromProvider,
    outcome: row.outcome as ResearchPreviewSettlementUsage["outcome"],
    ...(typeof searchSurchargeCredits === "number"
      ? { searchSurchargeCredits }
      : {}),
    ...(typeof row.searchExecuted === "boolean" ? { searchExecuted: row.searchExecuted } : {}),
    ...(typeof searchQueryCount === "number" ? { searchQueryCount } : {}),
    ...(typeof searchBackendRequestCount === "number"
      ? { searchBackendRequestCount }
      : {}),
    searchQueriesObserved: row.searchQueriesObserved,
  };
};

export async function stoppedResearchPreviewUsage(
  tx: Prisma.TransactionClient,
  run: { id: string; settlementUsage: unknown; searchSurchargeCredits: number },
  outcome: "cancelled" | "failed"
): Promise<ResearchPreviewSettlementUsage> {
  const unknown = await tx.researchPreviewGeneration.count({ where: {
    runId: run.id, status: { in: ["dispatch_started", "outcome_unknown"] },
  } });
  const saved = parseResearchPreviewSettlementUsage(run.settlementUsage);
  if (!unknown && saved) return { ...saved, outcome };
  const completed = await tx.researchPreviewGeneration.count({ where: { runId: run.id, status: "completed" } });
  if (unknown || completed > 0) return { usageFromProvider: false, outcome,
    searchSurchargeCredits: run.searchSurchargeCredits, searchQueriesObserved: false };
  return { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
    reasoningTokens: 0, usageFromProvider: true, outcome, searchSurchargeCredits: run.searchSurchargeCredits,
    searchExecuted: false, searchQueryCount: 0, searchBackendRequestCount: 0, searchQueriesObserved: true };
}

/** Called under the reservation settlement lock: active work can never become a zero refund. */
export async function researchPreviewSettlementForExpiry(
  tx: Prisma.TransactionClient, reservationId: string, now = new Date()
): Promise<ResearchPreviewSettlementUsage | null> {
  await tx.$queryRaw`SELECT "id" FROM "ResearchPreviewRun" WHERE "reservationId" = ${reservationId} FOR UPDATE`;
  const run = await tx.researchPreviewRun.findFirst({ where: { reservationId } });
  if (!run) return researchEngineSegmentSettlementForExpiry(tx, reservationId, now);
  if (!["completed", "failed", "cancelled", "attention"].includes(run.status)) {
    const neverStarted = run.status === "queued" && run.checkpoint === null && run.stepCount === 0;
    if (!["checkpointed", "queued"].includes(run.status) ||
        (!neverStarted && (!run.checkpointExpiresAt || run.checkpointExpiresAt > now))) {
      throw new ResearchPreviewRunError(409, "RESEARCH_RUN_STILL_ACTIVE", "Research owns this reservation until its work is finalized.");
    }
    const usage = await stoppedResearchPreviewUsage(tx, run, "failed");
    await tx.researchPreviewRun.update({ where: { id: run.id }, data: {
      status: "failed", stopReason: neverStarted ? "timeout" : "checkpoint_expired", checkpoint: Prisma.DbNull,
      checkpointExpiresAt: null, settlementUsage: JSON.parse(JSON.stringify(usage)) as Prisma.InputJsonValue,
      leaseOwner: null, leaseExpiresAt: null, activeDeadlineAt: null, completedAt: now,
    } });
    return usage;
  }
  return parseResearchPreviewSettlementUsage(run.settlementUsage) ??
    stoppedResearchPreviewUsage(tx, run, "failed");
}

/** Settles a Research engine v2 hold on which nothing was dispatched (one definition for worker, recovery and expiry). */
export const RESEARCH_ZERO_SETTLEMENT_USAGE = Object.freeze({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0,
  reasoningTokens: 0, usageFromProvider: true, outcome: "failed", searchExecuted: false, searchQueryCount: 0,
  searchBackendRequestCount: 0, searchQueriesObserved: true }) satisfies ResearchPreviewSettlementUsage;

/**
 * A hold that expires between its creation and its bind (the reservation's
 * traceId names the segment, but the segment names no reservation yet). Nothing
 * can have dispatched on it, since dispatch needs a bound segment. The segment is
 * fenced as released under the settlement lock, so the worker's later bind is
 * refused and the zero refund can never cover a model call.
 */
async function unboundResearchSegmentSettlementForExpiry(
  tx: Prisma.TransactionClient, reservationId: string
): Promise<ResearchPreviewSettlementUsage | null> {
  const reservation = await tx.chatCreditReservation.findUnique({ where: { id: reservationId }, select: { traceId: true } });
  if (!reservation?.traceId) return null;
  await tx.$queryRaw`SELECT "id" FROM "ResearchFundingSegment" WHERE "id" = ${reservation.traceId} FOR UPDATE`;
  const segment = await tx.researchFundingSegment.findUnique({ where: { id: reservation.traceId }, select: { id: true, status: true, reservationId: true } });
  if (!segment || segment.reservationId !== null) return null;
  if (segment.status === "reserving") await tx.researchFundingSegment.update({ where: { id: segment.id }, data: { status: "released" } });
  return { ...RESEARCH_ZERO_SETTLEMENT_USAGE };
}

/**
 * Research engine v2 holds one Chat reservation per funding segment. Expiry may
 * settle such a reservation only from facts the segment already records:
 * a dispatch that may still be running keeps the hold, an unknown outcome is
 * settled conservatively, and a segment that never dispatched is a zero.
 * Called under the reservation settlement lock, before any write.
 */
async function researchEngineSegmentSettlementForExpiry(
  tx: Prisma.TransactionClient, reservationId: string, now: Date
): Promise<ResearchPreviewSettlementUsage | null> {
  await tx.$queryRaw`SELECT "id" FROM "ResearchFundingSegment" WHERE "reservationId" = ${reservationId} FOR UPDATE`;
  const segment = await tx.researchFundingSegment.findFirst({ where: { reservationId },
    include: { generations: { select: { kind: true, status: true } } } });
  if (!segment) return unboundResearchSegmentSettlementForExpiry(tx, reservationId);
  if (segment.status === "settled") return parseResearchPreviewSettlementUsage(segment.settlementUsage);
  if (segment.runId === null && segment.status !== "released") {
    // The run (and its dispatch rows) was deleted with its conversation or account.
    // Whether the hold was dispatched can no longer be shown, so it is charged as unknown, never refunded.
    await tx.researchFundingSegment.update({ where: { id: segment.id }, data: { status: "settled", settledCredits: segment.reservedCredits,
      settledAt: now, settlementUsage: { usageFromProvider: false, outcome: "failed", searchQueriesObserved: false, settledBy: "expiry_orphaned" } } });
    return { usageFromProvider: false, outcome: "failed", searchQueriesObserved: false };
  }
  if (segment.status === "unknown") {
    await tx.researchFundingSegment.update({ where: { id: segment.id }, data: { status: "settled", settledCredits: segment.reservedCredits,
      settledAt: now, settlementUsage: { usageFromProvider: false, outcome: "failed", searchQueriesObserved: false, settledBy: "expiry" } } });
    return { usageFromProvider: false, outcome: "failed", searchQueriesObserved: false };
  }
  const dispatched = segment.generations.some((generation) => generation.status !== "intent" && generation.status !== "dispatch_refused");
  if (segment.status === "released" || !dispatched) {
    if (segment.generations.some((generation) => generation.status === "intent") && segment.status === "reserved") {
      throw new ResearchPreviewRunError(409, "RESEARCH_RUN_STILL_ACTIVE", "Research owns this reservation until its dispatch is decided.");
    }
    await tx.researchFundingSegment.update({ where: { id: segment.id }, data: { status: "released" } });
    return { ...RESEARCH_ZERO_SETTLEMENT_USAGE };
  }
  throw new ResearchPreviewRunError(409, "RESEARCH_RUN_STILL_ACTIVE", "Research owns this reservation until its work is settled.");
}
