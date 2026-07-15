import "server-only";

import { z } from "zod";
import type { BillingPlanConfig } from "@/lib/billingConfig";
import {
  BILLING_CURRENCIES,
  billingCurrencyFractionDigits,
  billingMinorToMajor,
  type BillingCurrency,
} from "@/lib/billingMarkets";
import { CREDIT_PACKS, type CreditPackId } from "@/lib/creditPacks";
import { prisma } from "@/lib/prisma";

export const BILLING_PRICE_CATALOG_KEY = "billing.fixed-prices.v1";
export const LOCALIZED_BILLING_CURRENCIES = ["AUD", "CNY", "EUR", "KRW"] as const;
export type LocalizedBillingCurrency = (typeof LOCALIZED_BILLING_CURRENCIES)[number];

const pricePairSchema = z.object({
  monthly: z.number().int().min(0).max(100_000_000),
  annual: z.number().int().min(0).max(1_000_000_000),
}).strict();

const localizedPlanPricesSchema = z.object({
  AUD: pricePairSchema,
  CNY: pricePairSchema,
  EUR: pricePairSchema,
  KRW: pricePairSchema,
}).strict();

const creditPackPricesSchema = z.object({
  USD: z.number().int().positive().max(100_000_000),
  AUD: z.number().int().positive().max(100_000_000),
  CNY: z.number().int().positive().max(100_000_000),
  EUR: z.number().int().positive().max(100_000_000),
  KRW: z.number().int().positive().max(100_000_000),
}).strict();

export const billingPriceCatalogSchema = z.object({
  version: z.literal(1),
  plans: z.object({
    pro: localizedPlanPricesSchema,
    max: localizedPlanPricesSchema,
  }).strict(),
  creditPacks: z.object({
    starter_500: creditPackPricesSchema,
    project_1500: creditPackPricesSchema,
    power_4000: creditPackPricesSchema,
  }).strict(),
}).strict();

export type BillingPriceCatalog = z.infer<typeof billingPriceCatalogSchema>;

export const DEFAULT_BILLING_PRICE_CATALOG: BillingPriceCatalog = {
  version: 1,
  plans: {
    pro: {
      AUD: { monthly: 2_300, annual: 22_000 },
      CNY: { monthly: 10_800, annual: 103_700 },
      EUR: { monthly: 1_400, annual: 13_400 },
      KRW: { monthly: 20_000, annual: 192_000 },
    },
    max: {
      AUD: { monthly: 3_900, annual: 37_200 },
      CNY: { monthly: 18_000, annual: 172_800 },
      EUR: { monthly: 2_300, annual: 22_100 },
      KRW: { monthly: 34_000, annual: 326_000 },
    },
  },
  creditPacks: {
    starter_500: { USD: 499, AUD: 790, CNY: 3_600, EUR: 490, KRW: 7_900 },
    project_1500: { USD: 999, AUD: 1_590, CNY: 7_200, EUR: 990, KRW: 14_900 },
    power_4000: { USD: 1_999, AUD: 3_190, CNY: 14_400, EUR: 1_990, KRW: 29_900 },
  },
};

const cloneDefaultCatalog = () =>
  JSON.parse(JSON.stringify(DEFAULT_BILLING_PRICE_CATALOG)) as BillingPriceCatalog;

export async function getBillingPriceCatalogWithMeta() {
  const row = await prisma.appSetting.findUnique({
    where: { key: BILLING_PRICE_CATALOG_KEY },
    select: { value: true, updatedAt: true },
  });
  if (!row) {
    const created = await prisma.appSetting.upsert({
      where: { key: BILLING_PRICE_CATALOG_KEY },
      create: {
        key: BILLING_PRICE_CATALOG_KEY,
        value: JSON.stringify(DEFAULT_BILLING_PRICE_CATALOG),
      },
      update: {},
      select: { value: true, updatedAt: true },
    });
    return {
      catalog: billingPriceCatalogSchema.parse(JSON.parse(created.value)),
      updatedAt: created.updatedAt.toISOString(),
    };
  }
  try {
    const parsed = billingPriceCatalogSchema.safeParse(JSON.parse(row.value));
    if (parsed.success) {
      return { catalog: parsed.data, updatedAt: row.updatedAt.toISOString() };
    }
  } catch {
    // Fall through to safe defaults. The admin API can overwrite an invalid value.
  }
  return { catalog: cloneDefaultCatalog(), updatedAt: row.updatedAt.toISOString() };
}

