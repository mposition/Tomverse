import type { BillingPlanConfig } from "@/lib/billingConfig";

type ExchangeRateResponse = {
  result?: string;
  time_last_update_utc?: string;
  rates?: Record<string, number>;
};

type PublicBillingPlan = BillingPlanConfig & {
  baseCurrency: string;
  baseMonthlyPriceCents: number;
  displayCurrency: string;
  displayMonthlyPriceAmount: number;
  displayExchangeRate: number;
};

type PublicBillingConfig<TPromotion> = {
  plans: PublicBillingPlan[];
  promotions: TPromotion[];
  displayCurrency: string;
  baseCurrency: "USD";
  exchangeRateUpdatedAt: string | null;
};

const EXCHANGE_RATE_URL = "https://open.er-api.com/v6/latest/USD";
const EXCHANGE_RATE_CACHE_MS = 12 * 60 * 60 * 1000;

let rateCache:
  | {
      expiresAt: number;
      updatedAt: string | null;
      rates: Record<string, number>;
    }
  | null = null;

const COUNTRY_TO_CURRENCY: Record<string, string> = {
  AE: "AED",
  AR: "ARS",
  AU: "AUD",
  BR: "BRL",
  CA: "CAD",
  CH: "CHF",
  CL: "CLP",
  CN: "CNY",
  CO: "COP",
  DE: "EUR",
  ES: "EUR",
  FR: "EUR",
  GB: "GBP",
  HK: "HKD",
  ID: "IDR",
  IN: "INR",
  JP: "JPY",
  KR: "KRW",
  MX: "MXN",
  MY: "MYR",
  NZ: "NZD",
  PH: "PHP",
  PT: "EUR",
  SA: "SAR",
  SG: "SGD",
  TH: "THB",
  TW: "TWD",
  US: "USD",
  VN: "VND",
  ZA: "ZAR",
};

const LANGUAGE_TO_COUNTRY: Record<string, string> = {
  de: "DE",
  en: "US",
  es: "ES",
  fr: "FR",
  ko: "KR",
  pt: "PT",
  zh: "CN",
};

const normalizeCountry = (value: string | null) => {
  if (!value || value.length !== 2) return null;
  return value.toUpperCase();
};

const countryFromAcceptLanguage = (value: string | null) => {
  if (!value) return null;
  const firstTag = value.split(",")[0]?.trim().split(";")[0]?.trim();
  if (!firstTag) return null;
  const parts = firstTag.replace("_", "-").split("-");
  const language = parts[0]?.toLowerCase();
  const region = normalizeCountry(parts[1] || null);
  if (region) return region;
  return language ? LANGUAGE_TO_COUNTRY[language] || null : null;
};

export const inferCurrencyFromRequest = (req: Request) => {
  const country =
    normalizeCountry(req.headers.get("cf-ipcountry")) ||
    normalizeCountry(req.headers.get("x-vercel-ip-country")) ||
    normalizeCountry(req.headers.get("x-country-code")) ||
    countryFromAcceptLanguage(req.headers.get("accept-language"));

  return country ? COUNTRY_TO_CURRENCY[country] || "USD" : "USD";
};

const getExchangeRates = async () => {
  const now = Date.now();
  if (rateCache && rateCache.expiresAt > now) return rateCache;

  try {
    const response = await fetch(EXCHANGE_RATE_URL, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`Exchange rate API ${response.status}`);
    const data = (await response.json()) as ExchangeRateResponse;
    if (data.result !== "success" || !data.rates?.USD) {
      throw new Error("Invalid exchange rate response");
    }
    rateCache = {
      expiresAt: now + EXCHANGE_RATE_CACHE_MS,
      updatedAt: data.time_last_update_utc || null,
      rates: data.rates,
    };
    return rateCache;
  } catch {
    rateCache = {
      expiresAt: now + 15 * 60 * 1000,
      updatedAt: null,
      rates: { USD: 1 },
    };
    return rateCache;
  }
};

export async function withDisplayCurrency<TPromotion>(
  config: { plans: BillingPlanConfig[]; promotions: TPromotion[] },
  req: Request
): Promise<PublicBillingConfig<TPromotion>> {
  const requestedCurrency = inferCurrencyFromRequest(req);
  const exchangeRates = await getExchangeRates();
  const displayCurrency = exchangeRates.rates[requestedCurrency]
    ? requestedCurrency
    : "USD";
  const rate = exchangeRates.rates[displayCurrency] || 1;

  return {
    ...config,
    baseCurrency: "USD",
    displayCurrency,
    exchangeRateUpdatedAt: exchangeRates.updatedAt,
    plans: config.plans.map((plan) => {
      const usdAmount = plan.monthlyPriceCents / 100;
      return {
        ...plan,
        baseCurrency: plan.currency || "USD",
        baseMonthlyPriceCents: plan.monthlyPriceCents,
        displayCurrency,
        displayMonthlyPriceAmount: Math.round(usdAmount * rate),
        displayExchangeRate: rate,
      };
    }),
  };
}
