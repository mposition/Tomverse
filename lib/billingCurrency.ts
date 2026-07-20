import type { BillingPlanConfig } from "@/lib/billingConfig";
import {
  billingCurrencyForCountry,
  billingCountryFromTimeZone,
  billingMinorToMajor,
  normalizeBillingCountry,
  normalizeBillingCurrency,
  type BillingCurrency,
  type BillingMarket,
} from "@/lib/billingMarkets";
import {
  DEFAULT_BILLING_PRICE_CATALOG,
  getBillingPriceCatalog,
  getCreditPackPriceMinor,
  getPlanPriceMinor,
} from "@/lib/billingPriceCatalog";

type PublicBillingPlan = BillingPlanConfig & {
  baseCurrency: "USD";
  baseMonthlyPriceCents: number;
  baseAnnualPriceCents: number;
  displayCurrency: BillingCurrency;
  displayMonthlyPriceMinor: number;
  displayAnnualPriceMinor: number;
  displayMonthlyPriceAmount: number;
  displayAnnualPriceAmount: number;
  displayExchangeRate: null;
};

type PublicBillingConfig<TConfig> = Omit<TConfig, "plans" | "creditPacks"> & {
  plans: PublicBillingPlan[];
  creditPacks: Array<Record<string, unknown>>;
  displayCurrency: BillingCurrency;
  displayCountry: string;
  baseCurrency: "USD";
  pricingMode: "fixed";
  exchangeRateUpdatedAt: null;
};

// Only edge-injected headers belong here: Cloudflare and Vercel overwrite these
// on the way in, so a client cannot forge them. Do not add client-settable
// headers (e.g. a generic "x-country-code") without a proxy that strips them.
const trustedCountryFromHeaders = (headers: Headers) =>
  normalizeBillingCountry(headers.get("cf-ipcountry")) ||
  normalizeBillingCountry(headers.get("x-vercel-ip-country"));

export class BillingMarketValidationError extends Error {
  readonly code = "BILLING_MARKET_MISMATCH";

  constructor(message: string) {
    super(message);
    this.name = "BillingMarketValidationError";
  }
}

export function inferBillingMarketFromRequest(req: Request): BillingMarket {
  const url = new URL(req.url);
  const trustedCountry = trustedCountryFromHeaders(req.headers);
  const requestedCountry = normalizeBillingCountry(url.searchParams.get("country"));
  const timeZoneCountry = billingCountryFromTimeZone(url.searchParams.get("tz"));
  const country = trustedCountry || timeZoneCountry || requestedCountry || "US";
  const expectedCurrency = billingCurrencyForCountry(country);
  const requestedCurrency = normalizeBillingCurrency(url.searchParams.get("currency"));
  return {
    currency: requestedCurrency === expectedCurrency ? requestedCurrency : expectedCurrency,
    country,
    timeZone: url.searchParams.get("tz"),
  };
}

export function validateBillingMarketRequest({
  req,
  currency,
  country,
}: {
  req: Request;
  currency?: unknown;
  country?: unknown;
}): BillingMarket {
  const trustedCountry = trustedCountryFromHeaders(req.headers);
  const requestedCountry = normalizeBillingCountry(country);
  const selectedCountry = trustedCountry || requestedCountry || "US";
  if (trustedCountry && requestedCountry && trustedCountry !== requestedCountry) {
    throw new BillingMarketValidationError(
      "The selected billing country does not match the checkout region. Reload pricing and try again."
    );
  }
  const selectedCurrency = normalizeBillingCurrency(currency) ||
    billingCurrencyForCountry(selectedCountry);
  const expectedCurrency = billingCurrencyForCountry(selectedCountry);
  if (selectedCurrency !== expectedCurrency) {
    throw new BillingMarketValidationError(
      `Currency ${selectedCurrency} is not supported for billing country ${selectedCountry}.`
    );
  }
  return { currency: selectedCurrency, country: selectedCountry, timeZone: null };
}

export async function withDisplayCurrency<
  TConfig extends {
    plans: BillingPlanConfig[];
    creditPacks?: Array<{ id: string } & Record<string, unknown>>;
  },
>(
  config: TConfig,
  req: Request
): Promise<PublicBillingConfig<TConfig>> {
  const market = inferBillingMarketFromRequest(req);
  const catalog =
    process.env.E2E_AUTH_BYPASS === "true" &&
    process.env.E2E_DISABLE_DATABASE === "true"
      ? DEFAULT_BILLING_PRICE_CATALOG
      : await getBillingPriceCatalog();
  return {
    ...config,
    baseCurrency: "USD",
    displayCurrency: market.currency,
    displayCountry: market.country,
    pricingMode: "fixed",
    exchangeRateUpdatedAt: null,
    plans: config.plans.map((plan) => {
      const monthlyMinor = getPlanPriceMinor(plan, market.currency, "monthly", catalog);
      const annualMinor = getPlanPriceMinor(plan, market.currency, "annual", catalog);
      return {
        ...plan,
        baseCurrency: "USD",
        baseMonthlyPriceCents: plan.monthlyPriceCents,
        baseAnnualPriceCents: plan.annualPriceCents,
        displayCurrency: market.currency,
        displayMonthlyPriceMinor: monthlyMinor,
        displayAnnualPriceMinor: annualMinor,
        displayMonthlyPriceAmount: billingMinorToMajor(monthlyMinor, market.currency),
        displayAnnualPriceAmount: billingMinorToMajor(annualMinor, market.currency),
        displayExchangeRate: null,
      };
    }),
    creditPacks: (config.creditPacks || []).map((pack) => ({
      ...pack,
      currency: market.currency,
      priceMinor: getCreditPackPriceMinor(
        pack.id as "starter_500" | "project_1500" | "power_4000",
        market.currency,
        catalog
      ),
      priceCents: getCreditPackPriceMinor(
        pack.id as "starter_500" | "project_1500" | "power_4000",
        market.currency,
        catalog
      ),
    })),
  };
}
