export type AnalyticsConsentMode = "opt_in" | "notice_opt_out";

export type ResolvedAnalyticsConsentPolicy = {
  country: string;
  mode: AnalyticsConsentMode;
};

const DEFAULT_ENABLED_COUNTRIES = "AU";

// EU/EEA and UK visitors remain explicit opt-in even if an operator
// accidentally includes one of these countries in the default-enabled list.
const STRICT_OPT_IN_COUNTRIES = new Set([
  "AT",
  "BE",
  "BG",
  "CH",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GB",
  "GR",
  "HR",
  "HU",
  "IE",
  "IS",
  "IT",
  "LI",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

export const normalizeAnalyticsCountry = (value: string | null | undefined) => {
  const candidate = value?.trim().toUpperCase();
  return candidate && /^[A-Z]{2}$/.test(candidate) ? candidate : "ZZ";
};

export const parseDefaultEnabledAnalyticsCountries = (
  configuredCountries: string | null | undefined
) => {
  const source =
    configuredCountries === undefined || configuredCountries === null
      ? DEFAULT_ENABLED_COUNTRIES
      : configuredCountries;
  return new Set(
    source
      .split(",")
      .map(normalizeAnalyticsCountry)
      .filter((country) => country !== "ZZ")
  );
};

export const resolveAnalyticsConsentPolicy = (
  countryValue: string | null | undefined,
  configuredDefaultEnabledCountries?: string | null
): ResolvedAnalyticsConsentPolicy => {
  const country = normalizeAnalyticsCountry(countryValue);
  if (country === "ZZ" || STRICT_OPT_IN_COUNTRIES.has(country)) {
    return { country, mode: "opt_in" };
  }

  const defaultEnabledCountries = parseDefaultEnabledAnalyticsCountries(
    configuredDefaultEnabledCountries
  );
  return {
    country,
    mode: defaultEnabledCountries.has(country) ? "notice_opt_out" : "opt_in",
  };
};

