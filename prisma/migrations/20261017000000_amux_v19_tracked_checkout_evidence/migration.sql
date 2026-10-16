-- AMUX intake v19 direct-read evidence. This stores no repository name, path,
-- checkout directory or file content. It creates no checkout and starts no
-- analysis; one narrow transaction writer records an already prepared proof.
BEGIN;

CREATE TABLE "AmuxIdeaTrackedCheckoutEvidence" (
  "id" UUID NOT NULL,
  "ideaId" TEXT NOT NULL,
  "referenceOrdinal" INTEGER NOT NULL,
  "pinnedCommitSha" TEXT NOT NULL,
  "excludedCount" INTEGER NOT NULL,
  "excludedSecretPathCount" INTEGER NOT NULL,
  "excludedSecretContentCount" INTEGER NOT NULL,
  "excludedNonRegularCount" INTEGER NOT NULL,
  "excludedUnscannableCount" INTEGER NOT NULL,
  "excludedPathDigest" TEXT NOT NULL,
  "excludedPathDigestKeyId" TEXT NOT NULL,
  "auditLogId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AmuxIdeaTrackedCheckoutEvidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AmuxIdeaTrackedCheckoutEvidence_reference_check" CHECK (
    "referenceOrdinal" >= 0 AND
    "pinnedCommitSha" ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$'
  ),
  CONSTRAINT "AmuxIdeaTrackedCheckoutEvidence_exclusion_check" CHECK (
    "excludedCount" >= 0 AND
    "excludedSecretPathCount" >= 0 AND
    "excludedSecretContentCount" >= 0 AND
    "excludedNonRegularCount" >= 0 AND
    "excludedUnscannableCount" >= 0 AND
    "excludedCount" = "excludedSecretPathCount" +
      "excludedSecretContentCount" + "excludedNonRegularCount" +
      "excludedUnscannableCount" AND
    "excludedPathDigest" ~ '^[a-f0-9]{64}$' AND
    "excludedPathDigestKeyId" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
  )
);

CREATE UNIQUE INDEX "AmuxIdeaTrackedCheckoutEvidence_ideaId_referenceOrdinal_key"
  ON "AmuxIdeaTrackedCheckoutEvidence"("ideaId", "referenceOrdinal");
CREATE UNIQUE INDEX "AmuxIdeaTrackedCheckoutEvidence_auditLogId_key"
  ON "AmuxIdeaTrackedCheckoutEvidence"("auditLogId");
CREATE INDEX "AmuxIdeaTrackedCheckoutEvidence_ideaId_createdAt_idx"
  ON "AmuxIdeaTrackedCheckoutEvidence"("ideaId", "createdAt");

