-- The marketing country allowlist's own skip reason.
--
-- Contract: docs/policy/email-eea-marketing-review-2026-09-14.md §7 condition 7;
-- docs/policy/email-notifications.md §6.3.
--
-- A profile says which rules would apply to a country; the allowlist says
-- somebody has checked that those rules are enough there. A person whose
-- country is confirmed but not on the list is neither `jurisdiction_conflict`
-- nor `jurisdiction_unconfirmed` -- we know where they live -- so collapsing
-- this into either would send support looking for a country question that has
-- already been answered.
--
-- Written only by the send path, for marketing only. Consent stored before the
-- list existed is what reaches it: the opt-in boundary refuses new consent from
-- these countries, and this reason is how an older one is skipped rather than
-- sent.

ALTER TABLE "EmailDelivery" DROP CONSTRAINT IF EXISTS "EmailDelivery_skip_reason_check";

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_skip_reason_check"
    CHECK ("skipReason" IS NULL OR "skipReason" IN (
        'no_consent', 'consent_lapsed', 'suppressed_complaint', 'hard_bounce',
        'quiet_hours', 'jurisdiction_conflict', 'jurisdiction_unconfirmed',
        'jurisdiction_profile_missing', 'jurisdiction_footer_incomplete',
        'credential_expired', 'dry_run', 'marketing_halted',
        'marketing_disabled', 'marketing_country_not_allowed'
    ));
