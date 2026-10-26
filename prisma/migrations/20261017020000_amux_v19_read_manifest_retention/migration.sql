-- The operator-approved seven-day clock retires CLI-read paths while the
-- count, keyed digest, and canonical audit remain. No scheduler is enabled.
BEGIN;

ALTER TABLE "AmuxIdeaTrackedCheckoutReadManifest"
  ALTER COLUMN "ciphertext" DROP NOT NULL,
  ALTER COLUMN "keyId" DROP NOT NULL,
  ALTER COLUMN "keyVersion" DROP NOT NULL,
  ADD COLUMN "bodyPurgedAt" TIMESTAMP(3),
  DROP CONSTRAINT "AmuxIdeaTrackedCheckoutReadManifest_shape_check",
  ADD CONSTRAINT "AmuxIdeaTrackedCheckoutReadManifest_shape_check" CHECK (
    "referenceOrdinal" >= 0 AND "fileCount" >= 0 AND
    "pinnedCommitSha" ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' AND
    "digest" ~ '^[a-f0-9]{64}$' AND
    "digestKeyId" ~ '^[A-Za-z0-9_-]{1,64}$' AND
    (("ciphertext" IS NOT NULL AND octet_length("ciphertext") >= 1 AND
      "keyId" ~ '^[A-Za-z0-9_-]{1,64}$' AND "keyVersion" > 0 AND
      "bodyPurgedAt" IS NULL) OR
     ("ciphertext" IS NULL AND "keyId" IS NULL AND
      "keyVersion" IS NULL AND "bodyPurgedAt" IS NOT NULL))
  );

CREATE INDEX "AmuxIdeaTrackedCheckoutReadManifest_bodyPurgedAt_createdAt_idx"
  ON "AmuxIdeaTrackedCheckoutReadManifest"("bodyPurgedAt", "createdAt");

ALTER TABLE "AmuxIdeaContentKeyRetirement"
  DROP CONSTRAINT "AmuxIdeaContentKeyRetirement_purpose_check",
  ADD CONSTRAINT "AmuxIdeaContentKeyRetirement_purpose_check"
    CHECK ("purpose" IN ('idea_raw', 'transfer_payload', 'analysis_freeform',
      'analysis_draft', 'task_result', 'task_patch', 'repository_read_manifest'));

DROP TRIGGER "AmuxIdeaTrackedCheckoutReadManifest_guard"
  ON "AmuxIdeaTrackedCheckoutReadManifest";
CREATE TRIGGER "AmuxIdeaTrackedCheckoutReadManifest_guard"
  BEFORE INSERT ON "AmuxIdeaTrackedCheckoutReadManifest"
  FOR EACH ROW EXECUTE FUNCTION "amux_v19_tracked_checkout_read_manifest_guard"();

CREATE FUNCTION "amux_v19_read_manifest_retention_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  submitted_at timestamp;
  retirement record;
  purge_audit record;
  now_utc timestamp;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'AMUX v19 read manifest cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTrackedCheckoutReadManifest_append_only';
  END IF;
  now_utc := clock_timestamp() AT TIME ZONE 'UTC';
  IF OLD."bodyPurgedAt" IS NOT NULL OR NEW."id" IS DISTINCT FROM OLD."id" OR
     NEW."ideaId" IS DISTINCT FROM OLD."ideaId" OR
     NEW."referenceOrdinal" IS DISTINCT FROM OLD."referenceOrdinal" OR
     NEW."pinnedCommitSha" IS DISTINCT FROM OLD."pinnedCommitSha" OR
     NEW."fileCount" IS DISTINCT FROM OLD."fileCount" OR
     NEW."digest" IS DISTINCT FROM OLD."digest" OR
     NEW."digestKeyId" IS DISTINCT FROM OLD."digestKeyId" OR
     NEW."auditLogId" IS DISTINCT FROM OLD."auditLogId" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     NEW."ciphertext" IS NOT NULL OR NEW."keyId" IS NOT NULL OR
     NEW."keyVersion" IS NOT NULL OR NEW."bodyPurgedAt" IS NULL OR
     NEW."bodyPurgedAt" > now_utc THEN
    RAISE EXCEPTION 'AMUX v19 read manifest is append only except verified purge'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTrackedCheckoutReadManifest_append_only';
  END IF;
  SELECT "submittedAt" INTO submitted_at FROM "AmuxIdeaSubmission"
  WHERE "id" = NEW."ideaId";
  IF NOT FOUND OR submitted_at + INTERVAL '7 days' > NEW."bodyPurgedAt" OR
     EXISTS (SELECT 1 FROM "AmuxIdeaRetentionHold" h
       WHERE h."ideaId" = NEW."ideaId" AND h."releasedAt" IS NULL AND
         h."expiresAt" > now_utc) THEN
    RAISE EXCEPTION 'AMUX v19 read manifest retention is not due'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTrackedCheckoutReadManifest_retention_due';
  END IF;
  SELECT r."bodyPurgedAt", r."purgeAuditLogId", r.xmin INTO retirement
  FROM "AmuxIdeaContentKeyRetirement" r WHERE r."ideaId" = NEW."ideaId"
    AND r."purpose" = 'repository_read_manifest' AND r."subjectId" = NEW."id"::text;
  IF NOT FOUND OR retirement.xmin <> pg_current_xact_id()::xid OR
     retirement."bodyPurgedAt" IS DISTINCT FROM NEW."bodyPurgedAt" THEN
    RAISE EXCEPTION 'AMUX v19 read manifest retirement is missing'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTrackedCheckoutReadManifest_retirement_guard';
  END IF;
  SELECT a."action", a."targetType", a."targetId", a."metadata", a."entryHash", a.xmin
  INTO purge_audit FROM "AdminAuditLog" a WHERE a."id" = retirement."purgeAuditLogId";
  IF NOT FOUND OR purge_audit.xmin <> pg_current_xact_id()::xid OR
     purge_audit."entryHash" IS NULL OR
     purge_audit."action" <> 'amux.v4.content.body_purged' OR
     purge_audit."targetType" <> 'AmuxIdeaContentKeyRetirement' OR
     purge_audit."targetId" <> NEW."ideaId" || ':repository_read_manifest:' || NEW."id"::text OR
     purge_audit."metadata"->>'ideaId' IS DISTINCT FROM NEW."ideaId" OR
     purge_audit."metadata"->>'purpose' IS DISTINCT FROM 'repository_read_manifest' OR
     purge_audit."metadata"->>'subjectId' IS DISTINCT FROM NEW."id"::text OR
     purge_audit."metadata"->>'digest' IS DISTINCT FROM NEW."digest" OR
     purge_audit."metadata"->>'digestKeyId' IS DISTINCT FROM NEW."digestKeyId" THEN
    RAISE EXCEPTION 'AMUX v19 read manifest purge audit mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaTrackedCheckoutReadManifest_purge_audit_guard';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaTrackedCheckoutReadManifest_retention_guard"
  BEFORE UPDATE OR DELETE ON "AmuxIdeaTrackedCheckoutReadManifest"
  FOR EACH ROW EXECUTE FUNCTION "amux_v19_read_manifest_retention_guard"();

COMMIT;
