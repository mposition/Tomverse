-- baseline-check: replace-function-if-body-sha256 "amux_idea_analysis_budget_window_limit_guard" "802eaffdf61753f30a6f7c9d99a79325ddeed42a9d24273bedeeb7408aaf8057"
-- docs/policy/amux-intake.md v16 repair. PostgreSQL xid8 text includes the
-- epoch after transaction ID wraparound, while a tuple xmin text does not.
-- Compare the current setting in the xid domain and preserve every other
-- namespace, effective-month, limit and usage-reset condition.
BEGIN;

CREATE OR REPLACE FUNCTION "amux_idea_analysis_budget_window_limit_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE latest_setting record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."limitMicroUsd" = OLD."limitMicroUsd" THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'));
  SELECT s.*, s.xmin AS setting_xid INTO latest_setting
    FROM "AmuxIdeaAnalysisBudgetSetting" s ORDER BY "version" DESC LIMIT 1;
  IF NEW."limitMicroUsd" <> COALESCE(latest_setting."limitMicroUsd", 50000000) OR
     (TG_OP = 'UPDATE' AND (latest_setting."id" IS NULL OR
       latest_setting.setting_xid <> pg_current_xact_id()::xid OR
       NEW."monthStart" IS DISTINCT FROM latest_setting."effectiveMonth" OR
       ROW(NEW."namespace", NEW."monthStart", NEW."spentMicroUsd", NEW."reservedMicroUsd", NEW."createdAt")
       IS DISTINCT FROM ROW(OLD."namespace", OLD."monthStart", OLD."spentMicroUsd", OLD."reservedMicroUsd", OLD."createdAt"))) THEN
    RAISE EXCEPTION 'analysis budget limit requires current owner approval; usage cannot reset'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
