export const EU_COUNTRY_CODES = Object.freeze([
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
]);

export const EEA_COUNTRY_CODES = Object.freeze([
  ...EU_COUNTRY_CODES,
  "IS",
  "LI",
  "NO",
]);

export const ARTICLE_27_PRESENCE_VERDICTS = Object.freeze({
  UNKNOWN: "unknown_no_database_read",
  SIGNAL_OBSERVED: "eea_processing_signal_observed",
  NO_SIGNAL_OBSERVED: "no_stored_signal_observed_not_proof_of_absence",
});

const toNonNegativeInteger = (value) =>
  Number.isInteger(value) && value >= 0 ? value : 0;

export function classifyArticle27Presence({
  databaseRead,
  eeaAccountSignals,
  eeaAnalyticsEvents,
  paidEurTransactions,
}) {
  if (!databaseRead) return ARTICLE_27_PRESENCE_VERDICTS.UNKNOWN;

  const observed =
    toNonNegativeInteger(eeaAccountSignals) > 0 ||
    toNonNegativeInteger(eeaAnalyticsEvents) > 0 ||
    toNonNegativeInteger(paidEurTransactions) > 0;

  return observed
    ? ARTICLE_27_PRESENCE_VERDICTS.SIGNAL_OBSERVED
    : ARTICLE_27_PRESENCE_VERDICTS.NO_SIGNAL_OBSERVED;
}

export function toIsoString(value) {
  return value instanceof Date ? value.toISOString() : null;
}
