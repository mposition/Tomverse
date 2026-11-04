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
