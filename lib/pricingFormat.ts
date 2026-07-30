import type { Language } from "@/components/LanguageProvider";

// FINAL-F006. Two grammar defects shipped on /pricing in English:
//
//   * "1 credits" -- the credit unit was a single hard-coded plural string,
//     so the Standard weight (1) read as a plural.
//   * "A$10.00 / per month" and "Regular: A$20.00 / per month" -- the sale
//     blocks prefixed a literal "/" onto a period string that already reads
//     as a prepositional phrase in English ("per month"), while the
//     non-promotional block joined the same two values with a plain space.
//
// Both are fixed here rather than at each call site so the plain price, the
// discounted price, and the struck-through regular price are always composed
// the same way, and so the rules are unit-testable without rendering the
// page.

// BCP 47 tags for Intl. Kept separate from the marketing copy tables because
// plural selection must follow CLDR for the language, not the display locale
// a price happens to be formatted in.
const pluralLocale: Record<Language, string> = {
  en: "en",
  ko: "ko",
  zh: "zh",
  fr: "fr",
  de: "de",
  es: "es",
  pt: "pt",
};

const integerFormatterCache = new Map<string, Intl.NumberFormat>();

/**
 * A grouped integer for `lang` -- "3,000" in en, "3.000" in de/es/pt,
 * "3 000" in fr. Resolved against the same CLDR language as `pluralizeUnit`,
 * so a count and the unit beside it can never be formatted for two different
 * languages.
 */
export const formatLocalizedInteger = (value: number, lang: Language) => {
  const locale = pluralLocale[lang] ?? "en";
  let formatter = integerFormatterCache.get(locale);
  if (!formatter) {
    formatter = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
    integerFormatterCache.set(locale, formatter);
  }
  return formatter.format(value);
};

export type CountableUnit = {
  /** Form used for the CLDR "one" plural category. */
  one: string;
  /** Form used for every other CLDR plural category, including "zero". */
  other: string;
};

const pluralRulesCache = new Map<string, Intl.PluralRules>();

const pluralRulesFor = (lang: Language) => {
  const locale = pluralLocale[lang] ?? "en";
  let rules = pluralRulesCache.get(locale);
  if (!rules) {
    rules = new Intl.PluralRules(locale);
    pluralRulesCache.set(locale, rules);
  }
  return rules;
};

/**
 * Picks the unit form matching `count` for `lang`. Languages without a
 * grammatical singular/plural split (ko, zh) simply carry the same string in
 * both slots, so they are unaffected by the CLDR category that comes back.
 */
export const pluralizeUnit = (
  count: number,
  unit: CountableUnit,
  lang: Language
) => (pluralRulesFor(lang).select(count) === "one" ? unit.one : unit.other);

/**
 * "1 credit" / "2 credits" / "0 credits". `formatNumber` is threaded through
 * so callers keep whatever Intl.NumberFormat they already use for grouping.
 */
export const formatCountedUnit = (
  count: number,
  unit: CountableUnit,
  lang: Language,
  formatNumber: (value: number) => string = (value) => String(value)
) => `${formatNumber(count)} ${pluralizeUnit(count, unit, lang)}`;

/**
 * The credit unit as it appears in English chat copy -- "Base cost 1 credit",
 * "Base estimate 2 credits".
 *
 * FINAL-F006 was only ever fixed on /pricing, which owns its own localized
 * copy table because it translates the whole surrounding sentence. The chat
 * surfaces (model picker, catalogue, desktop panels, model finder) render
 * this label in Korean or English only, and Korean has no plural, so English
 * is the single form that needs CLDR selection. Exported from here rather
 * than restated per component so the four surfaces cannot drift apart again.
 */
export const englishCreditUnit: CountableUnit = {
  one: "credit",
  other: "credits",
};

// How a billing period attaches to a price. English, French, German,
// Spanish and Portuguese period strings are already prepositional phrases
// ("per month", "par mois"), so a slash in front of them is ungrammatical.
// Korean and Chinese period strings are bare nouns, where the slash is the
// conventional separator.
const periodSeparator: Record<Language, string> = {
  en: " ",
  ko: " / ",
  zh: " / ",
  fr: " ",
  de: " ",
  es: " ",
  pt: " ",
};

/**
 * The period exactly as it should render next to a price -- including its
 * separator, so a caller that renders the price and the period in different
 * type sizes still gets the right glue. Never yields a doubled slash.
 */
export const formatBillingPeriodLabel = (period: string, lang: Language) => {
  const trimmed = period.trim().replace(/^\/\s*/, "");
  const separator = (periodSeparator[lang] ?? " ").trim();
  return separator ? `${separator} ${trimmed}` : trimmed;
};

/** "A$10.00 per month" / "$15 / 월". */
export const formatPriceWithPeriod = (
  price: string,
  period: string,
  lang: Language
) => {
  const trimmed = period.trim().replace(/^\/\s*/, "");
  return `${price.trim()}${periodSeparator[lang] ?? " "}${trimmed}`;
};
