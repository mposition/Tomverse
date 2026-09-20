/**
 * The only destinations a marketing post may link to.
 *
 * Contract: docs/policy/marketing-automation.md §7.3 -- "the model does not
 * write URLs. It picks an id from the approved path list, and the server
 * assembles the URL." That sentence is the whole reason this file exists as a
 * list of ids rather than a validator over whatever a model produced: a check
 * on a generated URL can only ever answer "does this look acceptable", and the
 * answer has to be "is this one of the places we decided to send people".
 *
 * Every path here also has to be a real marketing route, which
 * `isStaticMarketingPathname()` in lib/marketingRoutes.ts decides. The test
 * asserts that for every entry, so a page that is renamed or withdrawn breaks
 * the build rather than becoming a post that links to a 404.
 *
 * Pure: no server-only import, no network, no Prisma.
 */

import { isStaticMarketingPathname } from "@/lib/marketingRoutes";

/**
 * Where a post can send a reader.
 *
 * The ids are stable and the paths are not: a page can move and the posts that
 * already went out keep meaning what they meant, because what they recorded is
 * the id.
 */
export const MARKETING_APPROVED_LINKS = {
  "link.home": "/",
  "link.pricing": "/pricing",
  "link.models": "/models",
  "link.faq": "/faq",
  "link.about": "/about",
  "link.support": "/support",
  "link.help-centre": "/support/help-centre",
  "link.safety": "/safety",
  "link.safety.approach": "/safety/approach",
  "link.safety.security-privacy": "/safety/security-privacy",
  "link.safety.trust-transparency": "/safety/trust-transparency",
  "link.compare-models": "/compare-ai-models",
  "link.answer-review": "/ai-answer-review",
  "link.file-analysis": "/ai-for-file-analysis",
} as const;

export type MarketingLinkId = keyof typeof MARKETING_APPROVED_LINKS;

export const MARKETING_LINK_IDS = Object.keys(
  MARKETING_APPROVED_LINKS,
) as MarketingLinkId[];

export const isMarketingLinkId = (value: unknown): value is MarketingLinkId =>
  typeof value === "string" &&
  Object.prototype.hasOwnProperty.call(MARKETING_APPROVED_LINKS, value);

/**
 * The path an id names, or `null`.
 *
 * `null` rather than a throw because the caller is the Guard, and an unknown id
 * is a draft to refuse rather than a crash to report.
 */
export const marketingLinkPath = (id: string): string | null =>
  isMarketingLinkId(id) ? MARKETING_APPROVED_LINKS[id] : null;

/** Whether every approved path is still a marketing route this app serves. */
export const unservedMarketingLinkIds = (): MarketingLinkId[] =>
  MARKETING_LINK_IDS.filter(
    (id) => !isStaticMarketingPathname(MARKETING_APPROVED_LINKS[id]),
  );
