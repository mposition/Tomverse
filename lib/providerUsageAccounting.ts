import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { AiModel } from "@/lib/models";

const dayStartUtc = (date = new Date()) =>
  new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));

const safeJsonPayload = (payload: unknown): Prisma.InputJsonValue | undefined => {
  if (!payload || typeof payload !== "object") return undefined;
  return JSON.parse(JSON.stringify(payload)) as Prisma.InputJsonValue;
};

export type ProviderUsageRecordInput = {
  provider: AiModel["provider"];
  modelId: string;
  inputTokens: number;
  cachedInputTokens: number;
  /**
   * Input tokens written into the prompt cache, priced at the write rate.
   *
   * Optional so every existing caller keeps compiling and keeps meaning what
   * it meant: a path that reports no write count wrote nothing, because until
   * Anthropic prompt caching no request could produce one.
   */
  cacheWriteInputTokens?: number;
  outputTokens: number;
  estimatedCostMicroUsd: number;
  uncachedInputCostMicroUsd: number;
  cachedInputCostMicroUsd: number;
  cacheWriteInputCostMicroUsd?: number;
  outputCostMicroUsd: number;
  date?: Date;
  /** Defaults to "internal" (non-billed internal calls, e.g. conversation
   *  titles). AUD-R001's synthetic provider probes pass "probe" so their
   *  cost stays queryable/cappable separately from other internal usage, and
   *  STG-R002's administrator verification calls pass "admin_verification";
   *  backend document conversion passes "ocr". These are never billed to a
   *  user or written to a credit ledger. */
  source?: "internal" | "probe" | "admin_verification" | "ocr";
};

export async function recordInternalProviderUsage({
  provider,
  modelId,
  inputTokens,
  cachedInputTokens,
  cacheWriteInputTokens = 0,
  outputTokens,
  estimatedCostMicroUsd,
  uncachedInputCostMicroUsd,
  cachedInputCostMicroUsd,
  cacheWriteInputCostMicroUsd = 0,
  outputCostMicroUsd,
  date,
  source = "internal",
  client,
}: ProviderUsageRecordInput & {
  /**
   * The transaction to record in, when the caller has one.
   *
   * This rollup is keyed on (provider, modelId, source, date) and has no
   * per-request identity, so nothing about the row itself can tell a repeated
   * increment from a new one. A caller that dedupes elsewhere -- chat
   * settlement dedupes on ChatAttemptUsage's (reservationId, attemptIndex) --
   * has to commit its dedupe record and this increment together, or a crash
   * between them leaves the rollup and the evidence for it disagreeing.
   */
  client?: Prisma.TransactionClient;
}) {
  const usageDate = dayStartUtc(date);
  const safeInputTokens = Math.max(0, Math.min(2_000_000_000, Math.round(inputTokens)));
  const safeOutputTokens = Math.max(0, Math.min(2_000_000_000, Math.round(outputTokens)));
  const safeCachedInputTokens = Math.min(
    safeInputTokens,
    Math.max(0, Math.min(2_000_000_000, Math.round(cachedInputTokens)))
  );
  // Bounded by the input tokens the reads have not already claimed, matching
  // `calculateProviderUsageCost`. The two clamps have to agree or the rollup's
  // token split stops summing to its own `inputTokens`.
  const safeCacheWriteInputTokens = Math.min(
    safeInputTokens - safeCachedInputTokens,
    Math.max(0, Math.min(2_000_000_000, Math.round(cacheWriteInputTokens)))
  );
  const safeCost = Math.max(0, Math.min(2_000_000_000, Math.round(estimatedCostMicroUsd)));
  const safeUncachedInputCost = Math.max(0, Math.min(2_000_000_000, Math.round(uncachedInputCostMicroUsd)));
  const safeCachedInputCost = Math.max(0, Math.min(2_000_000_000, Math.round(cachedInputCostMicroUsd)));
  const safeCacheWriteInputCost = Math.max(0, Math.min(2_000_000_000, Math.round(cacheWriteInputCostMicroUsd)));
  const safeOutputCost = Math.max(0, Math.min(2_000_000_000, Math.round(outputCostMicroUsd)));

  await (client ?? prisma).providerDailyUsage.upsert({
    where: {
      provider_modelId_source_date: {
        provider,
        modelId,
        source,
        date: usageDate,
      },
    },
    create: {
      provider,
      modelId,
      source,
      date: usageDate,
      requestCount: 1,
      inputTokens: safeInputTokens,
      cachedInputTokens: safeCachedInputTokens,
      cacheWriteInputTokens: safeCacheWriteInputTokens,
      outputTokens: safeOutputTokens,
      estimatedCostMicroUsd: safeCost,
      uncachedInputCostMicroUsd: safeUncachedInputCost,
      cachedInputCostMicroUsd: safeCachedInputCost,
      cacheWriteInputCostMicroUsd: safeCacheWriteInputCost,
      outputCostMicroUsd: safeOutputCost,
      syncedAt: new Date(),
    },
    update: {
      requestCount: { increment: 1 },
      inputTokens: { increment: safeInputTokens },
      cachedInputTokens: { increment: safeCachedInputTokens },
      cacheWriteInputTokens: { increment: safeCacheWriteInputTokens },
      outputTokens: { increment: safeOutputTokens },
      estimatedCostMicroUsd: { increment: safeCost },
      uncachedInputCostMicroUsd: { increment: safeUncachedInputCost },
      cachedInputCostMicroUsd: { increment: safeCachedInputCost },
      cacheWriteInputCostMicroUsd: { increment: safeCacheWriteInputCost },
      outputCostMicroUsd: { increment: safeOutputCost },
      syncedAt: new Date(),
    },
  });
}

