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

/**
 * The approved localized prices.
 *
 * Not a fixture and not a placeholder. Three production paths charge these
 * numbers: no `AppSetting` row (the first read writes them into the database),
 * a row that does not parse, and a row that parses but fails the schema. So a
 * number here is a price somebody can be charged, and changing one is a price
 * change.
 *
 * These are the values production has stored since 2026-08-14, verified with
 * `npm run report:billing-price-catalog` and aligned deliberately (#637). They
 * were previously stale in twenty places, which meant losing the row would
 * have raised Pro AUD/CNY and every non-USD credit pack while *lowering* Max
 * KRW -- a four-market pricing incident with nothing to announce it.
 *
 * USD is not here. Plan prices in USD come from `BillingPlan`, and the USD
 * credit-pack prices below are the only USD numbers this table holds.
 */
export const DEFAULT_BILLING_PRICE_CATALOG: BillingPriceCatalog = {
  version: 1,
  plans: {
    pro: {
      AUD: { monthly: 2_000, annual: 19_200 },
      CNY: { monthly: 9_900, annual: 95_000 },
      EUR: { monthly: 1_400, annual: 13_400 },
      KRW: { monthly: 20_000, annual: 192_000 },
    },
    max: {
      AUD: { monthly: 3_900, annual: 37_400 },
      CNY: { monthly: 18_000, annual: 172_800 },
      EUR: { monthly: 2_300, annual: 22_000 },
      KRW: { monthly: 35_000, annual: 336_000 },
    },
  },
  creditPacks: {
    starter_500: { USD: 499, AUD: 700, CNY: 3_300, EUR: 450, KRW: 7_000 },
    project_1500: { USD: 999, AUD: 1_400, CNY: 6_500, EUR: 900, KRW: 14_000 },
    power_4000: { USD: 1_999, AUD: 2_800, CNY: 13_500, EUR: 1_800, KRW: 28_000 },
  },
};

const cloneDefaultCatalog = () =>
  JSON.parse(JSON.stringify(DEFAULT_BILLING_PRICE_CATALOG)) as BillingPriceCatalog;

/**
 * Which of the two tables answered.
 *
 * `stored` is the AppSetting row. Everything else means the compiled default is
 * what the customer is being quoted and charged, and says why.
 */
export type BillingPriceCatalogSource =
  | "stored"
  | "created_from_default"
  | "default_row_missing"
  | "default_row_unparseable"
  | "default_row_invalid";

/**
 * Says out loud that the catalogue fell back.
 *
 * The fallback used to be entirely silent -- no log, no metric -- so nothing
 * distinguished "serving the stored override" from "serving the compiled
 * default" at runtime, and a row that was deleted or corrupted would change
 * what new checkouts are charged with no signal at all. Now aligned with the
 * approved prices, the fallback charges the right amount; that is a reason for
 * it to be recoverable rather than a reason for it to be quiet, because the
 * row is still gone and somebody has to know.
 *
 * Warn rather than error: the request succeeds and the price is correct. What
 * is broken is the stored row.
 */
const reportCatalogFallback = (
  source: Exclude<BillingPriceCatalogSource, "stored">
) => {
  console.warn(
    JSON.stringify({
      event: "billing_price_catalog_fallback",
      source,
      key: BILLING_PRICE_CATALOG_KEY,
      // Stated so nobody reading the line has to work out whether customers
      // were affected: they were served the compiled default.
      served: "compiled_default",
    })
  );
};

export async function getBillingPriceCatalogWithMeta() {
  const row = await prisma.appSetting.findUnique({
    where: { key: BILLING_PRICE_CATALOG_KEY },
    select: { value: true, updatedAt: true },
  });
  if (!row) {
    reportCatalogFallback("created_from_default");
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
      source: "created_from_default" as BillingPriceCatalogSource,
    };
  }
  let source: BillingPriceCatalogSource = "default_row_unparseable";
  try {
    const parsed = billingPriceCatalogSchema.safeParse(JSON.parse(row.value));
    if (parsed.success) {
      return {
        catalog: parsed.data,
        updatedAt: row.updatedAt.toISOString(),
        source: "stored" as BillingPriceCatalogSource,
      };
    }
    source = "default_row_invalid";
  } catch {
    // Fall through to safe defaults. The admin API can overwrite an invalid value.
  }
  reportCatalogFallback(source);
  // `updatedAt` is the row's, and the catalogue is not: a caller that renders
  // them together would show a recent timestamp beside numbers that did not
  // come from that row. `source` is what lets it say so instead.
  return {
    catalog: cloneDefaultCatalog(),
    updatedAt: row.updatedAt.toISOString(),
    source,
  };
}

export async function getBillingPriceCatalog() {
  return (await getBillingPriceCatalogWithMeta()).catalog;
}

/**
 * The catalogue as stored, without creating it.
 *
 * `getBillingPriceCatalogWithMeta()` upserts the defaults when the row is
 * missing, which is right for the bootstrap paths that call it and wrong for a
 * read that has promised to change nothing -- the Admin promotion diagnostics
 * would create an `AppSetting` row as a side effect of an operator pressing
 * "Run diagnostics". The defaults are returned in memory instead, so the quoted
 * amount is the same one checkout would use without the row being written on
 * the way past.
 */
export async function readBillingPriceCatalog(): Promise<BillingPriceCatalog> {
  const row = await prisma.appSetting.findUnique({
    where: { key: BILLING_PRICE_CATALOG_KEY },
    select: { value: true },
  });
  if (!row) {
    reportCatalogFallback("default_row_missing");
    return cloneDefaultCatalog();
  }
  let source: BillingPriceCatalogSource = "default_row_unparseable";
  try {
    const parsed = billingPriceCatalogSchema.safeParse(JSON.parse(row.value));
    if (parsed.success) return parsed.data;
    source = "default_row_invalid";
  } catch {
    // An unreadable stored value is reported by the admin catalogue editor, not
    // repaired from here.
  }
  reportCatalogFallback(source);
  return cloneDefaultCatalog();
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
