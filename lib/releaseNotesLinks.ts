/**
 * The only destinations a release-notes email may link to.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md section 8 --
 * "`link` is a product path id. It is chosen from a fixed table, and pricing,
 * billing and upgrade paths are not in the table."
 *
 * ## Why this is not `MARKETING_APPROVED_LINKS`
 *
 * That table exists and looks like the same thing. It is not, and the
 * difference is one entry: it contains `/pricing`, and this one must not.
 *
 * The reason is the rule these emails are written under. ACMA's Lululemon
 * decision (2026-03) puts it plainly: the simplest way to comply is to keep
 * transactional and service messages separate from sales content and links.
 * A release-notes email is marketing by classification and is read as product
 * news by the person receiving it; a price link inside one is the sales
 * content that decision is about. A social post has no such constraint --
 * nobody receives it in a mailbox they did not choose to open.
 *
 * So the two tables answer different questions and are allowed to hold the
 * same values where they agree. What is forbidden is deriving one from the
 * other: a subset expression would make the email table follow every future
 * addition to the marketing one, and the next commercial page added there
 * would appear here without anybody deciding it should.
 * `commercialLinkIdsInReleaseNotes()` below is the check that they have not
 * drifted into agreeing by accident.
 *
 * Pure: no server-only import, no network, no Prisma.
 */

import { isStaticMarketingPathname } from "@/lib/marketingRoutes";

/**
 * Where a release-notes item can send a reader.
 *
 * The ids are stable and the paths are not: a page can move and the emails
 * already sent keep meaning what they meant, because what they recorded is the
 * id.
 *
 * Frozen for the same reason the marketing table is: `as const` is a
 * compile-time claim, and an assignment to one of these entries would be a
 * destination nobody approved.
 */
export const RELEASE_NOTES_APPROVED_LINKS = Object.freeze({
  "release.home": "/",
  "release.models": "/models",
  "release.compare-models": "/compare-ai-models",
  "release.answer-review": "/ai-answer-review",
  "release.file-analysis": "/ai-for-file-analysis",
  "release.faq": "/faq",
  "release.support": "/support",
  "release.help-centre": "/support/help-centre",
  "release.safety": "/safety",
  "release.safety.approach": "/safety/approach",
  "release.safety.security-privacy": "/safety/security-privacy",
  "release.safety.trust-transparency": "/safety/trust-transparency",
} as const);

/** Where release-notes links point. One origin, and it is ours. */
export const RELEASE_NOTES_PUBLIC_ORIGIN = "https://tomverse.app";

export type ReleaseNotesLinkId = keyof typeof RELEASE_NOTES_APPROVED_LINKS;

export const RELEASE_NOTES_LINK_IDS: readonly ReleaseNotesLinkId[] =
  Object.freeze(
    Object.keys(RELEASE_NOTES_APPROVED_LINKS) as ReleaseNotesLinkId[]
  );

export const isReleaseNotesLinkId = (
  value: unknown
): value is ReleaseNotesLinkId =>
  typeof value === "string" &&
  Object.prototype.hasOwnProperty.call(RELEASE_NOTES_APPROVED_LINKS, value);

/**
 * The path an id names, or `null`.
 *
 * `null` rather than a throw: the caller is validating a payload somebody
 * composed, and an unknown id is a draft to refuse with a message rather than
 * a crash to report.
 */
export const releaseNotesLinkPath = (id: string): string | null =>
  isReleaseNotesLinkId(id) ? RELEASE_NOTES_APPROVED_LINKS[id] : null;

/**
 * Paths this table must never contain.
 *
 * Prefix matches, because `/pricing`, `/pricing/annual` and `/pricing?plan=max`
 * are the same decision. Held as a list rather than as one regular expression
 * so that a reader can see which four things are excluded and a sixth is a
 * line somebody added on purpose.
 */
export const COMMERCIAL_PATH_PREFIXES = Object.freeze([
  "/pricing",
  "/billing",
  "/upgrade",
  "/checkout",
] as const);

export const isCommercialPath = (path: string): boolean =>
  COMMERCIAL_PATH_PREFIXES.some(
    (prefix) => path === prefix || path.startsWith(`${prefix}/`)
  );

/**
 * Any id in this table whose path is a commercial one.
 *
 * Empty is the only acceptable answer, and the test asserts that. It exists as
 * a function rather than as a comment because the table will grow: the entry
 * somebody adds without thinking about section 8 is the one this catches.
 */
export const commercialLinkIdsInReleaseNotes = (): ReleaseNotesLinkId[] =>
  RELEASE_NOTES_LINK_IDS.filter((id) =>
    isCommercialPath(RELEASE_NOTES_APPROVED_LINKS[id])
  );

/** Whether every approved path is still a route this app serves. */
export const unservedReleaseNotesLinkIds = (): ReleaseNotesLinkId[] =>
  RELEASE_NOTES_LINK_IDS.filter(
    (id) => !isStaticMarketingPathname(RELEASE_NOTES_APPROVED_LINKS[id])
  );

/**
 * The absolute URL a path names.
 *
 * The origin is compared **after** assembly rather than the path inspected
 * before it, for the reason `lib/marketingLinks.ts` records: a path is not the
 * safe input to `new URL(path, origin)` that it looks like. `//evil.test/x` is
 * protocol-relative and resolves to another host, `https://evil.test` replaces
 * the base outright, and a backslash is normalised to a slash by the parser
 * before either is visible. Inspecting the string first means enumerating
 * those; asking the parser what it actually built is the thing that matters.
 *
 * The table above already restricts the input to twelve frozen entries, so
 * this is the check that would still hold if that table were wrong.
 */
export const releaseNotesLinkUrl = (path: string, field: string): string => {
  const url = new URL(path, RELEASE_NOTES_PUBLIC_ORIGIN);
  if (url.origin !== RELEASE_NOTES_PUBLIC_ORIGIN) {
    throw new Error(`${field} resolves outside ${RELEASE_NOTES_PUBLIC_ORIGIN}.`);
  }
  if (isCommercialPath(url.pathname)) {
    throw new Error(`${field} resolves to a commercial path.`);
  }
  return url.toString();
};
