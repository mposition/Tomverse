-- A checkout receipt must match the SHA captured by the session intake,
-- not merely any syntactically valid commit supplied by the analysis worker.
BEGIN;

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
     metadata->>'modelProvider' IS DISTINCT FROM scope_row."modelProvider" OR
     metadata->>'modelId' IS DISTINCT FROM scope_row."modelId" OR
     metadata->>'reasoningEffort' IS DISTINCT FROM scope_row."reasoningEffort" OR
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



CREATE FUNCTION "amux_v19_tracked_checkout_pin_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  submission_metadata jsonb;
  reference_count numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;
  SELECT a."metadata" INTO submission_metadata
  FROM "AmuxIdeaSubmission" i
  JOIN "AdminAuditLog" a ON a."id" = i."submissionAuditLogId"
  WHERE i."id" = NEW."ideaId"
    AND i."submissionOrigin" = 'session'
    AND a."action" = 'amux.idea.session_submitted'
    AND a."targetType" = 'AmuxIdeaSubmission'
    AND a."targetId" = i."id"
    AND a."entryHash" IS NOT NULL;
  IF NOT FOUND OR
     jsonb_typeof(submission_metadata->'pinnedCommitShas') IS DISTINCT FROM 'array' OR
     jsonb_typeof(submission_metadata->'repositoryCount') IS DISTINCT FROM 'number' OR
     jsonb_typeof(submission_metadata->'pullRequestCount') IS DISTINCT FROM 'number' THEN
    RAISE EXCEPTION 'AMUX v19 reference pin is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTrackedCheckoutEvidence_pin_guard';
  END IF;
  reference_count := (submission_metadata->>'repositoryCount')::numeric +
    (submission_metadata->>'pullRequestCount')::numeric;
  IF jsonb_array_length(submission_metadata->'pinnedCommitShas') <> reference_count OR
     NEW."referenceOrdinal" < 0 OR
     NEW."referenceOrdinal" >= reference_count OR
     submission_metadata->'pinnedCommitShas'->>NEW."referenceOrdinal" IS DISTINCT FROM
       NEW."pinnedCommitSha" THEN
    RAISE EXCEPTION 'AMUX v19 checkout SHA differs from session intake'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTrackedCheckoutEvidence_pin_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaTrackedCheckoutEvidence_pin_guard"
  BEFORE INSERT ON "AmuxIdeaTrackedCheckoutEvidence"
  FOR EACH ROW EXECUTE FUNCTION "amux_v19_tracked_checkout_pin_guard"();

COMMIT;
