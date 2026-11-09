import "server-only";
import { prisma } from "@/lib/prisma";
import {
  responseLatencyDimensionsSchema, responseLatencyOutcomeSchema, responseLatencyTimingsSchema,
  summarizeResponseLatency, type ResponseLatencySample,
} from "@/lib/responseLatencyCore";

const RETENTION_MS = 7 * 86_400_000;
const MAX_ROWS = 1_500;

/** Best effort diagnostics, deliberately outside the response's critical path. */
export async function recordResponseLatency(id: string, sample: ResponseLatencySample) {
  if (process.env.E2E_DISABLE_DATABASE === "true") return;
  try {
    const dimensions = responseLatencyDimensionsSchema.parse({
      product: sample.product, mode: sample.mode, modelId: sample.modelId, provider: sample.provider,
    });
    await prisma.responseLatencySample.createMany({
      data: [{ id, ...dimensions, source: sample.source,
        outcome: responseLatencyOutcomeSchema.parse(sample.outcome),
        timings: responseLatencyTimingsSchema.parse(sample.timings) }],
      skipDuplicates: true,
    });
  } catch {
    console.warn(JSON.stringify({ event: "response_latency_record_failed", source: sample.source }));
  }
}

export async function readResponseLatencyEvidence(now = new Date()) {
  try {
    const since = new Date(now.getTime() - RETENTION_MS);
    const [rows, reviews] = await Promise.all([
      prisma.responseLatencySample.findMany({ where: { createdAt: { gte: since } },
        orderBy: { createdAt: "desc" }, take: MAX_ROWS + 1,
        select: { product: true, mode: true, source: true, modelId: true, provider: true, outcome: true, timings: true } }),
      prisma.comparisonReviewRun.findMany({ where: { startedAt: { gte: since } },
        orderBy: { startedAt: "desc" }, take: 501,
        select: { outcome: true, durationMs: true, primaryDurationMs: true, primaryStatus: true, primaryModelId: true, primaryProvider: true } }),
    ]);
    const samples: ResponseLatencySample[] = rows.slice(0, MAX_ROWS).flatMap(row => {
      const dimensions = responseLatencyDimensionsSchema.safeParse({ product: row.product, mode: row.mode, modelId: row.modelId, provider: row.provider });
      const timings = responseLatencyTimingsSchema.safeParse(row.timings);
      const outcome = responseLatencyOutcomeSchema.safeParse(row.outcome);
      return dimensions.success && timings.success && outcome.success && ["server", "client"].includes(row.source)
        ? [{ ...dimensions.data, source: row.source as "server" | "client", outcome: outcome.data, timings: timings.data }] : [];
    });
    for (const row of reviews.slice(0, 500)) samples.push({
      product: "review", mode: "cross_review", source: "review", modelId: row.primaryModelId, provider: row.primaryProvider,
      outcome: row.outcome === "completed_dual" ? "completed" : row.outcome === "completed_primary_only" ? "primary_only" : row.outcome === "cached" ? "cached" : "failed",
      // An attempt's duration does not include earlier failed candidates, so it
      // must not be presented as submit-to-first-review.
      timings: { reviewMs: row.durationMs },
    });
    return { status: "available" as const, windowDays: 7,
      truncated: rows.length > MAX_ROWS || reviews.length > 500,
      ...summarizeResponseLatency(samples) };
  } catch {
    return { status: "unavailable" as const, windowDays: 7 };
  }
}

export async function purgeResponseLatencySamples(now = new Date()) {
  return prisma.responseLatencySample.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - RETENTION_MS) } } });
}
