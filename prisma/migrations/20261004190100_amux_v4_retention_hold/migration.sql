-- An explicit, audited owner hold pauses analysis-body deletion without
-- moving any original purge clock. No writer or runtime switch opens here.
BEGIN;

CREATE TABLE "AmuxIdeaRetentionHold" (
    "id" UUID NOT NULL,
    "ideaId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "reasonCode" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "noticeAt" TIMESTAMP(3) NOT NULL,
    "noticeSentAt" TIMESTAMP(3),
    "noticeAuditLogId" TEXT,
    "approvalAuditLogId" TEXT NOT NULL,
    "releaseAuditLogId" TEXT,
    CONSTRAINT "AmuxIdeaRetentionHold_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxIdeaRetentionHold_reason_check"
      CHECK ("reasonCode" IN ('legal_request', 'dispute', 'incident', 'other')),
    CONSTRAINT "AmuxIdeaRetentionHold_clock_check"
      CHECK ("expiresAt" > "createdAt" AND
        "expiresAt" <= "createdAt" + INTERVAL '90 days' AND
        "noticeAt" = GREATEST("createdAt", "expiresAt" - INTERVAL '7 days')),
    CONSTRAINT "AmuxIdeaRetentionHold_release_check"
      CHECK (("releasedAt" IS NULL) = ("releaseAuditLogId" IS NULL) AND
        ("releasedAt" IS NULL OR "releasedAt" >= "createdAt")),
    CONSTRAINT "AmuxIdeaRetentionHold_notice_check"
      CHECK (("noticeSentAt" IS NULL) = ("noticeAuditLogId" IS NULL) AND
        ("noticeSentAt" IS NULL OR "noticeSentAt" >= "noticeAt")),
    CONSTRAINT "AmuxIdeaRetentionHold_ideaId_fkey"
      FOREIGN KEY ("ideaId") REFERENCES "AmuxIdeaSubmission"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AmuxIdeaRetentionHold_approvalAuditLogId_fkey"
      FOREIGN KEY ("approvalAuditLogId") REFERENCES "AdminAuditLog"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AmuxIdeaRetentionHold_releaseAuditLogId_fkey"
      FOREIGN KEY ("releaseAuditLogId") REFERENCES "AdminAuditLog"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT,
    CONSTRAINT "AmuxIdeaRetentionHold_noticeAuditLogId_fkey"
      FOREIGN KEY ("noticeAuditLogId") REFERENCES "AdminAuditLog"("id")
      ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "AmuxIdeaRetentionHold_approvalAuditLogId_key"
  ON "AmuxIdeaRetentionHold"("approvalAuditLogId");
CREATE UNIQUE INDEX "AmuxIdeaRetentionHold_releaseAuditLogId_key"
  ON "AmuxIdeaRetentionHold"("releaseAuditLogId");
CREATE UNIQUE INDEX "AmuxIdeaRetentionHold_noticeAuditLogId_key"
  ON "AmuxIdeaRetentionHold"("noticeAuditLogId");
CREATE INDEX "AmuxIdeaRetentionHold_ideaId_releasedAt_expiresAt_idx"
  ON "AmuxIdeaRetentionHold"("ideaId", "releasedAt", "expiresAt");
CREATE INDEX "AmuxIdeaRetentionHold_noticeAt_noticeSentAt_idx"
  ON "AmuxIdeaRetentionHold"("noticeAt", "noticeSentAt");

CREATE FUNCTION amux_v4_retention_hold_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE db_now timestamp(3) := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'retention hold cannot be deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaRetentionHold_no_delete_check';
  END IF;
  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := db_now;
    NEW."noticeAt" := GREATEST(db_now, NEW."expiresAt" - INTERVAL '7 days');
    IF NEW."expiresAt" <= db_now OR
       NEW."expiresAt" > db_now + INTERVAL '90 days' OR
       NEW."releasedAt" IS NOT NULL OR
       NEW."releaseAuditLogId" IS NOT NULL OR
       NEW."noticeSentAt" IS NOT NULL OR
       NEW."noticeAuditLogId" IS NOT NULL THEN
      RAISE EXCEPTION 'retention hold requires an unexpired bounded approval'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaRetentionHold_insert_check';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id" OR
     NEW."ideaId" IS DISTINCT FROM OLD."ideaId" OR
     NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId" OR
     NEW."reasonCode" IS DISTINCT FROM OLD."reasonCode" OR
     NEW."createdAt" IS DISTINCT FROM OLD."createdAt" OR
     NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR
     NEW."noticeAt" IS DISTINCT FROM OLD."noticeAt" OR
     NEW."approvalAuditLogId" IS DISTINCT FROM OLD."approvalAuditLogId" OR
     OLD."releasedAt" IS NOT NULL OR
     (NEW."releasedAt" IS DISTINCT FROM OLD."releasedAt" AND
      (NEW."releasedAt" IS NULL OR NEW."releaseAuditLogId" IS NULL)) OR
     (NEW."releaseAuditLogId" IS DISTINCT FROM OLD."releaseAuditLogId" AND
      NEW."releasedAt" IS NULL) OR
     (OLD."noticeSentAt" IS NOT NULL AND
      (NEW."noticeSentAt" IS DISTINCT FROM OLD."noticeSentAt" OR
       NEW."noticeAuditLogId" IS DISTINCT FROM OLD."noticeAuditLogId")) OR
     (NEW."noticeSentAt" IS DISTINCT FROM OLD."noticeSentAt" AND
      (NEW."noticeSentAt" IS NULL OR NEW."noticeAuditLogId" IS NULL)) OR
     (NEW."noticeAuditLogId" IS DISTINCT FROM OLD."noticeAuditLogId" AND
      NEW."noticeSentAt" IS NULL) THEN
    RAISE EXCEPTION 'retention hold is immutable except audited release and notice'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaRetentionHold_immutable_check';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaRetentionHold_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaRetentionHold"
FOR EACH ROW EXECUTE FUNCTION amux_v4_retention_hold_guard();

COMMIT;
