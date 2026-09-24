-- A closed vocabulary for RoutingAttempt.errorClass.
--
-- The column is documented as "a fixed classification, never provider error
-- text" and was bare TEXT: five strings written by four call sites, with
-- nothing stopping a sixth. Nothing reads it to decide anything, which is why
-- it drifted -- an operator-facing field that no code branches on has no other
-- guard than a constraint.
--
-- The provider-derived half is new. lib/providerErrorClassification.ts already
-- computed a category for every provider failure, and lib/routingStreamFailure.ts
-- read it, kept PAYMENT_REQUIRED and dropped the rest, so a rate limit, a 5xx,
-- a DNS failure and an unrecognised error all reached this column as one value
-- if they reached it at all. Separating capacity from availability is a later
-- change with its own scope; it cannot be made from records that never kept
-- the difference.
--
-- 'provider_pre_token_failure' is in the list although nothing writes it any
-- more. Rows already carry it, and a constraint that refuses its own history
-- is a constraint that can never be validated.
--
-- NOT VALID on purpose. This accepts every future write and checks no existing
-- row, because no report has yet been run against production to show that the
-- historical values are the five this list believes them to be. VALIDATE is a
-- separate migration, after that report returns zero -- the same order
-- docs/policy/credit-and-cost-limits.md uses for CreditLot.
--
-- Rollback: drop the constraint. Nothing else changes; no row is rewritten.

ALTER TABLE "RoutingAttempt" DROP CONSTRAINT IF EXISTS "RoutingAttempt_errorClass_check";
ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_errorClass_check"
    CHECK (
        "errorClass" IS NULL
        OR "errorClass" IN (
            'empty_response',
            'first_token_deadline_exceeded',
            'request_failed',
            'process_stopped_after_dispatch',
            'client_gone',
            'completion_handling_failed',
            'provider_pre_token_failure',
            'provider_policy_refusal',
            'provider_payment_required',
            'provider_rate_limited',
            'provider_server_error',
            'provider_network',
            'provider_authentication',
            'provider_request_contract',
            'provider_model_not_found',
            'provider_model_transient',
            'provider_local_rejection',
            'provider_unknown'
        )
    )
    NOT VALID;
