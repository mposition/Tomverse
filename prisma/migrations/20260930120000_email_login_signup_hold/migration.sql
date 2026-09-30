-- A verified login code or link whose address has no account becomes a
-- one-time sign-up hold instead of an account.
--
-- Contract: docs/policy/email-product-news-redesign-draft.md section 5.2a (v25).
--
-- Sign-in and sign-up are separate screens now, and an account is created only
-- by a flow that meant to create one. When a sign-in proves an address that has
-- no account, the row is consumed as it always was -- a matched code is never
-- left usable for a sign-in -- and `signupHoldUntil` marks that the same code or
-- link may complete exactly one sign-up until it expires. `signupHoldUsedAt`
-- records that one use. Neither is ever cleared.
--
-- Additive only: two nullable columns and two checks that every existing row
-- satisfies (both columns are NULL on all of them).

ALTER TABLE "EmailLoginAttempt" ADD COLUMN "signupHoldUntil" TIMESTAMP(3);
ALTER TABLE "EmailLoginAttempt" ADD COLUMN "signupHoldUsedAt" TIMESTAMP(3);

-- A hold is placed only on a consumed row, and only a held row can be used.
ALTER TABLE "EmailLoginAttempt"
  ADD CONSTRAINT "EmailLoginAttempt_signup_hold_on_consumed_check"
  CHECK ("signupHoldUntil" IS NULL OR "consumedAt" IS NOT NULL);
ALTER TABLE "EmailLoginAttempt"
  ADD CONSTRAINT "EmailLoginAttempt_signup_hold_used_has_hold_check"
  CHECK ("signupHoldUsedAt" IS NULL OR "signupHoldUntil" IS NOT NULL);
