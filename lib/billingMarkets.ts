export const BILLING_CURRENCIES = ["USD", "AUD", "CNY", "EUR", "KRW"] as const;

export type BillingCurrency = (typeof BILLING_CURRENCIES)[number];

export type BillingMarket = {
  currency: BillingCurrency;
  country: string;
  timeZone: string | null;
};

const BILLING_CURRENCY_SET = new Set<string>(BILLING_CURRENCIES);
const EURO_COUNTRIES = new Set([
  "AT", "BE", "CY", "DE", "EE", "ES", "FI", "FR", "GR", "HR", "IE",
  "IT", "LT", "LU", "LV", "MT", "NL", "PT", "SI", "SK",
]);

export const billingCurrencyForCountry = (country: string | null | undefined): BillingCurrency => {
  const normalized = normalizeBillingCountry(country);
  if (normalized === "AU") return "AUD";
  if (normalized === "CN") return "CNY";
  if (normalized === "KR") return "KRW";
  if (normalized && EURO_COUNTRIES.has(normalized)) return "EUR";
  return "USD";
};

export const normalizeBillingCountry = (value: unknown) => {
  if (typeof value !== "string") return null;
  const country = value.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(country) ? country : null;
};

export const normalizeBillingCurrency = (value: unknown): BillingCurrency | null => {
  if (typeof value !== "string") return null;
  const currency = value.trim().toUpperCase();
  return BILLING_CURRENCY_SET.has(currency) ? (currency as BillingCurrency) : null;
};

export const billingCurrencyFractionDigits = (currency: BillingCurrency) =>
  currency === "KRW" ? 0 : 2;

export const billingMinorToMajor = (amountMinor: number, currency: BillingCurrency) =>
  amountMinor / 10 ** billingCurrencyFractionDigits(currency);

export const billingMajorToMinor = (amount: number, currency: BillingCurrency) =>
  Math.round(amount * 10 ** billingCurrencyFractionDigits(currency));

export const formatBillingMinor = (
  amountMinor: number,
  currency: BillingCurrency,
  locale?: string
) =>
  new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    minimumFractionDigits: billingCurrencyFractionDigits(currency),
    maximumFractionDigits: billingCurrencyFractionDigits(currency),
  }).format(billingMinorToMajor(amountMinor, currency));

const countryFromTimeZone = (timeZone: string) => {
  if (timeZone.startsWith("Australia/")) return "AU";
  if (timeZone === "Asia/Shanghai" || timeZone === "Asia/Chongqing") return "CN";
  if (timeZone === "Asia/Seoul") return "KR";
  if (timeZone.startsWith("Europe/")) return "DE";
  return null;
};

export function getClientBillingMarket(): BillingMarket {
  if (typeof window === "undefined") {
    return { currency: "USD", country: "US", timeZone: null };
  }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const locale = navigator.languages?.[0] || navigator.language || "";
  let country: string | null = null;
  try {
    country = locale ? normalizeBillingCountry(new Intl.Locale(locale).region) : null;
  } catch {
    country = null;
  }
  country ||= countryFromTimeZone(timeZone);
  country ||= "US";
  return {
    currency: billingCurrencyForCountry(country),
    country,
    timeZone: timeZone || null,
  };
}

export function getBillingMarketQuery(market = getClientBillingMarket()) {
  const params = new URLSearchParams({
    currency: market.currency,
    country: market.country,
  });
  if (market.timeZone) params.set("tz", market.timeZone);
  return params.toString();
}
