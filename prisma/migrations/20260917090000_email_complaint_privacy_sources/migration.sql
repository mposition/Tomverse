-- A spam complaint and a deletion request both switch preferences off, and
-- the complaint also withdraws consent. The preference and consent rows say
-- where each change came from, so the two writers need values of their own.
--
-- Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4
-- (complaint is also a purpose opt-out; privacy request).
--
-- Widening only: every row valid before is valid after.

ALTER TABLE "EmailPreference" DROP CONSTRAINT "EmailPreference_source_check";
ALTER TABLE "EmailPreference" ADD CONSTRAINT "EmailPreference_source_check"
    CHECK ("source" IN (
        'signup', 'preference_center', 'unsubscribe_link', 'admin', 'system_default',
        'privacy_request', 'provider_complaint'
    ));

ALTER TABLE "ConsentRecord" DROP CONSTRAINT "ConsentRecord_captured_via_check";
ALTER TABLE "ConsentRecord" ADD CONSTRAINT "ConsentRecord_captured_via_check"
    CHECK ("capturedVia" IN (
        'signup_form', 'preference_center', 'unsubscribe_page', 'import', 'admin',
        'provider_complaint'
    ));
