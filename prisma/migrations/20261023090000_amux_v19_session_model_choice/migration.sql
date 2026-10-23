-- baseline-check: present-if-function "amux_v19_session_model_admitted(text,text,text,text)"
-- AMUX intake v19 (owner decision 2026-10-23): the owner may pick the analysis
-- model per unattended idea. A session submission and its reservation may name
-- the operating scope model, as before, or any model the owner has approved in
-- the Frontier catalog at an allowed effort. The model is still bound from the
-- submission audit to the reservation and from the reservation to the claim,
-- and a claim still needs that model's approved subscription price.
BEGIN;

CREATE FUNCTION "amux_v19_session_model_admitted"(text, text, text, text)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public, pg_temp AS $$
  SELECT $2 IS NOT NULL AND $3 IS NOT NULL AND $4 IS NOT NULL AND (
    EXISTS (SELECT 1 FROM "AmuxIdeaOperatingScopeSetting" s
      WHERE s."id" = $1 AND s."modelProvider" = $2 AND s."modelId" = $3 AND
        s."reasoningEffort" = $4) OR
    EXISTS (SELECT 1 FROM "AmuxIdeaFrontierModelApproval" f
      WHERE f."provider" = $2 AND f."modelId" = $3 AND f."status" = 'approved' AND
        f."revokedAt" IS NULL AND $4 = ANY (f."allowedEfforts")))
$$;

