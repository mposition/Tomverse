-- AMUX intake v19 item 4: one content-free queue reservation is inserted in
-- the same transaction as a coding-tool session submission. It reserves no
-- money, starts no CLI and grants no dispatch permission.
BEGIN;

CREATE TABLE "AmuxIdeaSessionAnalysisReservation" (
  "id" UUID NOT NULL,
  "ideaId" TEXT NOT NULL,
  "requestId" UUID NOT NULL,
  "actorUserId" TEXT NOT NULL,
  "operatingScopeSettingId" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "modelProvider" TEXT NOT NULL,
  "modelId" TEXT NOT NULL,
  "reasoningEffort" TEXT NOT NULL,
  "reservationAuditLogId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AmuxIdeaSessionAnalysisReservation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AmuxIdeaSessionAnalysisReservation_status_check"
    CHECK ("status" IN ('queued')),
  CONSTRAINT "AmuxIdeaSessionAnalysisReservation_provider_check"
    CHECK ("modelProvider" IN ('openai', 'anthropic')),
  CONSTRAINT "AmuxIdeaSessionAnalysisReservation_model_id_check"
    CHECK ("modelId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$'),
  CONSTRAINT "AmuxIdeaSessionAnalysisReservation_reasoning_effort_check"
    CHECK ("reasoningEffort" IN (
      'low', 'medium', 'high', 'xhigh', 'max', 'ultra'
    ))
);

CREATE UNIQUE INDEX "AmuxIdeaSessionAnalysisReservation_ideaId_key"
  ON "AmuxIdeaSessionAnalysisReservation"("ideaId");
CREATE UNIQUE INDEX "AmuxIdeaSessionAnalysisReservation_ideaId_actorUserId_key"
  ON "AmuxIdeaSessionAnalysisReservation"("ideaId", "actorUserId");
CREATE UNIQUE INDEX "AmuxIdeaSessionAnalysisReservation_requestId_key"
  ON "AmuxIdeaSessionAnalysisReservation"("requestId");
CREATE UNIQUE INDEX "AmuxIdeaSessionAnalysisReservation_reservationAuditLogId_key"
  ON "AmuxIdeaSessionAnalysisReservation"("reservationAuditLogId");
CREATE INDEX "AmuxIdeaSessionAnalysisReservation_status_createdAt_idx"
  ON "AmuxIdeaSessionAnalysisReservation"("status", "createdAt");

ALTER TABLE "AmuxIdeaSessionAnalysisReservation"
  ADD CONSTRAINT "AmuxIdeaSessionAnalysisReservation_idea_owner_fkey"
    FOREIGN KEY ("ideaId", "actorUserId")
    REFERENCES "AmuxIdeaSubmission"("id", "actorUserId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaSessionAnalysisReservation_scope_fkey"
    FOREIGN KEY ("operatingScopeSettingId")
    REFERENCES "AmuxIdeaOperatingScopeSetting"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaSessionAnalysisReservation_audit_fkey"
    FOREIGN KEY ("reservationAuditLogId")
    REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "amux_v19_session_analysis_reservation_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  idea_row record;
  scope_row record;
  submission_audit record;
  reservation_audit record;
  reservation_audit_found boolean;
  metadata jsonb;
  latest_scope_id text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'AMUX v19 session analysis reservation is append only'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxIdeaSessionAnalysisReservation_append_only';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'));
  SELECT "id" INTO latest_scope_id
  FROM "AmuxIdeaOperatingScopeSetting"
  ORDER BY "version" DESC LIMIT 1;

  SELECT i."requestId", i."actorUserId", i."submissionOrigin",
         i."sessionOperatingScopeSettingId", i."submissionAuditLogId", i.xmin
  INTO idea_row
  FROM "AmuxIdeaSubmission" i
  WHERE i."id" = NEW."ideaId"
  FOR KEY SHARE;
  IF NOT FOUND OR idea_row.xmin <> pg_current_xact_id()::xid OR
     idea_row."requestId" IS DISTINCT FROM NEW."requestId"::text::uuid OR
     idea_row."actorUserId" IS DISTINCT FROM NEW."actorUserId" OR
     idea_row."submissionOrigin" <> 'session' OR
     idea_row."sessionOperatingScopeSettingId" IS DISTINCT FROM
       NEW."operatingScopeSettingId" OR
     idea_row."submissionAuditLogId" IS NULL THEN
    RAISE EXCEPTION 'AMUX v19 session reservation submission mismatch'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxIdeaSessionAnalysisReservation_submission_guard';
  END IF;

  SELECT s."approvedByUserId", s."modelProvider", s."modelId",
         s."reasoningEffort"
  INTO scope_row
  FROM "AmuxIdeaOperatingScopeSetting" s
  WHERE s."id" = NEW."operatingScopeSettingId"
  FOR KEY SHARE;
  IF NOT FOUND OR latest_scope_id IS DISTINCT FROM NEW."operatingScopeSettingId" OR
     scope_row."approvedByUserId" IS DISTINCT FROM NEW."actorUserId" OR
     scope_row."modelProvider" IS DISTINCT FROM NEW."modelProvider" OR
     scope_row."modelId" IS DISTINCT FROM NEW."modelId" OR
     scope_row."reasoningEffort" IS DISTINCT FROM NEW."reasoningEffort" THEN
    RAISE EXCEPTION 'AMUX v19 session reservation operating scope mismatch'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxIdeaSessionAnalysisReservation_scope_guard';
  END IF;

  SELECT a."action", a."targetType", a."targetId", a."actorUserId",
         a."actorEmail", a."ipAddress", a."userAgent", a."metadata",
         a."entryHash", a.xmin
  INTO submission_audit
  FROM "AdminAuditLog" a
  WHERE a."id" = idea_row."submissionAuditLogId";
  IF NOT FOUND OR submission_audit.xmin <> pg_current_xact_id()::xid OR
     submission_audit."entryHash" IS NULL OR
     submission_audit."action" <> 'amux.idea.session_submitted' OR
     submission_audit."targetType" <> 'AmuxIdeaSubmission' OR
     submission_audit."targetId" IS DISTINCT FROM NEW."ideaId" OR
     submission_audit."actorUserId" IS NOT NULL OR
     submission_audit."actorEmail" IS NOT NULL OR
     submission_audit."ipAddress" IS NOT NULL OR
     submission_audit."userAgent" IS NOT NULL OR
     submission_audit."metadata"->>'systemActor' <> 'amux-session-intake' OR
     submission_audit."metadata"->>'actorScope' <> 'session-submission-v1' OR
     submission_audit."metadata"->>'requestId' IS DISTINCT FROM NEW."requestId"::text OR
     submission_audit."metadata"->>'operatingScopeSettingId' IS DISTINCT FROM
       NEW."operatingScopeSettingId" OR
     submission_audit."metadata"->>'modelProvider' IS DISTINCT FROM
       NEW."modelProvider" OR
     submission_audit."metadata"->>'modelId' IS DISTINCT FROM NEW."modelId" OR
     submission_audit."metadata"->>'reasoningEffort' IS DISTINCT FROM
       NEW."reasoningEffort" THEN
    RAISE EXCEPTION 'AMUX v19 session reservation submission audit mismatch'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxIdeaSessionAnalysisReservation_submission_audit_guard';
  END IF;

  SELECT a."action", a."targetType", a."targetId", a."summary",
         a."actorUserId", a."actorEmail", a."ipAddress", a."userAgent",
         a."metadata", a."entryHash", a.xmin
  INTO reservation_audit
  FROM "AdminAuditLog" a
  WHERE a."id" = NEW."reservationAuditLogId";
  reservation_audit_found := FOUND;
  metadata := reservation_audit."metadata";
  IF NOT reservation_audit_found OR
     reservation_audit.xmin <> pg_current_xact_id()::xid OR
     reservation_audit."entryHash" IS NULL OR
     reservation_audit."action" <> 'amux.idea.session_analysis_reserved' OR
     reservation_audit."targetType" <> 'AmuxIdeaSessionAnalysisReservation' OR
     reservation_audit."targetId" IS DISTINCT FROM NEW."id"::text OR
     reservation_audit."summary" <>
       'Queued one AMUX v19 analysis reservation under the current owner-approved operating scope.' OR
     reservation_audit."actorUserId" IS NOT NULL OR
     reservation_audit."actorEmail" IS NOT NULL OR
     reservation_audit."ipAddress" IS NOT NULL OR
     reservation_audit."userAgent" IS NOT NULL OR
     metadata IS NULL OR jsonb_typeof(metadata) <> 'object' OR
     NOT metadata ?& ARRAY[
       'systemActor', 'actorScope', 'policyVersion', 'reservationId',
       'ideaId', 'requestId', 'submissionAuditId',
       'operatingScopeSettingId', 'dataOwnerUserId', 'modelProvider',
       'modelId', 'reasoningEffort'
     ] OR (SELECT count(*) FROM jsonb_object_keys(metadata)) <> 12 OR
     metadata->>'systemActor' <> 'amux-session-intake' OR
     metadata->>'actorScope' <> 'session-analysis-reservation-v1' OR
     metadata->'policyVersion' IS DISTINCT FROM to_jsonb(19) OR
     metadata->>'reservationId' IS DISTINCT FROM NEW."id"::text OR
     metadata->>'ideaId' IS DISTINCT FROM NEW."ideaId" OR
     metadata->>'requestId' IS DISTINCT FROM NEW."requestId"::text OR
     metadata->>'submissionAuditId' IS DISTINCT FROM idea_row."submissionAuditLogId" OR
     metadata->>'operatingScopeSettingId' IS DISTINCT FROM
       NEW."operatingScopeSettingId" OR
     metadata->>'dataOwnerUserId' IS DISTINCT FROM NEW."actorUserId" OR
     metadata->>'modelProvider' IS DISTINCT FROM NEW."modelProvider" OR
     metadata->>'modelId' IS DISTINCT FROM NEW."modelId" OR
     metadata->>'reasoningEffort' IS DISTINCT FROM NEW."reasoningEffort" THEN
    RAISE EXCEPTION 'AMUX v19 session reservation audit mismatch'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxIdeaSessionAnalysisReservation_audit_guard';
  END IF;

  NEW."createdAt" := clock_timestamp();
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaSessionAnalysisReservation_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaSessionAnalysisReservation"
  FOR EACH ROW EXECUTE FUNCTION "amux_v19_session_analysis_reservation_guard"();
CREATE TRIGGER "AmuxIdeaSessionAnalysisReservation_no_truncate"
  BEFORE TRUNCATE ON "AmuxIdeaSessionAnalysisReservation"
  FOR EACH STATEMENT EXECUTE FUNCTION "amux_v19_session_analysis_reservation_guard"();

COMMIT;
