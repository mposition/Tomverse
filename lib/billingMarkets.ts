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

/**
 * RECON-UX-001. How each billing market writes its own price.
 *
 * `locale` used to default to `undefined`, which makes Intl fall back to the
 * *browser's* locale: one USD price rendered "$19.00" to an en-US visitor,
 * "US$19.00" to en-GB and ko-KR, and "USD 19.00" to en-AU. The amount and the
 * currency were never in doubt -- only how wide the notation came out -- and
 * that width decided whether a plan card fit its grid track under zoom, so
 * /pricing overflowed for some visitors and not others.
 *
 * The notation is a property of the market being billed, not of whoever is
 * looking, so it is pinned per currency here. AUD already worked this way with
 * its hard-coded "A$"; this simply gives the other four the same treatment.
 * `narrowSymbol` keeps USD as "$" rather than "US$" and CNY as "¥" rather than
 * "CN¥" even if ICU's defaults shift under us.
 *
 * This changes presentation only. The amount charged, the currency, and the
 * checkout currency are untouched.
 */
const BILLING_DISPLAY_LOCALE: Record<BillingCurrency, string> = {
  USD: "en-US", // $19.00
  AUD: "en-AU", // A$19.00, composed below
  CNY: "zh-CN", // ¥19.00
  EUR: "de-DE", // 19,00 €
  KRW: "ko-KR", // ₩19,000
};

export const billingDisplayLocale = (currency: BillingCurrency) =>
  BILLING_DISPLAY_LOCALE[currency];

export const formatBillingAmount = (
  amount: number,
  currency: BillingCurrency,
  locale: string = BILLING_DISPLAY_LOCALE[currency],
  fractionDigits = billingCurrencyFractionDigits(currency)
) => {
  if (currency === "AUD") {
    return `A$${new Intl.NumberFormat(locale, {
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    }).format(amount)}`;
  }
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    currencyDisplay: "narrowSymbol",
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  }).format(amount);
};

export const formatBillingMinor = (
  amountMinor: number,
  currency: BillingCurrency,
  locale?: string
) => formatBillingAmount(billingMinorToMajor(amountMinor, currency), currency, locale);

const TIME_ZONE_TO_BILLING_COUNTRY: Record<string, string> = {
  "Asia/Shanghai": "CN",
  "Asia/Chongqing": "CN",
  "Asia/Seoul": "KR",
  "Europe/Vienna": "AT",
  "Europe/Brussels": "BE",
  "Asia/Nicosia": "CY",
  "Europe/Nicosia": "CY",
  "Europe/Berlin": "DE",
  "Europe/Busingen": "DE",
  "Europe/Tallinn": "EE",
  "Europe/Madrid": "ES",
  "Africa/Ceuta": "ES",
  "Europe/Helsinki": "FI",
  "Europe/Paris": "FR",
  "Europe/Athens": "GR",
  "Europe/Zagreb": "HR",
  "Europe/Dublin": "IE",
  "Europe/Rome": "IT",
  "Europe/Vilnius": "LT",
  "Europe/Luxembourg": "LU",
  "Europe/Riga": "LV",
  "Europe/Malta": "MT",
  "Europe/Amsterdam": "NL",
  "Europe/Lisbon": "PT",
  "Atlantic/Madeira": "PT",
  "Atlantic/Azores": "PT",
  "Europe/Ljubljana": "SI",
  "Europe/Bratislava": "SK",
};

export const billingCountryFromTimeZone = (timeZone: string | null | undefined) => {
  if (!timeZone || timeZone.length > 80) return null;
  if (timeZone.startsWith("Australia/")) return "AU";
  return TIME_ZONE_TO_BILLING_COUNTRY[timeZone] || null;
};

export function getClientBillingMarket(): BillingMarket {
  if (typeof window === "undefined") {
    return { currency: "USD", country: "US", timeZone: null };
  }
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const locale = navigator.languages?.[0] || navigator.language || "";
  let localeCountry: string | null = null;
  try {
    localeCountry = locale
      ? normalizeBillingCountry(new Intl.Locale(locale).region)
      : null;
  } catch {
    localeCountry = null;
  }
  const country = billingCountryFromTimeZone(timeZone) || localeCountry || "US";
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
