-- baseline-check: replace-function-if-body-sha256 "amux_v4_retention_hold_guard" "36e0179996ab0600396125409a4c3f6e2a22287972c2ef71d687ff30d7d62bd5" "d0239c49cc123fc299823f8866dbcbc4bcbfe13fc1a1a6f081b3a2e3c3852a0d"
-- Owner direction 2026-11-16: a retention hold has no 90-day bound of ours.
-- 20261116120000 moved the clock CHECK to 36,500 days; the insert guard still
-- refused a hold past 90 days, so an owner's longer hold reached the database
-- and failed. The function body is the 20261004190100 one with only that
-- interval changed; its trigger is unchanged. A hold still needs an unexpired
-- expiry, an audited approval, and stays immutable except audited release and
-- notice.
BEGIN;

CREATE OR REPLACE FUNCTION amux_v4_retention_hold_guard()
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
       NEW."expiresAt" > db_now + INTERVAL '36500 days' OR
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

COMMIT;
