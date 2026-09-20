/**
 * Which page a feature claim's evidence lives on, and how to read it.
 *
 * Contract: the S1 plan's B2 amendment -- a feature or availability claim's
 * rendered sentence **is** the public page's own string, so the Guard must be
 * able to fetch that string and compare it to what a draft renders. That needs
 * two things this module supplies: a route-to-content map, and a resolver that
 * walks a key inside it.
 *
 * **The plan says `locales/<locale>.ts`; in this repository it is not there.**
 * Marketing page copy lives in per-page dictionaries -- `infoPages` in
 * `components/marketing/marketingInfoContent.ts` for the information pages,
 * and component-local objects elsewhere. `locales/*.ts` holds application copy.
 * A map pointing at `locales` would resolve nothing, so this points at where
 * the sentences actually are, and the test reads each route's page component to
 * prove the mapping is the one that route renders.
 *
 * **`zh-Hant` has no page.** The marketing locales are `en`, `ko`, `zh-Hant`
 * and `zh-Hans`; the site has one `zh`, and its copy is Simplified. Mapping
 * `zh-Hant` onto it would let a Traditional Chinese claim cite a Simplified
 * page as the sentence it renders, which is exactly the drift the
 * "evidence is the page" rule exists to prevent. So `zh-Hant` resolves to no
 * page and a Traditional Chinese feature claim refuses until there is one.
 *
 * Pure: no server-only import, no network, no Prisma.
 */

import type { Language } from "@/components/LanguageProvider";
import { infoPages } from "@/components/marketing/marketingInfoContent";
import type { MarketingLocale } from "@/lib/marketingAutomationSchema";
import { MARKETING_PAGE_EVIDENCE_TYPES } from "@/lib/marketingClaims";

/**
 * The marketing routes whose copy a claim may cite, and the `infoPages` entry
 * each one renders.
 *
 * Only the information pages. `/pricing` and the search-intent pages hold their
 * copy in component-local objects that are not addressable by key, so a claim
 * cannot cite a sentence on them -- and a price claim rests on a stored price
 * (lib/marketingFactSources.ts) rather than on a sentence, which is the case
 * those pages would otherwise be used for.
 */
export const MARKETING_EVIDENCE_PAGES = {
  "/about": "about",
  "/faq": "faq",
  "/refund": "refund",
  "/safety": "safety",
  "/support/help-centre": "helpCentre",
  "/terms": "terms",
} as const;

export type MarketingEvidenceRoute = keyof typeof MARKETING_EVIDENCE_PAGES;

export const isMarketingEvidenceRoute = (
  route: string,
): route is MarketingEvidenceRoute =>
  Object.prototype.hasOwnProperty.call(MARKETING_EVIDENCE_PAGES, route);

/**
 * The site language a marketing locale's page copy is written in.
 *
 * `null` is a decision, not a gap: see the note above about `zh-Hant`.
 */
export const MARKETING_LOCALE_PAGE_LANGUAGE: Record<
  MarketingLocale,
  Language | null
> = {
  en: "en",
  ko: "ko",
  "zh-Hans": "zh",
  "zh-Hant": null,
};

export type MarketingEvidenceRefusal =
  | "route_not_evidence_bearing"
  | "locale_has_no_page"
  | "key_not_found"
  | "key_not_a_string"
  /** A claim whose type requires page evidence and carries none. */
  | "evidence_not_page";

export type MarketingEvidenceResolution =
  | { ok: true; text: string }
  | { ok: false; refusal: MarketingEvidenceRefusal };

/**
 * Walk a dotted key inside a page's copy.
 *
 * Array indices are ordinary segments (`sections.1.title`), because the copy
 * holds arrays and a claim about the second question on the FAQ has to be able
 * to say so. Nothing here constructs a property name from the key without
 * checking it is an own property first: a key of `constructor` or `__proto__`
 * would otherwise resolve to something that is not page copy at all.
 */
const readKeyPath = (root: unknown, keyPath: string): unknown => {
  let current: unknown = root;
  for (const segment of keyPath.split(".")) {
    if (current === null || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};

/**
 * The sentence a feature or availability claim cites, or why there is none.
 *
 * The Guard compares the returned text to the draft's rendering. This does not
 * compare anything itself, because "the claim says what the page says" is the
 * Guard's rule and this module's job is only to say what the page says.
 */
export function resolveMarketingPageEvidence({
  pageRoute,
  localeKey,
  locale,
}: {
  pageRoute: string;
  localeKey: string;
  locale: MarketingLocale;
}): MarketingEvidenceResolution {
  if (!isMarketingEvidenceRoute(pageRoute)) {
    return { ok: false, refusal: "route_not_evidence_bearing" };
  }

  const language = MARKETING_LOCALE_PAGE_LANGUAGE[locale];
  if (!language) return { ok: false, refusal: "locale_has_no_page" };

  const page = infoPages[MARKETING_EVIDENCE_PAGES[pageRoute]] as Record<
    string,
    unknown
  >;
  const copy = Object.prototype.hasOwnProperty.call(page, language)
    ? page[language]
    : undefined;
  if (copy === undefined) return { ok: false, refusal: "locale_has_no_page" };

  const value = readKeyPath(copy, localeKey);
  if (value === undefined) return { ok: false, refusal: "key_not_found" };
  if (typeof value !== "string") {
    return { ok: false, refusal: "key_not_a_string" };
  }
  return { ok: true, text: value };
}

/**
 * The registered claims whose page evidence does not resolve.
 *
 * The same shape as `unservedMarketingLinkIds()` in
 * `lib/marketingApprovedLinks.ts`, and for the same reason: a registry entry
 * that points at something the build no longer serves is a defect the build
 * can find, and finding it at registration is cheaper than finding it when a
 * post is being checked.
 *
 * Checked per locale, because a claim covering `en` and `ko` makes the same
 * statement on two pages and either of them can be the one that moved.
 *
 * A claim whose *type* requires page evidence and carries none is reported
 * rather than skipped. Skipping on `evidence?.kind !== "page"` reads as "not my
 * business", and it is how a `feature` claim with `evidence: null` would pass
 * the check written to catch exactly that -- the check would agree it had
 * nothing to verify.
 */
export function unresolvedClaimEvidence(
  claims: ReadonlyArray<{
    id: string;
    type: string;
    locales: readonly MarketingLocale[];
    evidence: { kind: string; pageRoute?: string; localeKey?: string } | null;
  }>,
): Array<{
  claimId: string;
  locale: MarketingLocale | null;
  refusal: MarketingEvidenceRefusal;
}> {
  const unresolved: Array<{
    claimId: string;
    locale: MarketingLocale | null;
    refusal: MarketingEvidenceRefusal;
  }> = [];

  for (const claim of claims) {
    if (claim.evidence?.kind !== "page") {
      if (
        (MARKETING_PAGE_EVIDENCE_TYPES as readonly string[]).includes(claim.type)
      ) {
        // No locale: the claim has no evidence to be wrong in one.
        unresolved.push({
          claimId: claim.id,
          locale: null,
          refusal: "evidence_not_page",
        });
      }
      continue;
    }
    for (const locale of claim.locales) {
      const resolution = resolveMarketingPageEvidence({
        pageRoute: claim.evidence.pageRoute ?? "",
        localeKey: claim.evidence.localeKey ?? "",
        locale,
      });
      if (!resolution.ok) {
        unresolved.push({ claimId: claim.id, locale, refusal: resolution.refusal });
      }
    }
  }

  return unresolved;
}
