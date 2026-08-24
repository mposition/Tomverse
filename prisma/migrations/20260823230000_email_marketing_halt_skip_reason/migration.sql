-- One more answer to "why did this person not get it": marketing stopped
-- itself.
--
-- Section 14.5 of docs/policy/email-notifications.md sets bounce and complaint
-- thresholds past which marketing sending halts. Nothing implemented them, so a
-- send that started drawing complaints kept going until somebody watched a
-- dashboard (EM-09).
--
-- Its own value rather than reuse of an existing one because the operator's
-- next move is unlike any of them. `suppressed_complaint` is about one address
-- and needs nothing done; this is about the stream and stays until a person
-- looks at why and clears it. Folding them together would hide a halted stream
-- inside a column that usually means "this one recipient, as expected".
--
-- Marketing only, and only marketing can reach it: the halt is checked on the
-- marketing branch alone, because provider suppression is already account-wide
-- (section 5.3.1) and a switch that could stop transactional mail would be a
-- second route to login codes not arriving.
--
-- Additive: every existing value stays legal, so no row is invalidated.
ALTER TABLE "EmailDelivery" DROP CONSTRAINT IF EXISTS "EmailDelivery_skip_reason_check";

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_skip_reason_check"
    CHECK ("skipReason" IS NULL OR "skipReason" IN (
        'no_consent', 'consent_lapsed', 'suppressed_complaint', 'hard_bounce',
        'quiet_hours', 'jurisdiction_conflict', 'jurisdiction_unconfirmed',
        'jurisdiction_profile_missing', 'jurisdiction_footer_incomplete',
        'credential_expired', 'dry_run', 'marketing_halted'
    ));
