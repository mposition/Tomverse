-- Why a pending delivery is waiting, when the wait is not a retry.
--
-- Contract: docs/policy/email-notifications.md §5.2 E5, §12.6.
--
-- A marketing message reached inside a night-time window is deferred to the
-- window's end. Recording that in lastErrorKind overwrote real errors and left a
-- stale "error" on rows that later sent; a column of its own says what it is.
-- The queue backlog metrics exclude a row only while it is deferred *and* not
-- yet due, so a morning that falls behind is still reported.

ALTER TABLE "EmailDelivery" ADD COLUMN "deferReason" TEXT;

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_defer_reason_check"
    CHECK ("deferReason" IS NULL OR "deferReason" IN ('quiet_hours'));

-- A delivery whose campaign was cancelled before it went out. Before this the
-- cancellation updated the campaign and its waves and left delivery rows to
-- the lane, which never looked -- so a message waiting out a night window, or a
-- retry, still went out after "cancel".
ALTER TABLE "EmailDelivery" DROP CONSTRAINT IF EXISTS "EmailDelivery_skip_reason_check";

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_skip_reason_check"
    CHECK ("skipReason" IS NULL OR "skipReason" IN (
        'no_consent', 'consent_lapsed', 'suppressed_complaint', 'hard_bounce',
        'quiet_hours', 'jurisdiction_conflict', 'jurisdiction_unconfirmed',
        'jurisdiction_profile_missing', 'jurisdiction_footer_incomplete',
        'credential_expired', 'dry_run', 'marketing_halted',
        'marketing_disabled', 'marketing_country_not_allowed',
        'campaign_cancelled'
    ));
