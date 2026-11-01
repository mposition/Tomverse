import { isApiPathname } from "@/lib/apiCacheControlPolicy";

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
  "/products/review",
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

/** Only paths backed by prerendered locale routes belong in this list. */
export const LOCALIZED_MARKETING_BASE_PATHS = [
  "/",
  "/compare-ai-models",
  "/ai-answer-review",
  "/chatgpt-vs-claude",
  "/ai-for-file-analysis",
  "/products/review",
  "/about",
  "/faq",
  "/pricing",
  "/models",
  "/safety",
  "/safety/approach",
  "/safety/security-privacy",
  "/safety/trust-transparency",
  "/support",
  "/support/help-centre",
  "/support/help-centre/chat-workspace",
] as const;
const localizedMarketingBasePaths = new Set<string>(LOCALIZED_MARKETING_BASE_PATHS);

export const REVIEW_PRODUCT_PATH = "/products/review";

const normalizePathname = (pathname: string) => {
  if (!pathname || pathname === "/") return "/";
  return pathname.replace(/\/+$/, "") || "/";
};

/**
 * Landing experiments (docs/policy/marketing-automation.md section 9.1).
 *
 * Everything the request boundary needs lives here and nowhere else: the
 * proxy imports this module already, and a new local import in `proxy.ts`
 * would grow the Prompt Refiner runtime source closure, which a database
 * constraint pins. So the cookie shape, the variant path and the rewrite
 * decision are plain functions of strings, with no import and no computed
 * property access.
 *
 * The proxy never reads the database. The cookie is the whole authority for a
 * rewrite: it exists only because the assignment route saw analytics consent
 * and an active experiment, it names a bundle that must exist as prerendered
 * HTML (the proxy falls back to the default page when it does not), and the
 * beacon on every landing view re-validates it and clears it when the
 * experiment has stopped or consent is gone.
 */
export const EXPERIMENT_COOKIE_NAME = "tv_exp";
export const EXPERIMENT_CONTROL_ARM = "control";
export const EXPERIMENT_VARIANT_SEGMENT = "lx";
const EXPERIMENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{2,47}$/;
/** A variant id may be as short as `b`. */
const EXPERIMENT_ARM_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const EXPERIMENT_HOME_BUNDLE_PREFIX = "home-";

export type ExperimentAssignment = {
  experimentId: string;
  bundleId: string;
  /** `control`, or the variant id the bundle defines. */
  arm: string;
  /**
   * The languages the experiment was pre-registered for, as of the
   * assignment. The proxy reads no configuration, so the scope travels in the
   * cookie: a variant is rewritten into only for a language listed here.
   */
  locales: string[];
};

export const parseExperimentCookie = (
  value: string | null | undefined
): ExperimentAssignment | null => {
  if (!value || value.length > 200) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const [experimentId, bundleId, arm, localeCodes] = parts;
  if (
    !EXPERIMENT_ID_PATTERN.test(experimentId) ||
    !EXPERIMENT_ID_PATTERN.test(bundleId) ||
    !EXPERIMENT_ARM_PATTERN.test(arm) ||
    !/^(?:[a-z]{2}){1,7}$/.test(localeCodes)
  ) {
    return null;
  }
  // Two-letter codes run together: `enko`.
  const locales = localeCodes.match(/../g) ?? [];
  if (
    new Set(locales).size !== locales.length ||
    !locales.every((locale) => experimentLocales.has(locale))
  ) {
    return null;
  }
  return { experimentId, bundleId, arm, locales };
};

export const formatExperimentCookie = (assignment: ExperimentAssignment) =>
  `${assignment.experimentId}.${assignment.bundleId}.${assignment.arm}.${[
    ...assignment.locales,
  ]
    .sort()
    .join("")}`;

export const experimentVariantPathname = (
  locale: string,
  bundleId: string,
  variantId: string
) => `/${locale}/${EXPERIMENT_VARIANT_SEGMENT}/${bundleId}/${variantId}`;

const experimentLocales = new Set(["en", "ko", "zh", "fr", "de", "es", "pt"]);

/** `/{locale}/lx/{bundle}/{variant}`, prerendered at build time and noindex. */
export const isExperimentVariantPathname = (pathname: string) => {
  const segments = normalizePathname(pathname).split("/").filter(Boolean);
  if (segments.length !== 4) return false;
  const [locale, marker, bundleId, variantId] = segments;
  return (
    experimentLocales.has(locale) &&
    marker === EXPERIMENT_VARIANT_SEGMENT &&
    EXPERIMENT_ID_PATTERN.test(bundleId) &&
    EXPERIMENT_ARM_PATTERN.test(variantId)
  );
};