export async function getInternalProviderUsageSummary({
  provider,
  date,
}: {
  provider: AiModel["provider"];
  date: Date;
}) {
  const usageDate = dayStartUtc(date);
  const aggregate = await prisma.providerDailyUsage.aggregate({
    where: { provider, source: { in: ["internal", "ocr"] }, date: usageDate },
    _sum: {
      requestCount: true,
      inputTokens: true,
      cachedInputTokens: true,
      cacheWriteInputTokens: true,
      outputTokens: true,
      estimatedCostMicroUsd: true,
    },
  });
  return {
    requestCount: aggregate._sum.requestCount || 0,
    inputTokens: aggregate._sum.inputTokens || 0,
    cachedInputTokens: aggregate._sum.cachedInputTokens || 0,
    cacheWriteInputTokens: aggregate._sum.cacheWriteInputTokens || 0,
    outputTokens: aggregate._sum.outputTokens || 0,
    estimatedCostMicroUsd: aggregate._sum.estimatedCostMicroUsd || 0,
  };
}

/**
 * Total synthetic-probe spend across every provider for a given UTC day.
 * Used by the AUD-R001 probe route to enforce a daily cost ceiling before
 * running each cycle -- deliberately summed across providers (not per
 * provider) since the cap is a single overall budget for probing, not a
 * per-provider one.
 */
export async function getProbeUsageCostTodayMicroUsd(date = new Date()): Promise<number> {
  const usageDate = dayStartUtc(date);
  const aggregate = await prisma.providerDailyUsage.aggregate({
    where: { source: "probe", date: usageDate },
    _sum: { estimatedCostMicroUsd: true },
  });
  return aggregate._sum.estimatedCostMicroUsd || 0;
}

export async function recordProviderReportedUsage({
  provider,
  date,
  costMicroUsd,
  payload,
}: {
  provider: AiModel["provider"];
  date: Date;
  costMicroUsd: number;
  payload: unknown;
}) {
  const usageDate = dayStartUtc(date);
  const safeCost = Math.max(
    -2_000_000_000,
    Math.min(2_000_000_000, Math.round(costMicroUsd))
  );
  await prisma.providerDailyUsage.upsert({
    where: {
      provider_modelId_source_date: {
        provider,
        modelId: "__provider__",
        source: "provider_api",
        date: usageDate,
      },
    },
    create: {
      provider,
      modelId: "__provider__",
      source: "provider_api",
      date: usageDate,
      providerReportedCostMicroUsd: safeCost,
      providerReportedUsageJson: safeJsonPayload(payload),
      syncedAt: new Date(),
    },
    update: {
      providerReportedCostMicroUsd: safeCost,
      providerReportedUsageJson: safeJsonPayload(payload),
      syncedAt: new Date(),
    },
  });
}