CREATE OR REPLACE FUNCTION "amux_v19_session_submission_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE scope_row record; latest_scope_id text; audit_row record; metadata jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."submissionOrigin" IS DISTINCT FROM OLD."submissionOrigin" OR
       NEW."sessionOperatingScopeSettingId" IS DISTINCT FROM OLD."sessionOperatingScopeSettingId" OR
       NEW."submissionAuditLogId" IS DISTINCT FROM OLD."submissionAuditLogId" OR
       NEW."sourceProvenanceDigest" IS DISTINCT FROM OLD."sourceProvenanceDigest" OR
       NEW."sourceProvenanceDigestKeyId" IS DISTINCT FROM OLD."sourceProvenanceDigestKeyId" THEN
      RAISE EXCEPTION 'AMUX v19 session submission evidence is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSubmission_session_evidence_immutable_check';
    END IF;
    IF OLD."submissionOrigin" = 'session' AND (
       NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId" OR
       NEW."requestId" IS DISTINCT FROM OLD."requestId" OR
       NEW."rawDigest" IS DISTINCT FROM OLD."rawDigest" OR
       NEW."rawDigestKeyId" IS DISTINCT FROM OLD."rawDigestKeyId") THEN
      RAISE EXCEPTION 'AMUX v19 audited submission identity is immutable'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSubmission_session_identity_immutable_check';
    END IF;
    IF OLD."submissionOrigin" = 'session' AND (
       NEW."rawCiphertext" IS DISTINCT FROM OLD."rawCiphertext" OR
       NEW."rawKeyId" IS DISTINCT FROM OLD."rawKeyId" OR
       NEW."rawKeyVersion" IS DISTINCT FROM OLD."rawKeyVersion" OR
       NEW."sourceProvenanceCiphertext" IS DISTINCT FROM OLD."sourceProvenanceCiphertext" OR
       NEW."sourceProvenanceKeyId" IS DISTINCT FROM OLD."sourceProvenanceKeyId" OR
       NEW."sourceProvenanceKeyVersion" IS DISTINCT FROM OLD."sourceProvenanceKeyVersion"
    ) AND NOT (
       OLD."rawPurgedAt" IS NULL AND NEW."rawPurgedAt" IS NOT NULL AND
       NEW."rawCiphertext" IS NULL AND NEW."rawKeyId" IS NULL AND NEW."rawKeyVersion" IS NULL AND
       NEW."sourceProvenanceCiphertext" IS NULL AND NEW."sourceProvenanceKeyId" IS NULL AND
       NEW."sourceProvenanceKeyVersion" IS NULL
    ) THEN
      RAISE EXCEPTION 'AMUX v19 encrypted bodies may change only during raw purge'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSubmission_source_provenance_immutable_check';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."submissionOrigin" = 'owner' THEN RETURN NEW; END IF;
  IF NEW."sourceProvenanceDigest" IS NULL OR
     NEW."sourceProvenanceDigestKeyId" IS NULL THEN
    RAISE EXCEPTION 'AMUX v19 source provenance evidence is required'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSubmission_session_evidence_check';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('tomverse-admin-audit-chain'));
  SELECT "id" INTO latest_scope_id FROM "AmuxIdeaOperatingScopeSetting"
    ORDER BY "version" DESC LIMIT 1;
  SELECT * INTO scope_row FROM "AmuxIdeaOperatingScopeSetting"
    WHERE "id" = NEW."sessionOperatingScopeSettingId";
  SELECT a.*, a.xmin = pg_current_xact_id()::xid AS audit_same_transaction
    INTO audit_row FROM "AdminAuditLog" a
    WHERE a."id" = NEW."submissionAuditLogId";
  metadata := audit_row."metadata";

  IF scope_row."id" IS NULL OR scope_row."id" IS DISTINCT FROM latest_scope_id OR
     scope_row."approvedByUserId" IS DISTINCT FROM NEW."actorUserId" OR
     NEW."rawCiphertext" IS NULL OR NEW."rawKeyId" IS NULL OR NEW."rawKeyVersion" IS NULL OR
     NEW."rawDigest" IS NULL OR NEW."rawDigestKeyId" IS NULL OR
     NEW."sourceProvenanceKeyId" IS DISTINCT FROM NEW."rawKeyId" OR
     NEW."sourceProvenanceKeyVersion" IS DISTINCT FROM NEW."rawKeyVersion" OR
     audit_row."id" IS NULL OR audit_row.audit_same_transaction IS NOT TRUE OR
     audit_row."actorUserId" IS NOT NULL OR audit_row."actorEmail" IS NOT NULL OR
     audit_row."ipAddress" IS NOT NULL OR audit_row."userAgent" IS NOT NULL OR
     audit_row."entryHash" IS NULL OR
     audit_row."action" <> 'amux.idea.session_submitted' OR
     audit_row."targetType" <> 'AmuxIdeaSubmission' OR
     audit_row."targetId" IS DISTINCT FROM NEW."id" OR
     audit_row."summary" <> 'Stored one encrypted AMUX session idea under the current owner-approved operating scope.' OR
     jsonb_typeof(metadata) IS DISTINCT FROM 'object' OR
     metadata - ARRAY[
       'systemActor', 'actorScope', 'policyVersion', 'requestId',
       'rawDigest', 'rawDigestKeyId', 'sourceProvenanceDigest',
       'sourceProvenanceDigestKeyId', 'operatingScopeSettingId',
       'operatingScopeVersion', 'modelProvider', 'modelId', 'reasoningEffort',
       'ideaBytes', 'repositoryCount', 'pullRequestCount', 'pinnedCommitShas'
     ] <> '{}'::jsonb OR
     metadata->>'systemActor' IS DISTINCT FROM 'amux-session-intake' OR
     metadata->>'actorScope' IS DISTINCT FROM 'session-submission-v1' OR
     metadata->>'policyVersion' IS DISTINCT FROM '19' OR
     metadata->>'requestId' IS DISTINCT FROM NEW."requestId"::text OR
     metadata->>'rawDigest' IS DISTINCT FROM NEW."rawDigest" OR
     metadata->>'rawDigestKeyId' IS DISTINCT FROM NEW."rawDigestKeyId" OR
     metadata->>'sourceProvenanceDigest' IS DISTINCT FROM NEW."sourceProvenanceDigest" OR
     metadata->>'sourceProvenanceDigestKeyId' IS DISTINCT FROM NEW."sourceProvenanceDigestKeyId" OR
     metadata->>'operatingScopeSettingId' IS DISTINCT FROM scope_row."id" OR
     metadata->>'operatingScopeVersion' IS DISTINCT FROM scope_row."version"::text OR
     NOT "amux_v19_session_model_admitted"(scope_row."id", metadata->>'modelProvider',
       metadata->>'modelId', metadata->>'reasoningEffort') OR
     jsonb_typeof(metadata->'ideaBytes') IS DISTINCT FROM 'number' OR
     jsonb_typeof(metadata->'repositoryCount') IS DISTINCT FROM 'number' OR
     jsonb_typeof(metadata->'pullRequestCount') IS DISTINCT FROM 'number' OR
      (CASE WHEN jsonb_typeof(metadata->'pinnedCommitShas') = 'array' THEN
       jsonb_array_length(metadata->'pinnedCommitShas')::numeric IS DISTINCT FROM
         ((metadata->>'repositoryCount')::numeric + (metadata->>'pullRequestCount')::numeric)
       OR EXISTS (SELECT 1 FROM jsonb_array_elements(metadata->'pinnedCommitShas') AS pin(sha)
         WHERE jsonb_typeof(pin.sha) IS DISTINCT FROM 'string' OR
           pin.sha #>> '{}' !~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$')
      ELSE true END) OR
     NOT (metadata->>'ideaBytes') ~ '^[0-9]+$' OR
     NOT (metadata->>'repositoryCount') ~ '^[0-9]+$' OR
     NOT (metadata->>'pullRequestCount') ~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'AMUX v19 session submission evidence mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSubmission_session_evidence_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION "amux_v19_session_analysis_reservation_guard"() RETURNS trigger
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
     NOT "amux_v19_session_model_admitted"(NEW."operatingScopeSettingId",
       NEW."modelProvider", NEW."modelId", NEW."reasoningEffort") THEN
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
     submission_audit."metadata"->>'systemActor' IS DISTINCT FROM
       'amux-session-intake' OR
     submission_audit."metadata"->>'actorScope' IS DISTINCT FROM
       'session-submission-v1' OR
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
     metadata->>'systemActor' IS DISTINCT FROM 'amux-session-intake' OR
     metadata->>'actorScope' IS DISTINCT FROM
       'session-analysis-reservation-v1' OR
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

COMMIT;
