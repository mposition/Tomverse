-- docs/policy/amux-intake.md v19 item 2: the owner's operating scope (repository
-- allowlist and analysis model). Append-only, one version per owner save, each
-- bound to the human audit row written in the same transaction. No row is seeded:
-- with no setting, intake is refused.
BEGIN;

CREATE TABLE "AmuxIdeaOperatingScopeSetting" (
  "id" TEXT PRIMARY KEY,
  "version" INTEGER NOT NULL UNIQUE,
  "repositories" JSONB NOT NULL,
  "modelProvider" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "reasoningEffort" TEXT NOT NULL,
  "approvedByUserId" TEXT NOT NULL,
  "approvalAuditLogId" TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AmuxIdeaOperatingScopeSetting_value_check" CHECK (
    "version" > 0 AND
    jsonb_typeof("repositories") = 'array' AND
    jsonb_array_length("repositories") BETWEEN 1 AND 64 AND
    "modelProvider" IN ('openai', 'anthropic') AND
    "reasoningEffort" IN ('low', 'medium', 'high', 'xhigh', 'max', 'ultra') AND
    "modelId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'
  ),
  CONSTRAINT "AmuxIdeaOperatingScopeSetting_audit_fkey" FOREIGN KEY ("approvalAuditLogId")
    REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION "amux_idea_operating_scope_setting_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE latest_version integer; audit_row record; entry jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'operating scope setting is append only' USING ERRCODE = '23514';
  END IF;
  -- Every entry is one owner/name string; the application admits the same grammar.
  FOR entry IN SELECT value FROM jsonb_array_elements(NEW."repositories") LOOP
    IF jsonb_typeof(entry) <> 'string' OR
       NOT (entry #>> '{}') ~ '^[A-Za-z0-9_.-]{1,64}/[A-Za-z0-9_.-]{1,100}$' OR
       split_part(entry #>> '{}', '/', 1) IN ('.', '..') OR
       split_part(entry #>> '{}', '/', 2) IN ('.', '..') THEN
      RAISE EXCEPTION 'operating scope repository is malformed' USING ERRCODE = '23514';
    END IF;
  END LOOP;
  IF (SELECT count(DISTINCT lower(value #>> '{}')) FROM jsonb_array_elements(NEW."repositories"))
     <> jsonb_array_length(NEW."repositories") THEN
    RAISE EXCEPTION 'operating scope repository is duplicated' USING ERRCODE = '23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'));
  SELECT "version" INTO latest_version
    FROM "AmuxIdeaOperatingScopeSetting" ORDER BY "version" DESC LIMIT 1;
  SELECT a.*, a.xmin AS audit_xid INTO audit_row FROM "AdminAuditLog" a
    WHERE a."id" = NEW."approvalAuditLogId";
  IF NEW."version" <> COALESCE(latest_version, 0) + 1 OR
    audit_row."id" IS NULL OR audit_row.audit_xid <> pg_current_xact_id()::xid OR
    audit_row."actorUserId" IS DISTINCT FROM NEW."approvedByUserId" OR
    audit_row."actorUserId" IS NULL OR audit_row."entryHash" IS NULL OR
    audit_row."action" <> 'amux.idea.operating_scope.updated' OR
    audit_row."targetType" <> 'AmuxIdeaOperatingScopeSetting' OR
    audit_row."targetId" IS DISTINCT FROM NEW."id" OR
    audit_row."metadata" ? 'systemActor' OR
    audit_row."metadata"->>'version' IS DISTINCT FROM NEW."version"::text OR
    audit_row."metadata"->>'previousVersion' IS DISTINCT FROM COALESCE(latest_version, 0)::text OR
    audit_row."metadata"->'repositories' IS DISTINCT FROM NEW."repositories" OR
    audit_row."metadata"->>'modelProvider' IS DISTINCT FROM NEW."modelProvider" OR
    audit_row."metadata"->>'modelId' IS DISTINCT FROM NEW."modelId" OR
    audit_row."metadata"->>'reasoningEffort' IS DISTINCT FROM NEW."reasoningEffort" OR
    audit_row."metadata"->>'policyVersion' IS DISTINCT FROM '19' THEN
    RAISE EXCEPTION 'operating scope approval evidence mismatch' USING ERRCODE = '23514';
  END IF;
  NEW."createdAt" := clock_timestamp() AT TIME ZONE 'UTC';
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxIdeaOperatingScopeSetting_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaOperatingScopeSetting"
  FOR EACH ROW EXECUTE FUNCTION "amux_idea_operating_scope_setting_guard"();
-- TRUNCATE bypasses row triggers; refuse it too.
CREATE TRIGGER "AmuxIdeaOperatingScopeSetting_no_truncate"
  BEFORE TRUNCATE ON "AmuxIdeaOperatingScopeSetting"
  FOR EACH STATEMENT EXECUTE FUNCTION "amux_idea_operating_scope_setting_guard"();
COMMIT;
