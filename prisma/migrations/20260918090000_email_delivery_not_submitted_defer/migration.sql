-- A pending delivery whose send step submitted nothing is waiting, not failing.
--
-- Contract: docs/policy/email-product-news-redesign-draft.md section 7.4
-- (time budgets), docs/policy/email-notifications.md section 9.8.
--
-- Every customer-facing send now takes the address lock and asks suppression
-- again inside it, immediately before the provider call. That step can end
-- without submitting for three reasons -- a writer holds the address, no
-- connection came free, or the transaction had too little life left to protect
-- a submission -- and in all three nothing was sent, no attempt was counted,
-- and the row goes back to pending on its existing backoff. The value names
-- the outcome rather than one of its causes, which the structured log carries.
-- Recording it in lastErrorKind would leave a stale error on a row that then
-- sent; this says what it is instead.

ALTER TABLE "EmailDelivery" DROP CONSTRAINT IF EXISTS "EmailDelivery_defer_reason_check";

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_defer_reason_check"
    CHECK ("deferReason" IS NULL OR "deferReason" IN ('quiet_hours', 'send_not_submitted'));
