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
 * - A date shown on the page that later edits did not move. `/terms` and
 *   `/refund` say "Last updated: July 15, 2026", yet the terms copy was edited
 *   on 2026-07-23, 2026-08-22 and 2026-08-25 and the refund copy on 2026-07-23
 *   without that line changing, so the displayed date is not the last change
 *   and is not repeated here.
 * - A single date for every page. That is what this replaced: 2026-07-15 on
 *   every entry, including pages that have changed many times since.
 *
 * `/privacy` qualifies: it shows "Effective: September 28, 2026" in all seven
 * locales. That date is the chat-provider notice, which now states only the
 * transfer Tomverse controls. Provider country, legal name, and retention
 * are still not on the page.
 *
 * `contentSha256` is what keeps that true. It is the digest of exactly what
 * the page renders from -- the component (LF line endings) followed by each
 * locale's `privacyPolicy` object as JSON, in the order en, ko, zh, fr, de,
 * es, pt -- and `tests/sitemapLastModified.test.mjs` recomputes it. Changing
 * the policy text therefore fails that test until someone decides whether the
 * change moves the effective date, and then updates the date shown on the
 * page, `date` here and the digest together.
 */
export type SitemapContentEvidence = {
    /** UTC calendar day, YYYY-MM-DD. */
    date: string;
    contentSha256: string;
};

export const SITEMAP_CONTENT_EVIDENCE: Readonly<Record<string, SitemapContentEvidence>> = {
    "/privacy": {
        date: "2026-09-28",
        contentSha256: "2e5e1a5c891c281692c4df1a54d79c95952b59a18afd1ff2ad5c0b36c4852e65",
    },
};
