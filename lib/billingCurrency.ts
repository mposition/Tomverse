import type { BillingPlanConfig } from "@/lib/billingConfig";

type ExchangeRateResponse = {
  result?: string;
  time_last_update_utc?: string;
  rates?: Record<string, number>;
};

type PublicBillingPlan = BillingPlanConfig & {
  baseCurrency: string;
  baseMonthlyPriceCents: number;
  baseAnnualPriceCents: number;
  displayCurrency: string;
  displayMonthlyPriceAmount: number;
  displayAnnualPriceAmount: number;
  displayExchangeRate: number;
};

type PublicBillingConfig<TConfig> = Omit<TConfig, "plans"> & {
  plans: PublicBillingPlan[];
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

const SUPPORTED_DISPLAY_CURRENCIES = new Set([
  "USD",
  ...Object.values(COUNTRY_TO_CURRENCY),
]);

const TIMEZONE_TO_CURRENCY: Array<[string, string]> = [
  ["Australia/", "AUD"],
  ["Pacific/Auckland", "NZD"],
  ["Asia/Seoul", "KRW"],
  ["Asia/Tokyo", "JPY"],
  ["Europe/London", "GBP"],
  ["Europe/", "EUR"],
  ["America/New_York", "USD"],
  ["America/Chicago", "USD"],
  ["America/Denver", "USD"],
  ["America/Los_Angeles", "USD"],
  ["America/Toronto", "CAD"],
  ["America/Vancouver", "CAD"],
];

const normalizeCountry = (value: string | null) => {
  if (!value || value.length !== 2) return null;
  return value.toUpperCase();
};

const normalizeCurrency = (value: string | null) => {
  if (!value || value.length !== 3) return null;
  const currency = value.toUpperCase();
  return SUPPORTED_DISPLAY_CURRENCIES.has(currency) ? currency : null;
};

const normalizeTimeZone = (value: string | null) => {
  if (!value || value.length > 80) return null;
  return /^[A-Za-z_]+\/[A-Za-z0-9_+\-/]+$/.test(value) ? value : null;
};

const currencyFromTimeZone = (value: string | null) => {
  const timeZone = normalizeTimeZone(value);
  if (!timeZone) return null;
  return TIMEZONE_TO_CURRENCY.find(([prefix]) => timeZone.startsWith(prefix))?.[1] || null;
};

export const inferCurrencyFromRequest = (req: Request) => {
  const requestedCurrency = normalizeCurrency(new URL(req.url).searchParams.get("currency"));
  if (requestedCurrency) return requestedCurrency;

  const requestedTimeZoneCurrency = currencyFromTimeZone(new URL(req.url).searchParams.get("tz"));
  if (requestedTimeZoneCurrency) return requestedTimeZoneCurrency;

  const country =
    normalizeCountry(req.headers.get("cf-ipcountry")) ||
    normalizeCountry(req.headers.get("x-vercel-ip-country")) ||
    normalizeCountry(req.headers.get("x-country-code"));

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

export async function withDisplayCurrency<
  TConfig extends { plans: BillingPlanConfig[] },
>(
  config: TConfig,
  req: Request
): Promise<PublicBillingConfig<TConfig>> {
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
      const annualUsdAmount = plan.annualPriceCents / 100;
      return {
        ...plan,
        baseCurrency: plan.currency || "USD",
        baseMonthlyPriceCents: plan.monthlyPriceCents,
        baseAnnualPriceCents: plan.annualPriceCents,
        displayCurrency,
        displayMonthlyPriceAmount: Math.round(usdAmount * rate),
        displayAnnualPriceAmount: Math.round(annualUsdAmount * rate),
        displayExchangeRate: rate,
      };
    }),
  };
}