ALTER TABLE "AmuxIdeaTrackedCheckoutEvidence"
  ADD CONSTRAINT "AmuxIdeaTrackedCheckoutEvidence_ideaId_fkey"
    FOREIGN KEY ("ideaId") REFERENCES "AmuxIdeaSubmission"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaTrackedCheckoutEvidence_auditLogId_fkey"
    FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "amux_v19_tracked_checkout_evidence_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  idea_row record;
  submission_audit record;
  evidence_audit record;
  metadata jsonb;
  source_count numeric;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'AMUX v19 tracked checkout evidence is append only'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTrackedCheckoutEvidence_append_only';
  END IF;

  SELECT "submissionOrigin", "submissionAuditLogId", "analysisDeadlineAt",
         "analysisCompletedAt", "cancelledAt"
  INTO idea_row
  FROM "AmuxIdeaSubmission"
  WHERE "id" = NEW."ideaId"
  FOR KEY SHARE;
  IF NOT FOUND OR idea_row."submissionOrigin" <> 'session' OR
     idea_row."submissionAuditLogId" IS NULL OR
     idea_row."analysisCompletedAt" IS NOT NULL OR
     idea_row."cancelledAt" IS NOT NULL OR
     idea_row."analysisDeadlineAt" <= (clock_timestamp() AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'AMUX v19 tracked checkout idea is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTrackedCheckoutEvidence_idea_guard';
  END IF;

  SELECT a."action", a."targetType", a."targetId", a."actorUserId", a."actorEmail",
         a."ipAddress", a."userAgent", a."metadata", a."entryHash"
  INTO submission_audit
  FROM "AdminAuditLog" a
  WHERE a."id" = idea_row."submissionAuditLogId";
  IF NOT FOUND OR submission_audit."entryHash" IS NULL OR
     submission_audit."action" <> 'amux.idea.session_submitted' OR
     submission_audit."targetType" <> 'AmuxIdeaSubmission' OR
     submission_audit."targetId" <> NEW."ideaId" OR
     submission_audit."actorUserId" IS NOT NULL OR
     submission_audit."actorEmail" IS NOT NULL OR
     submission_audit."ipAddress" IS NOT NULL OR
     submission_audit."userAgent" IS NOT NULL OR
     submission_audit."metadata"->>'systemActor' <> 'amux-session-intake' OR
     submission_audit."metadata"->>'actorScope' <> 'session-submission-v1' OR
     jsonb_typeof(submission_audit."metadata"->'repositoryCount') <> 'number' OR
     jsonb_typeof(submission_audit."metadata"->'pullRequestCount') <> 'number' THEN
    RAISE EXCEPTION 'AMUX v19 tracked checkout submission evidence mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTrackedCheckoutEvidence_submission_audit_guard';
  END IF;
  source_count := (submission_audit."metadata"->>'repositoryCount')::numeric +
    (submission_audit."metadata"->>'pullRequestCount')::numeric;
  IF source_count <= NEW."referenceOrdinal" THEN
    RAISE EXCEPTION 'AMUX v19 tracked checkout reference is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTrackedCheckoutEvidence_reference_ordinal_guard';
  END IF;

  SELECT a."action", a."targetType", a."targetId", a."summary", a."actorUserId",
         a."actorEmail", a."ipAddress", a."userAgent", a."metadata", a."entryHash", a.xmin
  INTO evidence_audit
  FROM "AdminAuditLog" a
  WHERE a."id" = NEW."auditLogId";
  metadata := evidence_audit."metadata";
  IF NOT FOUND OR evidence_audit."entryHash" IS NULL OR
     evidence_audit.xmin <> pg_current_xact_id()::xid OR
     evidence_audit."action" <> 'amux.v19.tracked_checkout.recorded' OR
     evidence_audit."targetType" <> 'AmuxIdeaTrackedCheckoutEvidence' OR
     evidence_audit."targetId" <> NEW."id"::text OR
     evidence_audit."summary" <> 'Recorded one content-free AMUX v19 pinned checkout evidence.' OR
     evidence_audit."actorUserId" IS NOT NULL OR
     evidence_audit."actorEmail" IS NOT NULL OR
     evidence_audit."ipAddress" IS NOT NULL OR
     evidence_audit."userAgent" IS NOT NULL OR
     metadata IS NULL OR jsonb_typeof(metadata) <> 'object' OR
     NOT metadata ?& ARRAY[
       'systemActor', 'actorScope', 'policyVersion', 'evidenceId', 'ideaId',
       'referenceOrdinal', 'pinnedCommitSha', 'excludedCount',
       'excludedSecretPathCount', 'excludedSecretContentCount',
       'excludedNonRegularCount', 'excludedUnscannableCount',
       'excludedPathDigest', 'excludedPathDigestKeyId'
     ] OR (SELECT count(*) FROM jsonb_object_keys(metadata)) <> 14 OR
     metadata->>'systemActor' <> 'amux-v4-intake' OR
     metadata->>'actorScope' <> 'tracked-checkout-evidence-v1' OR
     metadata->'policyVersion' IS DISTINCT FROM to_jsonb(19) OR
     metadata->>'evidenceId' IS DISTINCT FROM NEW."id"::text OR
     metadata->>'ideaId' IS DISTINCT FROM NEW."ideaId" OR
     metadata->'referenceOrdinal' IS DISTINCT FROM to_jsonb(NEW."referenceOrdinal") OR
     metadata->>'pinnedCommitSha' IS DISTINCT FROM NEW."pinnedCommitSha" OR
     metadata->'excludedCount' IS DISTINCT FROM to_jsonb(NEW."excludedCount") OR
     metadata->'excludedSecretPathCount' IS DISTINCT FROM to_jsonb(NEW."excludedSecretPathCount") OR
     metadata->'excludedSecretContentCount' IS DISTINCT FROM to_jsonb(NEW."excludedSecretContentCount") OR
     metadata->'excludedNonRegularCount' IS DISTINCT FROM to_jsonb(NEW."excludedNonRegularCount") OR
     metadata->'excludedUnscannableCount' IS DISTINCT FROM to_jsonb(NEW."excludedUnscannableCount") OR
     metadata->>'excludedPathDigest' IS DISTINCT FROM NEW."excludedPathDigest" OR
     metadata->>'excludedPathDigestKeyId' IS DISTINCT FROM NEW."excludedPathDigestKeyId" THEN
    RAISE EXCEPTION 'AMUX v19 tracked checkout audit evidence mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTrackedCheckoutEvidence_audit_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaTrackedCheckoutEvidence_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaTrackedCheckoutEvidence"
  FOR EACH ROW EXECUTE FUNCTION "amux_v19_tracked_checkout_evidence_guard"();

COMMIT;
