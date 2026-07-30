import { isSeoLocale } from "@/lib/seo";
import type { Language } from "@/lib/language";

/**
 * The `/{locale}` path segments the localized marketing routes answer to.
 *
 * `kr` and `cn` are legacy aliases kept prerendered so old inbound links keep
 * working; each page redirects them to the canonical `/ko` and `/zh`. They are
 * listed here rather than restated in every page because the root layout now
 * needs the same mapping: it derives `<html lang>` from this segment, so an
 * alias the layout did not know about would render `lang="en"` over Korean
 * content for exactly as long as it took the redirect to fire.
 */
export const MARKETING_LOCALE_ALIASES: Record<string, Language> = {
  kr: "ko",
  cn: "zh",
};

export const MARKETING_LOCALE_SEGMENTS = (
  aliases = MARKETING_LOCALE_ALIASES
): string[] => Object.keys(aliases);

/** The language a `/{locale}` segment renders, or null if it is not one. */
export const marketingLocaleFor = (segment: string): Language | null => {
  const lowered = segment.toLowerCase();
  if (lowered in MARKETING_LOCALE_ALIASES) {
    return MARKETING_LOCALE_ALIASES[lowered];
  }
  return isSeoLocale(lowered) ? (lowered as Language) : null;
};
