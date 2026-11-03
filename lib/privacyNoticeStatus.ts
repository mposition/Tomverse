/**
 * Whether the comment-monitoring section of the privacy policy is complete
 * enough to show (docs/policy/marketing-automation.md section 12.1).
 *
 * The section (`privacyPolicy.comments*`) carries operator-confirmation
 * placeholders for facts the code cannot know: the publishing tool's entity and
 * country, the legal basis, and how long the vendors keep the text. A public
 * notice must not show an unfinished sentence, so while this is false the page
 * does not render the section at all, and `tests/marketingPrivacyNotice.test.mjs`
 * requires the placeholders to be present. Setting it to true requires every
 * placeholder to be gone from every locale, and the same test fails otherwise.
 *
 * It decides what the page shows and nothing else: the comment monitor's own
 * switch (`MARKETING_COMMENTS_MONITOR_ENABLED`) stays a separate decision that
 * the checklist in docs/policy/marketing-privacy-dpia-checklist.md orders after
 * this one.
 */
export const COMMENTS_PRIVACY_NOTICE_CONFIRMED = false as boolean;
