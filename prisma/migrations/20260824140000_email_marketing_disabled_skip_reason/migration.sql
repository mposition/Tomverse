-- The feature flag's own skip reason (EM-05).
--
-- Contract: docs/policy/email-notifications.md §15.2;
-- .github/audits/model-lifecycle-email-2026-08-22.md EM-05.
--
-- `marketing_halted` already exists and means something else: the stream's
-- reputation kill switch tripped (§14.5). This one means the feature is
-- switched off, which is a decision rather than an incident, and collapsing the
-- two would make "somebody turned marketing off" and "our complaint rate went
-- through the roof" the same row -- with the same follow-up.
--
-- Only the send path writes it. An enqueue refused by the flag creates no row
-- at all, so there is nothing to mark; this is for a row queued while the flag
-- was on and reached after it went off.

ALTER TABLE "EmailDelivery" DROP CONSTRAINT IF EXISTS "EmailDelivery_skip_reason_check";

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_skip_reason_check"
    CHECK ("skipReason" IS NULL OR "skipReason" IN (
        'no_consent', 'consent_lapsed', 'suppressed_complaint', 'hard_bounce',
        'quiet_hours', 'jurisdiction_conflict', 'jurisdiction_unconfirmed',
        'jurisdiction_profile_missing', 'jurisdiction_footer_incomplete',
        'credential_expired', 'dry_run', 'marketing_halted',
        'marketing_disabled'
    ));
