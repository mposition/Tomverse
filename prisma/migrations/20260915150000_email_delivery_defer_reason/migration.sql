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
