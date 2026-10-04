/**
 * AEO-04: the dates the sitemap may put in `<lastmod>`.
 *
 * `lastmod` is a claim that a page's content changed on that day. Search
 * engines that find it inaccurate learn to ignore it for the whole site, so a
 * page gets one only when something other than this file already vouches for
 * the date. Every other page omits it, which is allowed and says nothing false.
 *
 * What does not count as evidence:
 *
 * - The build or request time. The page did not change because it was served.
 * - A date shown on the page that later edits did not move. `/terms` (until
 *   the 2026-10-03 amendment, which shows its future effective date) and
 *   `/refund` said "Last updated: July 15, 2026", yet the terms copy was edited
 *   on 2026-07-23, 2026-08-22 and 2026-08-25 and the refund copy on 2026-07-23
 *   without that line changing, so the displayed date is not the last change
 *   and is not repeated here.
 * - A single date for every page. That is what this replaced: 2026-07-15 on
 *   every entry, including pages that have changed many times since.
 *
 * `/privacy` qualified while it showed "Effective: September 28, 2026" in all seven
 * locales. That date is the chat-provider notice, including the per-provider
 * table of recipient, place, training, retention, and sale or advertising.
 * The table is on the page only while every enrolled row is disclosable.
 *
 * `contentSha256` is what keeps that true. It is the digest of exactly what
 * the page renders from -- the component (LF line endings), then
 * `lib/providerDataDestinations.ts` (LF line endings, because the table reads
 * it), followed by each locale's `privacyPolicy` object as JSON, in the order
 * en, ko, zh, fr, de, es, pt -- and `tests/sitemapLastModified.test.mjs`
 * recomputes it. Changing the policy text or a destination fact therefore
 * fails that test until someone decides whether the change moves the
 * effective date, and then updates the date shown on the page, `date` here
 * and the digest together.
 *
 * While /privacy is not in the table below, both privacy tests there are
 * skipped (the shown-date match and the digest), and the same
 * digest is held by the publication gate instead: AMENDED_DOCUMENT_EVIDENCE in
 * lib/emailPolicyPublication.ts, recomputed by
 * tests/support/amendedDocumentVerifiers.mjs through
 * tests/emailPolicyPublication.test.mjs. That is the check that fails on an
 * edit until the entry comes back here.
 */
export type SitemapContentEvidence = {
    /** UTC calendar day, YYYY-MM-DD. */
    date: string;
    contentSha256: string;
};

export const SITEMAP_CONTENT_EVIDENCE: Readonly<Record<string, SitemapContentEvidence>> = {
    // /privacy is not dated while its shown date is in the future. The S10
    // amendment (docs/policy/email-policy-amendment-draft.md) was published
    // ahead of its 2026-11-16 effective date, and a lastmod is a claim that the
    // content changed on that day -- a future day is not one. The page omits
    // lastmod, which is allowed and says nothing false. Its digest is held by
    // the publication gate instead (AMENDED_DOCUMENT_EVIDENCE in
    // lib/emailPolicyPublication.ts), whose verifier still fails on any edit.
    // Once 2026-11-16 has passed, the entry can come back with that date.
};
