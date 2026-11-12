/**
 * Whether the comment-monitoring section of the privacy policy is complete
 * enough to show (docs/policy/marketing-automation.md section 12.1).
 *
 * The section (`privacyPolicy.comments*`) once carried operator-confirmation
 * placeholders for facts the code cannot know: the publishing tool's entity and
 * country, the legal basis, and how long the vendors keep the text. The
 * operator confirmed them on 2026-11-04 (docs/policy/marketing-privacy-dpia-checklist.md,
 * section 5) and every locale now states them, so this is true and the page
 * renders the section. A public notice must not show an unfinished sentence, so
 * `tests/marketingPrivacyNotice.test.mjs` fails if a placeholder is ever left in
 * any locale while this is true, and requires the placeholders to be present if
 * it is set back to false.
 *
 * It decides what the page shows and nothing else: the comment monitor's own
 * switch (`MARKETING_COMMENTS_MONITOR_ENABLED`) stays a separate decision that
 * the checklist orders after this one. The monitor refuses to run while this
 * is false (`lib/marketingCommentsMonitor.ts`).
 */
export const COMMENTS_PRIVACY_NOTICE_CONFIRMED = true as boolean;

/**
 * Whether the semantic-search section of the privacy policy
 * (`privacyPolicy.semanticSearch*`) is complete enough to show, and therefore
 * whether the semantic calls to Cohere may run
 * (docs/policy/external-conversation-import-and-memory.md sections 9a and 16).
 *
 * The section carries three operator-confirmation placeholders for facts the
 * code cannot know: the country where Cohere processes the requests, that
 * Tomverse has opted out of training on them, and how long Cohere keeps them.
 * Until the operator confirms them and writes the facts into every locale this
 * stays false, the page does not render the section, and no semantic call is
 * made (`lib/semanticRetrievalCore.ts` reads this same value). A public notice
 * must not show an unfinished sentence, so
 * `tests/semanticSearchPrivacyNotice.test.mjs` requires the placeholders to be
 * present while this is false and absent once it is true.
 *
 * This file is part of the /privacy page digest
 * (tests/support/amendedDocumentVerifiers.mjs), so setting this to true is the
 * operator's approval of a new /privacy version, not a side effect of a code
 * change. Display and permission are one value on purpose: the page can never
 * say less than what is sent.
 */
export const SEMANTIC_SEARCH_PRIVACY_NOTICE_CONFIRMED = false as boolean;
