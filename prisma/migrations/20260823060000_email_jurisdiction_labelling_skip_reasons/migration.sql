-- Two more answers to "why did this person not get it".
--
-- The composition step that applies a jurisdiction's subject prefix and footer
-- can refuse, and it refuses only for marketing: an advertisement that cannot
-- be labelled the way its recipient's jurisdiction requires is one that must
-- not be sent, because an unlabelled advertisement cannot be taken back once it
-- has arrived (docs/policy/email-notifications.md §5.2 E1-E3).
--
-- Two values rather than one because the operator's next move differs. A
-- missing profile means the pinned policy version has no row for the pinned
-- key, which is a data problem in the policy; an incomplete footer means a
-- business identity value is unset, which is an environment variable. Folding
-- them together would send whoever is on call to read the send code, which is
-- the thing this column exists to make unnecessary.
--
-- Additive: every existing value stays legal, so no row is invalidated.
ALTER TABLE "EmailDelivery" DROP CONSTRAINT IF EXISTS "EmailDelivery_skip_reason_check";

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_skip_reason_check"
    CHECK ("skipReason" IS NULL OR "skipReason" IN (
        'no_consent', 'consent_lapsed', 'suppressed_complaint', 'hard_bounce',
        'quiet_hours', 'jurisdiction_conflict', 'jurisdiction_unconfirmed',
        'jurisdiction_profile_missing', 'jurisdiction_footer_incomplete',
        'credential_expired', 'dry_run'
    ));
