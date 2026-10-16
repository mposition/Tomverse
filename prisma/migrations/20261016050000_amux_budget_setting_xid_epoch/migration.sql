-- baseline-check: replace-function-if-body-sha256 "amux_idea_analysis_budget_setting_guard" "febea66f06d4ab1cee2674f623999520fd32a6edde634fdc69533e6515c90691"
-- docs/policy/amux-intake.md v16 repair. PostgreSQL xid8 text includes the
-- epoch after transaction ID wraparound, while a tuple xmin text does not.
-- Compare the same-transaction audit in the xid domain and preserve every
-- other owner, metadata, append-only and audit-chain condition.
BEGIN;

CREATE OR REPLACE FUNCTION "amux_idea_analysis_budget_setting_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE latest_version integer; latest_limit bigint; audit_row record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'analysis budget setting is append only' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'));
  SELECT "version", "limitMicroUsd" INTO latest_version, latest_limit
    FROM "AmuxIdeaAnalysisBudgetSetting" ORDER BY "version" DESC LIMIT 1;
  SELECT a.*, a.xmin AS audit_xid INTO audit_row FROM "AdminAuditLog" a
    WHERE a."id" = NEW."approvalAuditLogId";
  IF NEW."version" <> COALESCE(latest_version, 0) + 1 OR
    NEW."effectiveMonth" IS DISTINCT FROM date_trunc('month', clock_timestamp() AT TIME ZONE 'UTC')::timestamp(3) OR
    audit_row."id" IS NULL OR audit_row.audit_xid <> pg_current_xact_id()::xid OR
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

COMMIT;
