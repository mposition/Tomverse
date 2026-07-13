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
  outputTokens: number;
  estimatedCostMicroUsd: number;
  date?: Date;
};

export async function recordInternalProviderUsage({
  provider,
  modelId,
  inputTokens,
  outputTokens,
  estimatedCostMicroUsd,
  date,
}: ProviderUsageRecordInput) {
  const usageDate = dayStartUtc(date);
  const safeInputTokens = Math.max(0, Math.min(2_000_000_000, Math.round(inputTokens)));
  const safeOutputTokens = Math.max(0, Math.min(2_000_000_000, Math.round(outputTokens)));
  const safeCost = Math.max(0, Math.min(2_000_000_000, Math.round(estimatedCostMicroUsd)));

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
      outputTokens: safeOutputTokens,
      estimatedCostMicroUsd: safeCost,
      syncedAt: new Date(),
    },
    update: {
      requestCount: { increment: 1 },
      inputTokens: { increment: safeInputTokens },
      outputTokens: { increment: safeOutputTokens },
      estimatedCostMicroUsd: { increment: safeCost },
      syncedAt: new Date(),
    },
  });
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
