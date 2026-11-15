-- Owner direction 2026-11-15: a session analysis goes on past day seven while
-- its idea's stored deadline allows it, so a new page may reserve its read
-- manifest key then. The key-intent guard checked that stored deadline and,
-- again, a fixed seven days after submission; only the fixed clause is
-- removed. An orphan key may still be claimed for retirement no sooner than
-- day seven, and now only once the idea's analysis has ended: a running
-- analysis may still record the intent's manifest.
-- baseline-check: replace-function-if-body-sha256 "amux_v19_read_manifest_key_intent_guard" "b6236997decd0f128836ce1e799933879d8faa48ac3ca1865ce184db7c644604" "85c77601fba96157abf307c990bf13c81039e319a63d7b09adf090446ede6a00"

BEGIN;

CREATE OR REPLACE FUNCTION "amux_v19_read_manifest_key_intent_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
  idea_row record;
  evidence_row record;
  intent_audit record;
  metadata jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD."keyDeletedAt" IS NOT NULL OR OLD."keyDeleteAuditLogId" IS NOT NULL OR
       NEW."id" IS DISTINCT FROM OLD."id" OR
       NEW."ideaId" IS DISTINCT FROM OLD."ideaId" OR
       NEW."referenceOrdinal" IS DISTINCT FROM OLD."referenceOrdinal" OR
       NEW."pinnedCommitSha" IS DISTINCT FROM OLD."pinnedCommitSha" OR
       NEW."auditLogId" IS DISTINCT FROM OLD."auditLogId" OR
       NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
      RAISE EXCEPTION 'AMUX v19 key intent is append only except verified deletion'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaReadManifestKeyIntent_append_only';
    END IF;
    IF OLD."keyRetirementClaimedAt" IS NULL THEN
      IF NEW."keyRetirementClaimedAt" IS NULL OR NEW."claimAuditLogId" IS NULL OR
         NEW."keyDeletedAt" IS NOT NULL OR NEW."keyDeleteAuditLogId" IS NOT NULL OR
         OLD."claimAuditLogId" IS NOT NULL THEN
        RAISE EXCEPTION 'AMUX v19 orphan key requires a retirement claim first'
          USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaReadManifestKeyIntent_claim_first';
      END IF;
      IF EXISTS (SELECT 1 FROM "AmuxIdeaTrackedCheckoutReadManifest" m
        WHERE m."id" = NEW."id") OR
         NOT EXISTS (SELECT 1 FROM "AmuxIdeaSubmission" i
           WHERE i."id" = NEW."ideaId" AND
             i."submittedAt" + INTERVAL '7 days' <= clock_timestamp() AND
             (i."analysisCompletedAt" IS NOT NULL OR i."cancelledAt" IS NOT NULL OR
              i."analysisDeadlineAt" <= (clock_timestamp() AT TIME ZONE 'UTC'))) OR
         EXISTS (SELECT 1 FROM "AmuxIdeaRetentionHold" h
           WHERE h."ideaId" = NEW."ideaId" AND h."releasedAt" IS NULL AND
             h."expiresAt" > clock_timestamp()) OR
         NEW."keyRetirementClaimedAt" > clock_timestamp() THEN
        RAISE EXCEPTION 'AMUX v19 orphan key is not due for retirement claim'
          USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaReadManifestKeyIntent_claim_due';
      END IF;
      SELECT a."action", a."targetType", a."targetId", a."summary", a."actorUserId",
             a."actorEmail", a."ipAddress", a."userAgent", a."metadata", a."entryHash", a.xmin
      INTO intent_audit FROM "AdminAuditLog" a WHERE a."id" = NEW."claimAuditLogId";
      metadata := intent_audit."metadata";
      IF NOT FOUND OR intent_audit."entryHash" IS NULL OR
         intent_audit.xmin <> pg_current_xact_id()::xid OR
         intent_audit."action" <> 'amux.v19.read_manifest.orphan_key_retirement_claimed' OR
         intent_audit."targetType" <> 'AmuxIdeaReadManifestKeyIntent' OR
         intent_audit."targetId" <> NEW."id"::text OR
         intent_audit."summary" <> 'Claimed retirement of an orphan AMUX v19 read-manifest content key.' OR
         intent_audit."actorUserId" IS NOT NULL OR
         intent_audit."actorEmail" IS NOT NULL OR
         intent_audit."ipAddress" IS NOT NULL OR
         intent_audit."userAgent" IS NOT NULL OR
         metadata IS NULL OR jsonb_typeof(metadata) <> 'object' OR
         NOT metadata ?& ARRAY['systemActor', 'actorScope', 'policyVersion',
           'manifestId', 'ideaId', 'referenceOrdinal', 'pinnedCommitSha',
           'intentAuditLogId'] OR
         (SELECT count(*) FROM jsonb_object_keys(metadata)) <> 8 OR
         metadata->>'systemActor' <> 'amux-v4-intake' OR
         metadata->>'actorScope' <> 'tracked-checkout-read-manifest-orphan-key-claim-v1' OR
         metadata->'policyVersion' IS DISTINCT FROM to_jsonb(19) OR
         metadata->>'manifestId' IS DISTINCT FROM NEW."id"::text OR
         metadata->>'ideaId' IS DISTINCT FROM NEW."ideaId" OR
         metadata->'referenceOrdinal' IS DISTINCT FROM to_jsonb(NEW."referenceOrdinal") OR
         metadata->>'pinnedCommitSha' IS DISTINCT FROM NEW."pinnedCommitSha" OR
         metadata->>'intentAuditLogId' IS DISTINCT FROM NEW."auditLogId" THEN
        RAISE EXCEPTION 'AMUX v19 orphan key claim audit evidence mismatch'
          USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaReadManifestKeyIntent_claim_audit';
      END IF;
      RETURN NEW;
    END IF;
    IF NEW."keyRetirementClaimedAt" IS DISTINCT FROM OLD."keyRetirementClaimedAt" OR
       NEW."claimAuditLogId" IS DISTINCT FROM OLD."claimAuditLogId" OR
       NEW."keyDeletedAt" IS NULL OR NEW."keyDeleteAuditLogId" IS NULL THEN
      RAISE EXCEPTION 'AMUX v19 claimed key can only record verified deletion'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaReadManifestKeyIntent_claimed_append_only';
    END IF;
    IF EXISTS (SELECT 1 FROM "AmuxIdeaTrackedCheckoutReadManifest" m
      WHERE m."id" = NEW."id") OR
       NOT EXISTS (SELECT 1 FROM "AmuxIdeaSubmission" i
         WHERE i."id" = NEW."ideaId" AND
           i."submittedAt" + INTERVAL '7 days' <= clock_timestamp()) OR
       NEW."keyDeletedAt" > clock_timestamp() THEN
      RAISE EXCEPTION 'AMUX v19 orphan key is not due for deletion'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaReadManifestKeyIntent_delete_due';
    END IF;
    SELECT a."action", a."targetType", a."targetId", a."summary", a."actorUserId",
           a."actorEmail", a."ipAddress", a."userAgent", a."metadata", a."entryHash", a.xmin
    INTO intent_audit FROM "AdminAuditLog" a WHERE a."id" = NEW."keyDeleteAuditLogId";
    metadata := intent_audit."metadata";
    IF NOT FOUND OR intent_audit."entryHash" IS NULL OR
       intent_audit.xmin <> pg_current_xact_id()::xid OR
       intent_audit."action" <> 'amux.v19.read_manifest.orphan_key_retired' OR
       intent_audit."targetType" <> 'AmuxIdeaReadManifestKeyIntent' OR
       intent_audit."targetId" <> NEW."id"::text OR
       intent_audit."summary" <> 'Verified deletion of an orphan AMUX v19 read-manifest content key.' OR
       intent_audit."actorUserId" IS NOT NULL OR
       intent_audit."actorEmail" IS NOT NULL OR
       intent_audit."ipAddress" IS NOT NULL OR
       intent_audit."userAgent" IS NOT NULL OR
       metadata IS NULL OR jsonb_typeof(metadata) <> 'object' OR
       NOT metadata ?& ARRAY['systemActor', 'actorScope', 'policyVersion',
         'manifestId', 'ideaId', 'referenceOrdinal', 'pinnedCommitSha',
         'intentAuditLogId', 'claimAuditLogId'] OR
       (SELECT count(*) FROM jsonb_object_keys(metadata)) <> 9 OR
       metadata->>'systemActor' <> 'amux-v4-intake' OR
       metadata->>'actorScope' <> 'tracked-checkout-read-manifest-orphan-key-retire-v1' OR
       metadata->'policyVersion' IS DISTINCT FROM to_jsonb(19) OR
       metadata->>'manifestId' IS DISTINCT FROM NEW."id"::text OR
       metadata->>'ideaId' IS DISTINCT FROM NEW."ideaId" OR
       metadata->'referenceOrdinal' IS DISTINCT FROM to_jsonb(NEW."referenceOrdinal") OR
       metadata->>'pinnedCommitSha' IS DISTINCT FROM NEW."pinnedCommitSha" OR
       metadata->>'intentAuditLogId' IS DISTINCT FROM NEW."auditLogId" OR
       metadata->>'claimAuditLogId' IS DISTINCT FROM NEW."claimAuditLogId" THEN
      RAISE EXCEPTION 'AMUX v19 orphan key deletion audit evidence mismatch'
        USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaReadManifestKeyIntent_delete_audit';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'AMUX v19 read-manifest key intent is append only'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaReadManifestKeyIntent_append_only';
  END IF;
  IF NEW."keyRetirementClaimedAt" IS NOT NULL OR NEW."claimAuditLogId" IS NOT NULL OR
     NEW."keyDeletedAt" IS NOT NULL OR NEW."keyDeleteAuditLogId" IS NOT NULL THEN
    RAISE EXCEPTION 'AMUX v19 key intent cannot begin deleted'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaReadManifestKeyIntent_active_insert';
  END IF;

  SELECT "submissionOrigin", "submittedAt", "cancelledAt", "analysisCompletedAt", "analysisDeadlineAt"
  INTO idea_row FROM "AmuxIdeaSubmission" WHERE "id" = NEW."ideaId" FOR KEY SHARE;
  IF NOT FOUND OR idea_row."submissionOrigin" <> 'session' OR
     idea_row."cancelledAt" IS NOT NULL OR idea_row."analysisCompletedAt" IS NOT NULL OR
     idea_row."analysisDeadlineAt" <= (clock_timestamp() AT TIME ZONE 'UTC') THEN
    RAISE EXCEPTION 'AMUX v19 key intent idea is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaReadManifestKeyIntent_idea_guard';
  END IF;

  SELECT "pinnedCommitSha" INTO evidence_row
  FROM "AmuxIdeaTrackedCheckoutEvidence"
  WHERE "ideaId" = NEW."ideaId" AND "referenceOrdinal" = NEW."referenceOrdinal";
  IF NOT FOUND OR evidence_row."pinnedCommitSha" <> NEW."pinnedCommitSha" OR
     EXISTS (SELECT 1 FROM "AmuxIdeaTrackedCheckoutReadManifest" m
       WHERE m."id" = NEW."id") THEN
    RAISE EXCEPTION 'AMUX v19 key intent pinned reference is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaReadManifestKeyIntent_reference_guard';
  END IF;

  SELECT a."action", a."targetType", a."targetId", a."summary", a."actorUserId",
         a."actorEmail", a."ipAddress", a."userAgent", a."metadata", a."entryHash", a.xmin
  INTO intent_audit FROM "AdminAuditLog" a WHERE a."id" = NEW."auditLogId";
  metadata := intent_audit."metadata";
  IF NOT FOUND OR intent_audit."entryHash" IS NULL OR
     intent_audit.xmin <> pg_current_xact_id()::xid OR
     intent_audit."action" <> 'amux.v19.read_manifest.key_intent' OR
     intent_audit."targetType" <> 'AmuxIdeaReadManifestKeyIntent' OR
     intent_audit."targetId" <> NEW."id"::text OR
     intent_audit."summary" <> 'Reserved an AMUX v19 read-manifest content key identity.' OR
     intent_audit."actorUserId" IS NOT NULL OR
     intent_audit."actorEmail" IS NOT NULL OR
     intent_audit."ipAddress" IS NOT NULL OR
     intent_audit."userAgent" IS NOT NULL OR
     metadata IS NULL OR jsonb_typeof(metadata) <> 'object' OR
     NOT metadata ?& ARRAY['systemActor', 'actorScope', 'policyVersion',
       'manifestId', 'ideaId', 'referenceOrdinal', 'pinnedCommitSha'] OR
     (SELECT count(*) FROM jsonb_object_keys(metadata)) <> 7 OR
     metadata->>'systemActor' <> 'amux-v4-intake' OR
     metadata->>'actorScope' <> 'tracked-checkout-read-manifest-key-intent-v1' OR
     metadata->'policyVersion' IS DISTINCT FROM to_jsonb(19) OR
     metadata->>'manifestId' IS DISTINCT FROM NEW."id"::text OR
     metadata->>'ideaId' IS DISTINCT FROM NEW."ideaId" OR
     metadata->'referenceOrdinal' IS DISTINCT FROM to_jsonb(NEW."referenceOrdinal") OR
     metadata->>'pinnedCommitSha' IS DISTINCT FROM NEW."pinnedCommitSha" THEN
    RAISE EXCEPTION 'AMUX v19 key intent audit evidence mismatch'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaReadManifestKeyIntent_audit_guard';
  END IF;
  RETURN NEW;
END;
$$;

COMMIT;
