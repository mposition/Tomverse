import "server-only";

import { prisma } from "@/lib/prisma";
import type { AiProvider } from "@/lib/models";

export type ProviderCreditSummary = {
  configuredCreditMicroUsd: number | null;
  usedSinceCheckpointMicroUsd: number;
  estimatedBalanceMicroUsd: number | null;
  checkpointAt: string | null;
  note: string | null;
};

const toSafeNumber = (value: bigint) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error("Provider credit value exceeds the supported range.");
  }
  return number;
};

const emptySummary = (): ProviderCreditSummary => ({
  configuredCreditMicroUsd: null,
  usedSinceCheckpointMicroUsd: 0,
  estimatedBalanceMicroUsd: null,
  checkpointAt: null,
  note: null,
});

export const getProviderCreditSummaries = async (
  providers: AiProvider[]
) => {
  const [configs, usageRows] = await Promise.all([
    prisma.providerCreditConfig.findMany({
      where: { provider: { in: providers } },
    }),
    prisma.providerDailyUsage.groupBy({
      by: ["provider"],
      where: {
        provider: { in: providers },
        source: "internal",
      },
      _sum: { estimatedCostMicroUsd: true },
    }),
  ]);

  const usageByProvider = new Map(
    usageRows.map((row) => [
      row.provider,
      BigInt(row._sum.estimatedCostMicroUsd || 0),
    ])
  );
  const configByProvider = new Map(
    configs.map((config) => [config.provider, config])
  );

  return new Map<AiProvider, ProviderCreditSummary>(
    providers.map((provider) => {
      const config = configByProvider.get(provider);
      if (!config) return [provider, emptySummary()];

      const totalUsageMicroUsd = usageByProvider.get(provider) || BigInt(0);
      const usedSinceCheckpoint =
        totalUsageMicroUsd > config.usageBaselineMicroUsd
          ? totalUsageMicroUsd - config.usageBaselineMicroUsd
          : BigInt(0);
      const estimatedBalance = config.creditMicroUsd - usedSinceCheckpoint;

      return [
        provider,
        {
          configuredCreditMicroUsd: toSafeNumber(config.creditMicroUsd),
          usedSinceCheckpointMicroUsd: toSafeNumber(usedSinceCheckpoint),
          estimatedBalanceMicroUsd: toSafeNumber(estimatedBalance),
          checkpointAt: config.updatedAt.toISOString(),
          note: config.note,
        },
      ];
    })
  );
};

export const setProviderCreditCheckpoint = async ({
  provider,
  creditMicroUsd,
  note,
  updatedById,
  updatedByEmail,
}: {
  provider: AiProvider;
  creditMicroUsd: bigint;
  note: string | null;
  updatedById: string;
  updatedByEmail: string | null;
}) =>
  prisma.$transaction(async (tx) => {
    const usage = await tx.providerDailyUsage.aggregate({
      where: { provider, source: "internal" },
      _sum: { estimatedCostMicroUsd: true },
    });
    const usageBaselineMicroUsd = BigInt(
      usage._sum.estimatedCostMicroUsd || 0
    );

    return tx.providerCreditConfig.upsert({
      where: { provider },
      create: {
        provider,
        creditMicroUsd,
        usageBaselineMicroUsd,
        note,
        updatedById,
        updatedByEmail,
      },
      update: {
        creditMicroUsd,
        usageBaselineMicroUsd,
        note,
        updatedById,
        updatedByEmail,
      },
    });
  });