/**
 * The prerendered path a request should be served from instead of its own, or
 * null to serve the page that was asked for.
 *
 * Only document loads of a home page are rewritten. A client navigation asks
 * for a Flight payload (`RSC` header, no `text/html` in `Accept`), and
 * answering that with another route's payload is not something this feature
 * is entitled to do.
 */
export const resolveExperimentRewrite = (input: Readonly<{
  pathname: string;
  method: string;
  accept: string | null;
  rscHeader: string | null;
  cookie: string | null | undefined;
  killSwitch: string | undefined;
}>): string | null => {
  if (input.method !== "GET" && input.method !== "HEAD") return null;
  if (input.rscHeader) return null;
  if (!(input.accept ?? "").includes("text/html")) return null;
  if ((input.killSwitch ?? "").trim() !== "") return null;
  const assignment = parseExperimentCookie(input.cookie);
  if (!assignment || assignment.arm === EXPERIMENT_CONTROL_ARM) return null;
  if (!assignment.bundleId.startsWith(EXPERIMENT_HOME_BUNDLE_PREFIX)) return null;

  const normalized = normalizePathname(input.pathname);
  const locale = normalized === "/" ? "en" : normalized.slice(1);
  if (!experimentLocales.has(locale)) return null;
  // Only the languages the experiment was registered for: a visitor assigned
  // in English who opens the Korean home page is outside it.
  if (!assignment.locales.includes(locale)) return null;
  return experimentVariantPathname(locale, assignment.bundleId, assignment.arm);
};

/**
 * Where a request for a variant path is sent instead: the home page it varies.
 * A variant belongs to one visitor's assignment, so a request that names the
 * path without that assignment -- a leaked link, a crawler -- gets the default
 * copy (policy 9.1: no assignment, no variant).
 */
export const experimentVariantHomePathname = (pathname: string): string | null => {
  if (!isExperimentVariantPathname(pathname)) return null;
  const [locale] = normalizePathname(pathname).split("/").filter(Boolean);
  return locale === "en" ? "/" : `/${locale}`;
};

/**
 * Whether the cookie assigns its holder to exactly the variant this path
 * serves. The proxy runs again on the path a rewrite lands on, so this is the
 * test applied on both passes: the rewritten request and a direct one are the
 * same request as far as the visitor's entitlement goes, and either is served
 * the variant only with the matching assignment (and never under the kill
 * switch).
 */
export const experimentCookieMatchesVariantPath = (input: Readonly<{
  pathname: string;
  cookie: string | null | undefined;
  killSwitch: string | undefined;
}>): boolean => {
  if ((input.killSwitch ?? "").trim() !== "") return false;
  if (!isExperimentVariantPathname(input.pathname)) return false;
  const assignment = parseExperimentCookie(input.cookie);
  if (!assignment || assignment.arm === EXPERIMENT_CONTROL_ARM) return false;
  const [locale, , bundleId, variantId] = normalizePathname(input.pathname)
    .split("/")
    .filter(Boolean);
  return (
    assignment.bundleId === bundleId &&
    assignment.arm === variantId &&
    assignment.locales.includes(locale)
  );
};

export const isStaticMarketingPathname = (pathname: string) => {
  const normalized = normalizePathname(pathname);
  if (exactMarketingPaths.has(normalized)) return true;
  if (isExperimentVariantPathname(normalized)) return true;

  const segments = normalized.split("/").filter(Boolean);
  if (!localizedMarketingLocales.has(segments[0] || "")) return false;
  if (segments.length === 1) return true;
  return localizedMarketingBasePaths.has(`/${segments.slice(1).join("/")}`);
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
 * Only routes with a generated locale counterpart can redirect. Legal pages,
 * the application, status and the dynamic Knowledge guide retain their own
 * language and caching behavior.
 *
 * Returning `null` means "serve what was asked for".
 */
const REDIRECTABLE_BASE_PATHS = localizedMarketingBasePaths;

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

/** API responses never inherit public marketing caching or redirects. */
export function proxyMarketingBoundary(input: Readonly<{
  pathname: string;
  method: string;
  isStatic: (pathname: string) => boolean;
  redirect: () => string | null;
}>): Readonly<{ staticMarketing: boolean; redirect: string | null }> {
  if (isApiPathname(input.pathname)) {
    return { staticMarketing: false, redirect: null };
  }
  return {
    staticMarketing: input.isStatic(input.pathname),
    redirect: input.method === "GET" || input.method === "HEAD"
      ? input.redirect() : null,
  };
}
