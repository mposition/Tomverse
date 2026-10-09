-- Registers the billing-finance-ops agent on the shared AgentDigestItem table
-- (docs/policy/billing-finance-ops.md §1.1, §7 W1a), adds the stage W deadline
-- check and seeds the agent's app switch.
--
-- baseline-check: present-if-function "billing_finance_ops_assert_deadline"
--
-- Only the three per-agent values change: the agentKey list, that agent's
-- kind list and its body retention. Every other column, CHECK and trigger of
-- the shared table stays as 20261003000000_agent_digest_item made it.
--
-- Both CHECKs are widened, never narrowed, so every existing row still
-- satisfies them and the re-validation cannot fail.

ALTER TABLE "AgentDigestItem"
  DROP CONSTRAINT "AgentDigestItem_agent_key_check";
ALTER TABLE "AgentDigestItem"
  ADD CONSTRAINT "AgentDigestItem_agent_key_check"
  CHECK ("agentKey" IN ('qa-release', 'billing-finance-ops'));

ALTER TABLE "AgentDigestItem"
  DROP CONSTRAINT "AgentDigestItem_kind_check";
ALTER TABLE "AgentDigestItem"
  ADD CONSTRAINT "AgentDigestItem_kind_check"
  CHECK (("agentKey" = 'qa-release' AND "kind" IN ('daily_digest'))
      OR ("agentKey" = 'billing-finance-ops' AND "kind" IN ('price_deadline_digest')));

-- The insert trigger as before, with one more WHEN. An agent without a
-- retention still cannot insert.
CREATE OR REPLACE FUNCTION agent_digest_item_before_insert() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  -- Each agent's body-retention period. An agent without one cannot insert.
  retention INTERVAL := CASE NEW."agentKey"
    WHEN 'qa-release' THEN INTERVAL '90 days'
    WHEN 'billing-finance-ops' THEN INTERVAL '90 days'
  END;
BEGIN
  IF NEW."payload" IS NULL OR NEW."bodyDeletedAt" IS NOT NULL OR NEW."sizeBytes" <= 0 THEN
    RAISE EXCEPTION 'AgentDigestItem rows are inserted with their body'
      USING ERRCODE = 'check_violation';
  END IF;
  IF retention IS NULL THEN
    RAISE EXCEPTION 'AgentDigestItem has no body retention for this agent'
      USING ERRCODE = 'check_violation';
  END IF;
  NEW."createdAt" := clock_timestamp();
  NEW."retentionUntil" := NEW."createdAt" + retention;
  RETURN NEW;
END;
$$;

-- billing_finance_ops_assert_deadline() is the last statement of the stage W
-- digest transaction (policy §1.1 item 4). It reads the database clock and
-- raises when the run's deadline has passed, so the digest row and its audit
-- entry roll back together and a late run is never recorded as a success. A
-- NULL deadline also raises. Same shape as support_triage_assert_deadline():
-- no SET clause, SECURITY INVOKER, no EXCEPTION handler, schema-qualified
-- calls. It is also the name the baseline guard above probes for, since every
-- other change here is invisible to prisma migrate diff.
CREATE OR REPLACE FUNCTION "billing_finance_ops_assert_deadline"(deadline TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
AS $$
BEGIN
  IF deadline IS NULL OR pg_catalog.clock_timestamp() > deadline THEN
    RAISE EXCEPTION 'billing_finance_ops_deadline_passed'
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

-- The agent's app switch starts off. A missing row reads as unreadable, which
-- the policy treats as a fault rather than as "off" (§1.2), so the row exists
-- from the first deploy and only the Admin control route changes it.
INSERT INTO "AppSetting" ("key", "value", "createdAt", "updatedAt")
VALUES (
  'billingFinanceOps.control',
  json_build_object('enabled', false, 'revision', 0, 'enabledAt', NULL)::text,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("key") DO NOTHING;
