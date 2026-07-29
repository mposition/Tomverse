import { SUPPORTED_LANGUAGES, isLanguage, type Language } from "@/lib/language";

/**
 * The language the *document* is served in, resolved before anything renders.
 *
 * VAL-004. `app/layout.tsx` used to hard-code `lang="en"` and let
 * `LanguageProvider` correct `document.documentElement.lang` in an effect
 * after hydration. That is too late for two things the attribute controls:
 *
 * - `:lang(ko)` / `:lang(zh)` in app/globals.css choose the font family for
 *   the whole subtree, so a Korean first paint was drawn in the Latin face
 *   with a system fallback for the Hangul, then re-drawn once the client
 *   fixed the attribute;
 * - assistive technology reads the document language from the served markup,
 *   and a Korean page announced as English is a WCAG 3.1.1 failure whatever
 *   the client does a tick later.
 *
 * The resolution order below mirrors what actually gets rendered, which is
 * the point: declaring a language the server did not render would trade one
 * mismatch for another. `?lang=` wins because the routes that honour it pin
 * `LanguageProvider` to it (`forceInitialLang`); a `/ko` style path prefix is
 * next; `Accept-Language` last, because that is what
 * `app/(application)/layout.tsx` already feeds to `initialLang`.
 */

export const DOCUMENT_LANGUAGE_HEADER = "x-tomverse-document-lang";
/**
 * Which input decided the language. Only `"search"` is authoritative enough to
 * pin `LanguageProvider`: `?lang=ko` is an explicit request, so the server
 * renders that language and the client must not restore a different one over
 * it. A language merely *inferred* from `Accept-Language` stays overridable by
 * the visitor's saved preference, as it was before.
 */
export const DOCUMENT_LANGUAGE_SOURCE_HEADER = "x-tomverse-document-lang-source";

export type DocumentLanguageSource = "search" | "path" | "accept" | "default";

const LOCALE_PATH_ALIASES: Record<string, Language> = { kr: "ko", cn: "zh" };

const fromPathname = (pathname: string | null | undefined): Language | null => {
  const segment = (pathname ?? "").split("/").filter(Boolean)[0]?.toLowerCase();
  if (!segment) return null;
  if (segment in LOCALE_PATH_ALIASES) return LOCALE_PATH_ALIASES[segment];
  return isLanguage(segment) ? segment : null;
};

const fromAcceptLanguage = (header: string | null | undefined): Language | null => {
  if (!header) return null;
  const ranked = header
    .toLowerCase()
    .split(",")
    .map((part) => {
      const [tag, ...parameters] = part.split(";");
      const quality = parameters
        .map((parameter) => parameter.trim())
        .find((parameter) => parameter.startsWith("q="));
      return {
        tag: tag?.trim() ?? "",
        // A malformed q value sorts last rather than throwing the whole
        // header away -- the browser still told us something.
        quality: quality ? Number.parseFloat(quality.slice(2)) || 0 : 1,
      };
    })
    .filter((entry) => entry.tag)
    .sort((a, b) => b.quality - a.quality);

  for (const { tag } of ranked) {
    const base = tag.split("-")[0];
    if (isLanguage(base)) return base;
  }
  return null;
};

export const resolveDocumentLanguage = ({
  pathname,
  searchLanguage,
  acceptLanguage,
}: {
  pathname?: string | null;
  searchLanguage?: string | null;
  acceptLanguage?: string | null;
}): { language: Language; source: DocumentLanguageSource } => {
  if (isLanguage(searchLanguage)) {
    return { language: searchLanguage, source: "search" };
  }
  const pathLanguage = fromPathname(pathname);
  if (pathLanguage) return { language: pathLanguage, source: "path" };
  const acceptedLanguage = fromAcceptLanguage(acceptLanguage);
  if (acceptedLanguage) return { language: acceptedLanguage, source: "accept" };
  return { language: "en", source: "default" };
};

export const isSupportedDocumentLanguage = (value: unknown): value is Language =>
  isLanguage(value);

export { SUPPORTED_LANGUAGES };
