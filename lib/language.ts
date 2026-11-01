/**
 * The language list, on its own, in a module with no `"use client"` boundary.
 *
 * `LanguageProvider` is a client component, so anything it exports can only be
 * rendered or passed as props -- a server component that tries to *call* one of
 * its functions fails at request time. Server routes that have to resolve a
 * locale before rendering (see app/(site)/(application)/auth/signin/page.tsx)
 * need the guard here instead, and keeping the list in one place is what stops
 * the server's idea of a supported language from drifting from the client's.
 *
 * `zh` is Simplified Chinese; `zh-Hant` is Traditional Chinese written for
 * Taiwan and Hong Kong readers (owner decision 2026-11-01). The key is the
 * BCP 47 script tag itself, so the URL (/zh-Hant), hreflang, `<html lang>` and
 * the `:lang(zh-Hant)` font rule all read the same value.
 */
export const SUPPORTED_LANGUAGES = ["ko", "en", "zh", "zh-Hant", "fr", "de", "es", "pt"] as const;

export type Language = (typeof SUPPORTED_LANGUAGES)[number];

export const isLanguage = (value: unknown): value is Language =>
  typeof value === "string" && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);

/**
 * A `/{locale}` path segment as a supported language, ignoring case, or null.
 * Exact match only: unlike a browser tag, `/zh-tw` is not a route.
 */
export const languageFromSegment = (segment: string | null | undefined): Language | null => {
  const lowered = (segment ?? "").toLowerCase();
  return SUPPORTED_LANGUAGES.find((language) => language.toLowerCase() === lowered) ?? null;
};

// Regions whose readers write Traditional Chinese. Mainland China is out of
// scope, so `zh-CN` and a bare `zh` stay on Simplified.
const TRADITIONAL_CHINESE_SUBTAGS = new Set(["hant", "tw", "hk", "mo"]);

/**
 * A browser or URL language tag (`zh-TW`, `ZH-hant`, `ko-KR`) as a supported
 * language, or null. Matching is case-insensitive because path segments and
 * `Accept-Language` are lowercased before they get here.
 */
export const languageFromTag = (tag: string | null | undefined): Language | null => {
  const parts = (tag ?? "").trim().toLowerCase().split(/[-_]/).filter(Boolean);
  const [base, ...subtags] = parts;
  if (!base) return null;
  if (base === "zh") {
    return subtags.some((subtag) => TRADITIONAL_CHINESE_SUBTAGS.has(subtag)) ? "zh-Hant" : "zh";
  }
  return isLanguage(base) ? base : null;
};

/**
 * Languages that have their own email copy. Traditional Chinese email
 * templates are not translated yet, so a `zh-Hant` reader is sent the
 * Simplified copy, which they can read, rather than English.
 */
export type EmailCopyLanguage = Exclude<Language, "zh-Hant">;

export const emailCopyLanguage = (language: Language): EmailCopyLanguage =>
  language === "zh-Hant" ? "zh" : language;
