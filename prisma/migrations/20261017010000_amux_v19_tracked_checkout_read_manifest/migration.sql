-- One encrypted CLI-observed read manifest per pinned v19 reference. The
-- manifest contains paths, so only ciphertext and a keyed digest enter DB.
BEGIN;

CREATE TABLE "AmuxIdeaTrackedCheckoutReadManifest" (
  "id" UUID NOT NULL,
  "ideaId" TEXT NOT NULL,
  "referenceOrdinal" INTEGER NOT NULL,
  "pinnedCommitSha" TEXT NOT NULL,
  "fileCount" INTEGER NOT NULL,
  "ciphertext" BYTEA NOT NULL,
  "keyId" TEXT NOT NULL,
  "keyVersion" INTEGER NOT NULL,
  "digest" TEXT NOT NULL,
  "digestKeyId" TEXT NOT NULL,
  "auditLogId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AmuxIdeaTrackedCheckoutReadManifest_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AmuxIdeaTrackedCheckoutReadManifest_shape_check" CHECK (
    "referenceOrdinal" >= 0 AND "fileCount" >= 0 AND
    "pinnedCommitSha" ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' AND
    octet_length("ciphertext") >= 1 AND
    "keyId" ~ '^[A-Za-z0-9_-]{1,64}$' AND "keyVersion" > 0 AND
    "digest" ~ '^[a-f0-9]{64}$' AND
    "digestKeyId" ~ '^[A-Za-z0-9_-]{1,64}$'
  )
);

CREATE UNIQUE INDEX "AmuxIdeaTrackedCheckoutReadManifest_ideaId_referenceOrdinal_key"
  ON "AmuxIdeaTrackedCheckoutReadManifest"("ideaId", "referenceOrdinal");
CREATE UNIQUE INDEX "AmuxIdeaTrackedCheckoutReadManifest_auditLogId_key"
  ON "AmuxIdeaTrackedCheckoutReadManifest"("auditLogId");
CREATE INDEX "AmuxIdeaTrackedCheckoutReadManifest_ideaId_createdAt_idx"
  ON "AmuxIdeaTrackedCheckoutReadManifest"("ideaId", "createdAt");

ALTER TABLE "AmuxIdeaTrackedCheckoutReadManifest"
  ADD CONSTRAINT "AmuxIdeaTrackedCheckoutReadManifest_ideaId_fkey"
    FOREIGN KEY ("ideaId") REFERENCES "AmuxIdeaSubmission"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaTrackedCheckoutReadManifest_evidence_fkey"
    FOREIGN KEY ("ideaId", "referenceOrdinal")
    REFERENCES "AmuxIdeaTrackedCheckoutEvidence"("ideaId", "referenceOrdinal")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaTrackedCheckoutReadManifest_auditLogId_fkey"
    FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "amux_v19_tracked_checkout_read_manifest_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  idea_row record;
  evidence_row record;
  manifest_audit record;
  metadata jsonb;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'AMUX v19 read manifest is append only'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTrackedCheckoutReadManifest_append_only';
  END IF;

  SELECT "submissionOrigin", "cancelledAt", "analysisCompletedAt", "analysisDeadlineAt"
  INTO idea_row FROM "AmuxIdeaSubmission" WHERE "id" = NEW."ideaId" FOR KEY SHARE;
  IF NOT FOUND OR idea_row."submissionOrigin" <> 'session' OR
     idea_row."cancelledAt" IS NOT NULL OR idea_row."analysisCompletedAt" IS NOT NULL OR
     idea_row."analysisDeadlineAt" <= (clock_timestamp() AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'AMUX v19 read manifest idea is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTrackedCheckoutReadManifest_idea_guard';
  END IF;

  SELECT "pinnedCommitSha" INTO evidence_row
  FROM "AmuxIdeaTrackedCheckoutEvidence"
  WHERE "ideaId" = NEW."ideaId" AND "referenceOrdinal" = NEW."referenceOrdinal";
  IF NOT FOUND OR evidence_row."pinnedCommitSha" <> NEW."pinnedCommitSha" THEN
    RAISE EXCEPTION 'AMUX v19 read manifest pinned reference mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTrackedCheckoutReadManifest_sha_guard';
  END IF;

  SELECT a."action", a."targetType", a."targetId", a."summary", a."actorUserId",
         a."actorEmail", a."ipAddress", a."userAgent", a."metadata", a."entryHash", a.xmin
  INTO manifest_audit FROM "AdminAuditLog" a WHERE a."id" = NEW."auditLogId";
  metadata := manifest_audit."metadata";
  IF NOT FOUND OR manifest_audit."entryHash" IS NULL OR
     manifest_audit.xmin <> pg_current_xact_id()::xid OR
     manifest_audit."action" <> 'amux.v19.read_manifest.recorded' OR
     manifest_audit."targetType" <> 'AmuxIdeaTrackedCheckoutReadManifest' OR
     manifest_audit."targetId" <> NEW."id"::text OR
     manifest_audit."summary" <> 'Recorded one encrypted AMUX v19 CLI read manifest.' OR
     manifest_audit."actorUserId" IS NOT NULL OR
     manifest_audit."actorEmail" IS NOT NULL OR
     manifest_audit."ipAddress" IS NOT NULL OR
     manifest_audit."userAgent" IS NOT NULL OR
     metadata IS NULL OR jsonb_typeof(metadata) <> 'object' OR
     NOT metadata ?& ARRAY['systemActor', 'actorScope', 'policyVersion', 'manifestId',
       'ideaId', 'referenceOrdinal', 'pinnedCommitSha', 'fileCount', 'digest', 'digestKeyId'] OR
     (SELECT count(*) FROM jsonb_object_keys(metadata)) <> 10 OR
     metadata->>'systemActor' <> 'amux-v4-intake' OR
     metadata->>'actorScope' <> 'tracked-checkout-read-manifest-v1' OR
     metadata->'policyVersion' IS DISTINCT FROM to_jsonb(19) OR
     metadata->>'manifestId' IS DISTINCT FROM NEW."id"::text OR
     metadata->>'ideaId' IS DISTINCT FROM NEW."ideaId" OR
     metadata->'referenceOrdinal' IS DISTINCT FROM to_jsonb(NEW."referenceOrdinal") OR
     metadata->>'pinnedCommitSha' IS DISTINCT FROM NEW."pinnedCommitSha" OR
     metadata->'fileCount' IS DISTINCT FROM to_jsonb(NEW."fileCount") OR
     metadata->>'digest' IS DISTINCT FROM NEW."digest" OR
     metadata->>'digestKeyId' IS DISTINCT FROM NEW."digestKeyId" THEN
    RAISE EXCEPTION 'AMUX v19 read manifest audit evidence mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTrackedCheckoutReadManifest_audit_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaTrackedCheckoutReadManifest_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaTrackedCheckoutReadManifest"
  FOR EACH ROW EXECUTE FUNCTION "amux_v19_tracked_checkout_read_manifest_guard"();

COMMIT;
