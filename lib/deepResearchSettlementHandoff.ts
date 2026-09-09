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