export async function getBillingPriceCatalog() {
  return (await getBillingPriceCatalogWithMeta()).catalog;
}

export async function saveBillingPriceCatalog(catalog: BillingPriceCatalog) {
  const validated = billingPriceCatalogSchema.parse(catalog);
  return prisma.appSetting.upsert({
    where: { key: BILLING_PRICE_CATALOG_KEY },
    create: { key: BILLING_PRICE_CATALOG_KEY, value: JSON.stringify(validated) },
    update: { value: JSON.stringify(validated) },
    select: { updatedAt: true },
  });
}

export function getPlanPriceMinor(
  plan: BillingPlanConfig,
  currency: BillingCurrency,
  interval: "monthly" | "annual",
  catalog: BillingPriceCatalog
) {
  if (plan.id === "free") return 0;
  if (currency === "USD") {
    return interval === "annual" ? plan.annualPriceCents : plan.monthlyPriceCents;
  }
  return catalog.plans[plan.id][currency][interval];
}

export function getCreditPackPriceMinor(
  packId: CreditPackId,
  currency: BillingCurrency,
  catalog: BillingPriceCatalog
) {
  return catalog.creditPacks[packId][currency];
}

export function getPublicLocalizedCreditPackCatalog(catalog: BillingPriceCatalog) {
  return CREDIT_PACKS.map(({ id, name, credits, validityDays, allowedPlans }) => ({
    id,
    name,
    credits,
    validityDays,
    allowedPlans: [...allowedPlans],
    prices: BILLING_CURRENCIES.reduce<Record<BillingCurrency, number>>(
      (prices, currency) => {
        prices[currency] = getCreditPackPriceMinor(id, currency, catalog);
        return prices;
      },
      {} as Record<BillingCurrency, number>
    ),
  }));
}

type FxResponse = { result?: string; rates?: Record<string, number> };
let fxCache: { expiresAt: number; rates: Record<string, number> } | null = null;

async function getUsdRates() {
  if (fxCache && fxCache.expiresAt > Date.now()) return fxCache.rates;
  const response = await fetch("https://open.er-api.com/v6/latest/USD", {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(4_000),
  });
  if (!response.ok) throw new Error(`FX_RATE_HTTP_${response.status}`);
  const body = (await response.json()) as FxResponse;
  if (body.result !== "success" || !body.rates?.USD) {
    throw new Error("FX_RATE_INVALID_RESPONSE");
  }
  fxCache = { expiresAt: Date.now() + 60 * 60 * 1_000, rates: body.rates };
  return body.rates;
}

export async function getUsdRevenueSnapshot({
  amountMinor,
  currency,
  fallbackUsdMinor,
}: {
  amountMinor: number;
  currency: BillingCurrency;
  fallbackUsdMinor: number;
}) {
  if (currency === "USD") {
    return {
      amountUsdMicroUsd: BigInt(amountMinor) * BigInt(10_000),
      usdConversionRate: "1",
      source: "identity" as const,
    };
  }
  try {
    const rates = await getUsdRates();
    const perUsd = rates[currency];
    if (!perUsd || perUsd <= 0) throw new Error("FX_RATE_MISSING_CURRENCY");
    const amountUsd = billingMinorToMajor(amountMinor, currency) / perUsd;
    return {
      amountUsdMicroUsd: BigInt(Math.max(0, Math.round(amountUsd * 1_000_000))),
      usdConversionRate: String(1 / perUsd),
      source: "exchange_rate_api" as const,
    };
  } catch {
    return {
      amountUsdMicroUsd: BigInt(Math.max(0, fallbackUsdMinor)) * BigInt(10_000),
      usdConversionRate: null,
      source: "catalog_fallback" as const,
    };
  }
}

export const billingPriceAmount = (amountMinor: number, currency: BillingCurrency) => ({
  amountMinor,
  amount: billingMinorToMajor(amountMinor, currency),
  fractionDigits: billingCurrencyFractionDigits(currency),
});
