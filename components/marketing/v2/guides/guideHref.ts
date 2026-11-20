import type { Language } from "@/lib/language";
import { LOCALIZED_SEO_PATHS, localizedPath } from "@/lib/seo";

/**
 * Turns a link stored in the guide copy into the href the page renders. Same rules the
 * old shared info page used: a Review or Chat start link keeps the visitor's language,
 * a localized marketing page gets its `/<locale>` prefix, anything else is left alone.
 */
export function guideHref(href: string, lang: Language): string {
  if (href.startsWith("/review") || /^\/chat(?=\?|$)/.test(href)) {
    const url = new URL(href.replace(/^\/chat(?=\?|$)/, "/review"), "https://tomverse.app");
    url.searchParams.set("lang", lang);
    return `${url.pathname}${url.search}${url.hash}`;
  }
  const url = href.startsWith("/") ? new URL(href, "https://tomverse.app") : null;
  if (url && (LOCALIZED_SEO_PATHS as readonly string[]).includes(url.pathname)) {
    return `${localizedPath(lang, url.pathname)}${url.search}${url.hash}`;
  }
  return href;
}
