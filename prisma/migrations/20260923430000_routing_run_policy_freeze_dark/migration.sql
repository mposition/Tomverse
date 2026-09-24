-- The versions a request holds from the moment it starts.
--
-- ADR v2.1 section 2.1 reads the active control-plane manifest once and the
-- account policy in the same look. A promotion during the request does not
-- mix into that request. Section 3.5's pin compares the account policy
-- captured here. This product has no workspace, so the ADR's workspace
-- policy is the account policy.
--
-- Both columns are nullable and have no default. Existing rows stay null.
-- Null is not the policy that is active now, and a backfill would claim a
-- freeze nobody made. One column without the other is not a freeze, so the
-- check accepts only the pair or the absence of both.
--
-- Nothing writes these columns. They are dark, listed beside the other
-- RoutingRun columns the request path must not name.
--
-- Rollback: drop the check, then drop both columns, after confirming no
-- runtime source reads them.

ALTER TABLE "RoutingRun"
    ADD COLUMN "controlPlaneVersion" TEXT,
    ADD COLUMN "accountPolicyVersion" TEXT;

ALTER TABLE "RoutingRun"
    ADD CONSTRAINT "RoutingRun_policy_freeze_pair_check"
    CHECK (
        (
            "controlPlaneVersion" IS NULL
            AND "accountPolicyVersion" IS NULL
        )
        OR (
            "controlPlaneVersion" ~ E'[^ \\t\\n\\r\\f\\v]'
            AND "accountPolicyVersion" ~ E'[^ \\t\\n\\r\\f\\v]'
        )
    );
