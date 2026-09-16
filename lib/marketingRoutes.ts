const exactMarketingPaths = new Set([
  "/",
  "/about",
  "/ai-answer-review",
  "/ai-for-file-analysis",
  "/chatgpt-vs-claude",
  "/compare-ai-models",
  "/faq",
  "/models",
  "/pricing",
  "/privacy",
  "/refund",
  "/safety",
  "/safety/approach",
  "/safety/security-privacy",
  "/safety/trust-transparency",
  "/support",
  "/support/help-centre",
  "/support/help-centre/chat-workspace",
  "/terms",
]);

const localizedMarketingLocales = new Set([
  "en",
  "ko",
  "zh",
  "fr",
  "de",
  "es",
  "pt",
  "kr",
  "cn",
]);

const localizedSearchIntentPaths = new Set([
  "ai-answer-review",
  "ai-for-file-analysis",
  "chatgpt-vs-claude",
  "compare-ai-models",
]);

const normalizePathname = (pathname: string) => {
  if (!pathname || pathname === "/") return "/";
  return pathname.replace(/\/+$/, "") || "/";
};

export const isStaticMarketingPathname = (pathname: string) => {
  const normalized = normalizePathname(pathname);
  if (exactMarketingPaths.has(normalized)) return true;

  const segments = normalized.split("/").filter(Boolean);
  if (!localizedMarketingLocales.has(segments[0] || "")) return false;
  if (segments.length === 1) return true;
  return (
    segments.length === 2 && localizedSearchIntentPaths.has(segments[1] || "")
  );
};

/**
 * R-05-LANG. The English marketing root that a non-English visitor should be
 * sent to its own localized page instead of being handed English HTML and
 * having the client rewrite it.
 *
 * The defect: `/` is `force-static` and built in English, so `LanguageProvider`
 * resolves the language in a `setTimeout(0)` after mount and re-renders the
 * whole page in the visitor's locale. Sentence lengths differ, so the hero
 * section moves. Measured at 320px with a `zh-CN` browser and no query string
 * at all: CLS 0.1959 on a first visit, 0.1713 returning, and 0.1637 with every
 * webfont blocked -- the copy swap on its own. `/zh` measures 0.0076, and 0
 * with fonts blocked, because it ships the right language in the first byte.
 *
 * Only routes that *have* a localized counterpart can be redirected: `/` and
 * the four search-intent pages are generated per locale, `/pricing` and the
 * rest are not. Those keep the client-side swap, which is why this closes the
 * measured landing-page failure rather than the whole class.
 *
 * Returning `null` means "serve what was asked for".
 */
const REDIRECTABLE_BASE_PATHS = new Set(["/", ...[...localizedSearchIntentPaths].map((slug) => `/${slug}`)]);

export const localizedMarketingRedirect = ({
  pathname,
  language,
  source,
}: {
  pathname: string;
  language: string;
  /**
   * Where the language came from. `"search"` is an explicit `?lang=`, so it is
   * honoured even against a stored preference; `"accept"` is only an inference
   * from the browser and must not override a visitor who has already chosen.
   * `"path"` means the request is already localized -- returning null there is
   * what makes a redirect loop impossible.
   */
  source: "search" | "path" | "accept" | "default";
}): string | null => {
  if (source !== "search" && source !== "accept") return null;
  if (language === "en" || !localizedMarketingLocales.has(language)) return null;

  const normalized = normalizePathname(pathname);
  if (!REDIRECTABLE_BASE_PATHS.has(normalized)) return null;

  return normalized === "/" ? `/${language}` : `/${language}${normalized}`;
};
