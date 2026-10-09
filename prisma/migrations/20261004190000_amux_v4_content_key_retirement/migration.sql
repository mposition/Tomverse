-- A content body can be removed in the app transaction, but its external
-- key cannot. Keep a durable, content-free retirement record for read-back
-- and verified deletion. This migration enables no retention trigger.
BEGIN;

CREATE TABLE "AmuxIdeaContentKeyRetirement" (
    "ideaId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "bodyPurgedAt" TIMESTAMP(3) NOT NULL,
    "keyDeletedAt" TIMESTAMP(3),
    "purgeAuditLogId" TEXT NOT NULL,
    "keyDeleteAuditLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AmuxIdeaContentKeyRetirement_pkey"
      PRIMARY KEY ("ideaId", "purpose", "subjectId"),
    CONSTRAINT "AmuxIdeaContentKeyRetirement_purpose_check"
      CHECK ("purpose" IN ('idea_raw', 'transfer_payload',
        'analysis_freeform', 'analysis_draft')),
    CONSTRAINT "AmuxIdeaContentKeyRetirement_subject_check"
      CHECK ("subjectId" ~ '^[A-Za-z0-9:_-]{1,160}$'),
    CONSTRAINT "AmuxIdeaContentKeyRetirement_deleted_check"
      CHECK (("keyDeletedAt" IS NULL) = ("keyDeleteAuditLogId" IS NULL)
        AND ("keyDeletedAt" IS NULL OR "keyDeletedAt" >= "bodyPurgedAt")),
    CONSTRAINT "AmuxIdeaContentKeyRetirement_ideaId_fkey"
      FOREIGN KEY ("ideaId") REFERENCES "AmuxIdeaSubmission"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AmuxIdeaContentKeyRetirement_purgeAuditLogId_fkey"
      FOREIGN KEY ("purgeAuditLogId") REFERENCES "AdminAuditLog"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AmuxIdeaContentKeyRetirement_keyDeleteAuditLogId_fkey"
      FOREIGN KEY ("keyDeleteAuditLogId") REFERENCES "AdminAuditLog"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "AmuxIdeaContentKeyRetirement_purgeAuditLogId_key"
  ON "AmuxIdeaContentKeyRetirement"("purgeAuditLogId");
CREATE UNIQUE INDEX "AmuxIdeaContentKeyRetirement_keyDeleteAuditLogId_key"
  ON "AmuxIdeaContentKeyRetirement"("keyDeleteAuditLogId");
CREATE INDEX "AmuxIdeaContentKeyRetirement_keyDeletedAt_bodyPurgedAt_idx"
  ON "AmuxIdeaContentKeyRetirement"("keyDeletedAt", "bodyPurgedAt");

CREATE FUNCTION amux_v4_content_key_retirement_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'content key retirement cannot be deleted'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxIdeaContentKeyRetirement_no_delete_check';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."ideaId" IS DISTINCT FROM OLD."ideaId" OR
       NEW."purpose" IS DISTINCT FROM OLD."purpose" OR
       NEW."subjectId" IS DISTINCT FROM OLD."subjectId" OR
       NEW."bodyPurgedAt" IS DISTINCT FROM OLD."bodyPurgedAt" OR
       NEW."purgeAuditLogId" IS DISTINCT FROM OLD."purgeAuditLogId" OR
       NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
       OLD."keyDeletedAt" IS NOT NULL OR
       (NEW."keyDeletedAt" IS NULL AND NEW."keyDeleteAuditLogId" IS NOT NULL) THEN
      RAISE EXCEPTION 'content key retirement is append-only'
        USING ERRCODE = '23514',
          CONSTRAINT = 'AmuxIdeaContentKeyRetirement_immutable_check';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaContentKeyRetirement_guard"
BEFORE UPDATE OR DELETE ON "AmuxIdeaContentKeyRetirement"
FOR EACH ROW EXECUTE FUNCTION amux_v4_content_key_retirement_guard();

COMMIT;
