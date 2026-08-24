/**
 * The three flags the email ADR names, and what each one actually gates.
 *
 * Contract: docs/policy/email-notifications.md §15.2;
 * .github/audits/model-lifecycle-email-2026-08-22.md EM-05.
 *
 * §15.2 says these are built and left off behind `AppSetting`, fail-closed,
 * until the legal review lands. All three were named in that table and none of
 * them existed in the code: searching for `emailMarketingEnabled` returned
 * nothing at all, so a person following the ADR went looking for a switch that
 * had never been built.
 *
 * ## The flag does not replace the structural block
 *
 * Marketing is already impossible today for two reasons that have nothing to do
 * with a flag: no template is classified `marketing`, and `MARKETING_EMAIL_FROM`
 * is unset so the stream refuses rather than falling back to the transactional
 * identity (§5.3.1). Those are *stronger* than a setting — they cannot be
 * undone by an UPDATE — and this flag is added in front of them, never in place
 * of them. Order at enqueue is flag, then template, then identity.
 *
 * ## Default off, and unreadable means off
 *
 * The same shape as the memory rollout flags in `lib/memoryAccess.ts`: only the
 * exact string `"true"` enables. A missing row, an empty row, `"TRUE"`, `"1"`
 * and a typo all read as off, because the direction that fails safely is the
 * one where a marketing send does not happen.
 */

export const EMAIL_MARKETING_FLAG_KEY = "feature.emailMarketingEnabled";
export const EMAIL_CAMPAIGNS_FLAG_KEY = "feature.emailCampaignsEnabled";

/**
 * The two-year consent re-confirmation batch (§15.2).
 *
 * Declared and read by nothing, deliberately: **the batch does not exist yet.**
 * The key is here so the name in the ADR resolves to something a reader can
 * find, with this sentence attached, rather than to nothing at all — which is
 * the EM-05 finding. Wiring it to a no-op consumer would be worse: a flag whose
 * switch does nothing teaches an operator that flags do nothing.
 *
 * When the batch is built, it reads this key through `isEmailConsentReconfirmEnabled`
 * and the sentence above comes out.
 */
export const EMAIL_CONSENT_RECONFIRM_FLAG_KEY =
  "feature.emailConsentReconfirmEnabled";

export const EMAIL_FEATURE_FLAG_KEYS = [
  EMAIL_MARKETING_FLAG_KEY,
  EMAIL_CAMPAIGNS_FLAG_KEY,
  EMAIL_CONSENT_RECONFIRM_FLAG_KEY,
] as const;

export type EmailFeatureFlagKey = (typeof EMAIL_FEATURE_FLAG_KEYS)[number];

/**
 * Whether a stored `AppSetting` value turns a flag on.
 *
 * One function for all three rather than three identical ones: they are the
 * same decision, and three copies is three chances for one of them to start
 * accepting `"1"`.
 */
export const emailFeatureEnabledFromValue = (
  value: string | null | undefined
): boolean => value === "true";

/**
 * Why an enqueue produced no row.
 *
 * `enqueueStandardEmail` used to answer this with a bare `null`, which said
 * that nothing was written and nothing about why. A caller could not tell an
 * account with no address from a feature that is switched off, and EM-05's
 * acceptance criterion asks for the reason.
 */
export const ENQUEUE_REFUSALS = [
  "no_address",
  "marketing_disabled",
] as const;

export type EnqueueRefusal = (typeof ENQUEUE_REFUSALS)[number];

export const ENQUEUE_REFUSAL_MESSAGE: Record<EnqueueRefusal, string> = {
  no_address: "The account has no email address to write to.",
  marketing_disabled:
    "Marketing sending is switched off. Nothing was queued: a message written now would sit in the outbox waiting for a decision that has not been made.",
};

/**
 * Whether a classification is gated by the marketing flag.
 *
 * Marketing alone. A switch that could reach transactional mail would be a
 * second route to login codes not arriving, which is the same reasoning that
 * keeps the send-health kill switch (§14.5) marketing-only.
 */
export const marketingFlagApplies = (classification: string): boolean =>
  classification === "marketing";

export type CampaignActionRefusal = {
  refusal: "campaigns_disabled";
  message: string;
};

export const CAMPAIGNS_DISABLED_MESSAGE =
  "The campaign feature is switched off. Reading what already exists is still allowed; drafting, approving, scheduling, estimating and sending are not.";

/**
 * The campaign feature's own gate, separate from the marketing one.
 *
 * Two flags because they answer different questions and were listed separately
 * in §15.2. A campaign is a fan-out mechanism, not a classification: a model
 * retirement notice is `service`, goes out through the same waves, and is not
 * marketing. Folding the two together would either switch off retirement
 * notices with marketing, or switch marketing on with them.
 */
export const campaignActionRefusal = (
  enabled: boolean
): CampaignActionRefusal | null =>
  enabled
    ? null
    : { refusal: "campaigns_disabled", message: CAMPAIGNS_DISABLED_MESSAGE };
