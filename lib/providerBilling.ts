import "server-only";

import { prisma } from "@/lib/prisma";
import type { AiProvider } from "@/lib/models";
import type {
  ProviderBillingProfile,
  ProviderPricingModel,
  ProviderSettlementModel,
} from "@/lib/providerBillingTypes";

const DOCUMENTED_DEFAULTS: Record<AiProvider, ProviderBillingProfile> = {
  openai: defaultProfile("usage_based", "prepaid"),
  anthropic: defaultProfile("usage_based", "prepaid"),
  google: defaultProfile("usage_based", "unknown"),
  groq: defaultProfile("usage_based", "postpaid"),
  xai: defaultProfile("usage_based", "hybrid"),
  deepseek: defaultProfile("usage_based", "prepaid"),
  mistral: defaultProfile("usage_based", "hybrid"),
  moonshot: defaultProfile("unknown", "unknown"),
  qwen: defaultProfile("usage_based", "unknown"),
  zhipu: defaultProfile("unknown", "unknown"),
  perplexity: defaultProfile("usage_based", "prepaid"),
};

function defaultProfile(
  pricingModel: ProviderPricingModel,
  settlementModel: ProviderSettlementModel
): ProviderBillingProfile {
  return {
    pricingModel,
    settlementModel,
    source: "documented_default",
    currency: "USD",
    monthlyLimitMicroUsd: null,
    verifiedAt: null,
    note: null,
    isPersisted: false,
  };
}

const safeMicroUsd = (value: bigint | null) => {
  if (value === null) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new Error("Provider billing limit exceeds the supported range.");
  }
  return number;
};

export const getProviderBillingProfiles = async (providers: AiProvider[]) => {
  const configs = await prisma.providerBillingConfig.findMany({
    where: { provider: { in: providers } },
  });
  const configByProvider = new Map(configs.map((config) => [config.provider, config]));

  return new Map<AiProvider, ProviderBillingProfile>(
    providers.map((provider) => {
      const config = configByProvider.get(provider);
      if (!config) return [provider, DOCUMENTED_DEFAULTS[provider]];

      return [
        provider,
        {
          pricingModel: config.pricingModel as ProviderPricingModel,
          settlementModel: config.settlementModel as ProviderSettlementModel,
          source: "admin_verified",
          currency: config.currency,
          monthlyLimitMicroUsd: safeMicroUsd(config.monthlyLimitMicroUsd),
          verifiedAt: config.verifiedAt?.toISOString() || null,
          note: config.note,
          isPersisted: true,
        },
      ];
    })
  );
};

export const setProviderBillingProfile = ({
  provider,
  pricingModel,
  settlementModel,
  currency,
  monthlyLimitMicroUsd,
  note,
  updatedById,
  updatedByEmail,
}: {
  provider: AiProvider;
  pricingModel: ProviderPricingModel;
  settlementModel: ProviderSettlementModel;
  currency: string;
  monthlyLimitMicroUsd: bigint | null;
  note: string | null;
  updatedById: string;
  updatedByEmail: string | null;
}) =>
  prisma.providerBillingConfig.upsert({
    where: { provider },
    create: {
      provider,
      pricingModel,
      settlementModel,
      currency,
      monthlyLimitMicroUsd,
      source: "admin_verified",
      verifiedAt: new Date(),
      note,
      updatedById,
      updatedByEmail,
    },
    update: {
      pricingModel,
      settlementModel,
      currency,
      monthlyLimitMicroUsd,
      source: "admin_verified",
      verifiedAt: new Date(),
      note,
      updatedById,
      updatedByEmail,
    },
  });
