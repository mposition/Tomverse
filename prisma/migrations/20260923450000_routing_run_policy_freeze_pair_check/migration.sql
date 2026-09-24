-- Replace the policy-freeze check. The first one did not reject a half pair.
--
-- A regex compared with NULL is NULL, and a CHECK passes when its
-- expression is TRUE or NULL. `controlPlaneVersion` set and
-- `accountPolicyVersion` NULL made the positive branch NULL, so the row
-- was stored. `IS NOT NULL` is FALSE for a null column, and FALSE AND
-- anything is FALSE, so the positive branch can no longer be saved by a
-- null regex.
--
-- The first migration is left as it was applied. This statement drops that
-- check and adds the replacement under the same name.
--
-- Existing rows are both null: nothing writes these columns, so validating
-- the replacement does not rewrite them. NOT VALID would leave the hole
-- open until a later validation, which is the hole.
--
-- Rollback: drop this check and recreate the previous expression only if
-- a half pair should be stored again. It should not.

ALTER TABLE "RoutingRun" DROP CONSTRAINT "RoutingRun_policy_freeze_pair_check";

ALTER TABLE "RoutingRun"
    ADD CONSTRAINT "RoutingRun_policy_freeze_pair_check"
    CHECK (
        (
            "controlPlaneVersion" IS NULL
            AND "accountPolicyVersion" IS NULL
        )
        OR (
            "controlPlaneVersion" IS NOT NULL
            AND "accountPolicyVersion" IS NOT NULL
            AND "controlPlaneVersion" ~ E'[^ \\t\\n\\r\\f\\v]'
            AND "accountPolicyVersion" ~ E'[^ \\t\\n\\r\\f\\v]'
        )
    );
