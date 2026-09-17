-- A pending delivery that lost the address lock is waiting, not failing.
--
-- Contract: docs/policy/email-product-news-redesign-draft.md section 7.4
-- (time budgets), docs/policy/email-notifications.md section 9.8.
--
-- Every customer-facing send now takes the address lock and asks suppression
-- again inside it, immediately before the provider call. A send that cannot
-- take the lock within its budget submits nothing and releases its claim
-- without counting an attempt, so the row goes back to pending with its
-- existing backoff. Recording that in lastErrorKind would leave a stale error
-- on a row that then sent; this says what it is instead.

ALTER TABLE "EmailDelivery" DROP CONSTRAINT IF EXISTS "EmailDelivery_defer_reason_check";

ALTER TABLE "EmailDelivery" ADD CONSTRAINT "EmailDelivery_defer_reason_check"
    CHECK ("deferReason" IS NULL OR "deferReason" IN ('quiet_hours', 'send_lock'));
