-- Owner-managed analysis ceilings. No seed, usage reset, call or live switch.
BEGIN;

ALTER TABLE "AmuxIdeaAnalysisBudgetWindow"
  DROP CONSTRAINT "AmuxIdeaAnalysisBudgetWindow_amount_check",
  ADD CONSTRAINT "AmuxIdeaAnalysisBudgetWindow_amount_check" CHECK (
    "limitMicroUsd" > 0 AND "spentMicroUsd" >= 0 AND "reservedMicroUsd" >= 0 AND
    "reservedMicroUsd" <= "limitMicroUsd"
  );
-- The existing total_check (spent <= limit - reserved) remains unchanged.

CREATE TABLE "AmuxIdeaAnalysisBudgetSetting" (
  "id" TEXT PRIMARY KEY,
  "version" INTEGER NOT NULL UNIQUE,
  "limitMicroUsd" BIGINT NOT NULL,
  "effectiveMonth" TIMESTAMP(3) NOT NULL,
  "approvedByUserId" TEXT NOT NULL,
  "approvalAuditLogId" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AmuxIdeaAnalysisBudgetSetting_value_check" CHECK (
    "version" > 0 AND "limitMicroUsd" > 0 AND "limitMicroUsd" % 10000 = 0
  ),
  CONSTRAINT "AmuxIdeaAnalysisBudgetSetting_audit_fkey" FOREIGN KEY ("approvalAuditLogId")
    REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION "amux_idea_analysis_budget_setting_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE latest_version integer; latest_limit bigint; audit_row record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'analysis budget setting is append only' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'));
  SELECT "version", "limitMicroUsd" INTO latest_version, latest_limit
    FROM "AmuxIdeaAnalysisBudgetSetting" ORDER BY "version" DESC LIMIT 1;
  SELECT a.*, a.xmin::text AS audit_xid INTO audit_row FROM "AdminAuditLog" a
    WHERE a."id" = NEW."approvalAuditLogId";
  IF NEW."version" <> COALESCE(latest_version, 0) + 1 OR
    NEW."effectiveMonth" IS DISTINCT FROM date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) OR
    audit_row."id" IS NULL OR audit_row.audit_xid <> pg_current_xact_id()::text OR
    audit_row."actorUserId" IS DISTINCT FROM NEW."approvedByUserId" OR
    audit_row."actorUserId" IS NULL OR audit_row."entryHash" IS NULL OR
    audit_row."action" <> 'amux.idea.analysis_budget.updated' OR
    audit_row."targetType" <> 'AmuxIdeaAnalysisBudgetSetting' OR
    audit_row."targetId" IS DISTINCT FROM NEW."id" OR
    audit_row."metadata" ? 'systemActor' OR
    audit_row."metadata"->>'namespace' IS DISTINCT FROM 'agent/amux-intake' OR
    audit_row."metadata"->>'version' IS DISTINCT FROM NEW."version"::text OR
    audit_row."metadata"->>'previousVersion' IS DISTINCT FROM COALESCE(latest_version, 0)::text OR
    audit_row."metadata"->>'previousLimitMicroUsd' IS DISTINCT FROM COALESCE(latest_limit, 50000000)::text OR
    audit_row."metadata"->>'limitMicroUsd' IS DISTINCT FROM NEW."limitMicroUsd"::text OR
    audit_row."metadata"->>'effectiveMonth' IS DISTINCT FROM to_char(NEW."effectiveMonth", 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') THEN
    RAISE EXCEPTION 'analysis budget approval evidence mismatch' USING ERRCODE = '23514';
  END IF;
  NEW."createdAt" := clock_timestamp() AT TIME ZONE 'UTC';
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxIdeaAnalysisBudgetSetting_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaAnalysisBudgetSetting"
  FOR EACH ROW EXECUTE FUNCTION "amux_idea_analysis_budget_setting_guard"();

CREATE FUNCTION "amux_idea_analysis_budget_window_limit_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE latest_setting record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."limitMicroUsd" = OLD."limitMicroUsd" THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'));
  SELECT s.*, s.xmin::text AS setting_xid INTO latest_setting
    FROM "AmuxIdeaAnalysisBudgetSetting" s ORDER BY "version" DESC LIMIT 1;
  IF NEW."limitMicroUsd" <> COALESCE(latest_setting."limitMicroUsd", 50000000) OR
     (TG_OP = 'UPDATE' AND (latest_setting."id" IS NULL OR
       latest_setting.setting_xid <> pg_current_xact_id()::text OR
       NEW."monthStart" IS DISTINCT FROM latest_setting."effectiveMonth" OR
       ROW(NEW."namespace", NEW."monthStart", NEW."spentMicroUsd", NEW."reservedMicroUsd", NEW."createdAt")
       IS DISTINCT FROM ROW(OLD."namespace", OLD."monthStart", OLD."spentMicroUsd", OLD."reservedMicroUsd", OLD."createdAt"))) THEN
    RAISE EXCEPTION 'analysis budget limit requires current owner approval; usage cannot reset'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxIdeaAnalysisBudgetWindow_limit_guard"
  BEFORE INSERT OR UPDATE ON "AmuxIdeaAnalysisBudgetWindow"
  FOR EACH ROW EXECUTE FUNCTION "amux_idea_analysis_budget_window_limit_guard"();

CREATE FUNCTION "amux_idea_analysis_budget_setting_commit_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "AmuxIdeaAnalysisBudgetWindow" w
    WHERE w."namespace" = 'agent/amux-intake' AND w."monthStart" = NEW."effectiveMonth"
      AND w."limitMicroUsd" <> NEW."limitMicroUsd") THEN
    RAISE EXCEPTION 'analysis budget setting and current window disagree' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "AmuxIdeaAnalysisBudgetSetting_commit_guard"
  AFTER INSERT ON "AmuxIdeaAnalysisBudgetSetting" DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "amux_idea_analysis_budget_setting_commit_guard"();
COMMIT;
