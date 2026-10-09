-- Registers the sre-ops agent on the shared AgentDigestItem table
-- (docs/policy/sre-ops.md §1 item 3, §9 N-4, §10).
--
-- baseline-check: replace-function-if-body-sha256 "agent_digest_item_before_insert" "645d567c1c37b2552cad31a4bed96df4d85ce1f9c70c8c4a2204d90d6247b725"
--
-- Only the three per-agent values change: the agentKey list, that agent's
-- kind list (daily_digest, the daily summary) and its body retention (90 days,
-- §10). Every other column, CHECK and trigger of the shared table stays as
-- 20261003000000_agent_digest_item and 20261004000000_agent_digest_billing_finance_ops
-- left it, including the 16 KiB payload limit and the 365-day meta purge (N-4).
--
-- Both CHECKs are widened, never narrowed, so every existing row still
-- satisfies them and the re-validation cannot fail. The insert trigger is
-- replaced only when its body is exactly the one the billing migration wrote.

ALTER TABLE "AgentDigestItem"
  DROP CONSTRAINT "AgentDigestItem_agent_key_check";
ALTER TABLE "AgentDigestItem"
  ADD CONSTRAINT "AgentDigestItem_agent_key_check"
  CHECK ("agentKey" IN ('qa-release', 'billing-finance-ops', 'sre-ops'));

ALTER TABLE "AgentDigestItem"
  DROP CONSTRAINT "AgentDigestItem_kind_check";
ALTER TABLE "AgentDigestItem"
  ADD CONSTRAINT "AgentDigestItem_kind_check"
  CHECK (("agentKey" = 'qa-release' AND "kind" IN ('daily_digest'))
      OR ("agentKey" = 'billing-finance-ops' AND "kind" IN ('price_deadline_digest'))
      OR ("agentKey" = 'sre-ops' AND "kind" IN ('daily_digest')));

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
    WHEN 'sre-ops' THEN INTERVAL '90 days'
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
