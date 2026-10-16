-- AMUX intake v19: a coding-tool session may store one encrypted idea under
-- the latest owner-approved operating scope. The data owner remains the human
-- scope approver; the submission evidence is a distinct canonical system
-- audit row written in the same transaction. No route or runtime switch is
-- enabled by this migration.
BEGIN;

ALTER TABLE "AmuxIdeaSubmission"
  ADD COLUMN "submissionOrigin" TEXT NOT NULL DEFAULT 'owner',
  ADD COLUMN "sessionOperatingScopeSettingId" TEXT,
  ADD COLUMN "submissionAuditLogId" TEXT,
  ADD COLUMN "sourceProvenanceCiphertext" BYTEA,
  ADD COLUMN "sourceProvenanceKeyId" TEXT,
  ADD COLUMN "sourceProvenanceKeyVersion" INTEGER,
  ADD COLUMN "sourceProvenanceDigest" TEXT,
  ADD COLUMN "sourceProvenanceDigestKeyId" TEXT,
  ADD CONSTRAINT "AmuxIdeaSubmission_origin_check" CHECK (
    "submissionOrigin" IN ('owner', 'session')
  ),
  ADD CONSTRAINT "AmuxIdeaSubmission_session_shape_check" CHECK (
    ("submissionOrigin" = 'owner' AND
      "sessionOperatingScopeSettingId" IS NULL AND "submissionAuditLogId" IS NULL AND
      "sourceProvenanceCiphertext" IS NULL AND "sourceProvenanceKeyId" IS NULL AND
      "sourceProvenanceKeyVersion" IS NULL AND "sourceProvenanceDigest" IS NULL AND
      "sourceProvenanceDigestKeyId" IS NULL) OR
    ("submissionOrigin" = 'session' AND
      "sessionOperatingScopeSettingId" IS NOT NULL AND "submissionAuditLogId" IS NOT NULL AND
      "sourceProvenanceDigest" IS NOT NULL AND
      "sourceProvenanceDigest" ~ '^[a-f0-9]{64}$' AND
      "sourceProvenanceDigestKeyId" IS NOT NULL AND length("sourceProvenanceDigestKeyId") > 0 AND
      (("rawPurgedAt" IS NULL AND "sourceProvenanceCiphertext" IS NOT NULL AND
        "sourceProvenanceKeyId" IS NOT NULL AND length("sourceProvenanceKeyId") > 0 AND
        "sourceProvenanceKeyVersion" IS NOT NULL AND "sourceProvenanceKeyVersion" > 0) OR
       ("rawPurgedAt" IS NOT NULL AND "sourceProvenanceCiphertext" IS NULL AND
        "sourceProvenanceKeyId" IS NULL AND "sourceProvenanceKeyVersion" IS NULL)))
  );

CREATE UNIQUE INDEX "AmuxIdeaSubmission_submissionAuditLogId_key"
  ON "AmuxIdeaSubmission"("submissionAuditLogId");
ALTER TABLE "AmuxIdeaSubmission"
  ADD CONSTRAINT "AmuxIdeaSubmission_session_scope_fkey"
    FOREIGN KEY ("sessionOperatingScopeSettingId")
    REFERENCES "AmuxIdeaOperatingScopeSetting"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaSubmission_submission_audit_fkey"
    FOREIGN KEY ("submissionAuditLogId")
    REFERENCES "AdminAuditLog"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "amux_v19_session_submission_guard"() RETURNS trigger
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
       'ideaBytes', 'repositoryCount', 'pullRequestCount'
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
     NOT (metadata->>'ideaBytes') ~ '^[0-9]+$' OR
     NOT (metadata->>'repositoryCount') ~ '^[0-9]+$' OR
     NOT (metadata->>'pullRequestCount') ~ '^[0-9]+$' THEN
    RAISE EXCEPTION 'AMUX v19 session submission evidence mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSubmission_session_evidence_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaSubmission_session_guard"
  BEFORE INSERT OR UPDATE ON "AmuxIdeaSubmission"
  FOR EACH ROW EXECUTE FUNCTION "amux_v19_session_submission_guard"();

CREATE OR REPLACE FUNCTION amux_v4_raw_no_resurrection_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF OLD."rawPurgedAt" IS NOT NULL AND (
    NEW."rawPurgedAt" IS DISTINCT FROM OLD."rawPurgedAt" OR
    NEW."rawCiphertext" IS NOT NULL OR NEW."rawKeyId" IS NOT NULL OR
    NEW."rawKeyVersion" IS NOT NULL OR NEW."sourceProvenanceCiphertext" IS NOT NULL OR
    NEW."sourceProvenanceKeyId" IS NOT NULL OR NEW."sourceProvenanceKeyVersion" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'AMUX v4 raw idea cannot be restored after purge'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSubmission_raw_no_resurrection_check';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
