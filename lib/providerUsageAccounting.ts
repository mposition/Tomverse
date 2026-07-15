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
  outputTokens: number;
  estimatedCostMicroUsd: number;
  uncachedInputCostMicroUsd: number;
  cachedInputCostMicroUsd: number;
  outputCostMicroUsd: number;
  date?: Date;
};

export async function recordInternalProviderUsage({
  provider,
  modelId,
  inputTokens,
  cachedInputTokens,
  outputTokens,
  estimatedCostMicroUsd,
  uncachedInputCostMicroUsd,
  cachedInputCostMicroUsd,
  outputCostMicroUsd,
  date,
}: ProviderUsageRecordInput) {
  const usageDate = dayStartUtc(date);
  const safeInputTokens = Math.max(0, Math.min(2_000_000_000, Math.round(inputTokens)));
  const safeOutputTokens = Math.max(0, Math.min(2_000_000_000, Math.round(outputTokens)));
  const safeCachedInputTokens = Math.min(
    safeInputTokens,
    Math.max(0, Math.min(2_000_000_000, Math.round(cachedInputTokens)))
  );
  const safeCost = Math.max(0, Math.min(2_000_000_000, Math.round(estimatedCostMicroUsd)));
  const safeUncachedInputCost = Math.max(0, Math.min(2_000_000_000, Math.round(uncachedInputCostMicroUsd)));
  const safeCachedInputCost = Math.max(0, Math.min(2_000_000_000, Math.round(cachedInputCostMicroUsd)));
  const safeOutputCost = Math.max(0, Math.min(2_000_000_000, Math.round(outputCostMicroUsd)));

  await prisma.providerDailyUsage.upsert({
    where: {
      provider_modelId_source_date: {
        provider,
        modelId,
        source: "internal",
        date: usageDate,
      },
    },
    create: {
      provider,
      modelId,
      source: "internal",
      date: usageDate,
      requestCount: 1,
      inputTokens: safeInputTokens,
      cachedInputTokens: safeCachedInputTokens,
      outputTokens: safeOutputTokens,
      estimatedCostMicroUsd: safeCost,
      uncachedInputCostMicroUsd: safeUncachedInputCost,
      cachedInputCostMicroUsd: safeCachedInputCost,
      outputCostMicroUsd: safeOutputCost,
      syncedAt: new Date(),
    },
    update: {
      requestCount: { increment: 1 },
      inputTokens: { increment: safeInputTokens },
      cachedInputTokens: { increment: safeCachedInputTokens },
      outputTokens: { increment: safeOutputTokens },
      estimatedCostMicroUsd: { increment: safeCost },
      uncachedInputCostMicroUsd: { increment: safeUncachedInputCost },
      cachedInputCostMicroUsd: { increment: safeCachedInputCost },
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
    where: { provider, source: "internal", date: usageDate },
    _sum: {
      requestCount: true,
      inputTokens: true,
      cachedInputTokens: true,
      outputTokens: true,
      estimatedCostMicroUsd: true,
    },
  });
  return {
    requestCount: aggregate._sum.requestCount || 0,
    inputTokens: aggregate._sum.inputTokens || 0,
    cachedInputTokens: aggregate._sum.cachedInputTokens || 0,
    outputTokens: aggregate._sum.outputTokens || 0,
    estimatedCostMicroUsd: aggregate._sum.estimatedCostMicroUsd || 0,
  };
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
