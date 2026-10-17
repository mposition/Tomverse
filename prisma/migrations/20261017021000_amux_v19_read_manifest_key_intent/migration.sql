-- The key identity is durable before an external PutObject. A missing or
-- uncertain object-store response cannot erase its seven-day cleanup target.
BEGIN;

CREATE TABLE "AmuxIdeaReadManifestKeyIntent" (
  "id" UUID NOT NULL,
  "ideaId" TEXT NOT NULL,
  "referenceOrdinal" INTEGER NOT NULL,
  "pinnedCommitSha" TEXT NOT NULL,
  "auditLogId" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "keyRetirementClaimedAt" TIMESTAMPTZ(3),
  "claimAuditLogId" TEXT,
  "keyDeletedAt" TIMESTAMPTZ(3),
  "keyDeleteAuditLogId" TEXT,
  CONSTRAINT "AmuxIdeaReadManifestKeyIntent_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AmuxIdeaReadManifestKeyIntent_shape_check" CHECK (
    "referenceOrdinal" >= 0 AND
    "pinnedCommitSha" ~ '^(?:[a-f0-9]{40}|[a-f0-9]{64})$' AND
    (("keyRetirementClaimedAt" IS NULL) = ("claimAuditLogId" IS NULL)) AND
    (("keyDeletedAt" IS NULL) = ("keyDeleteAuditLogId" IS NULL)) AND
    ("keyDeletedAt" IS NULL OR "keyRetirementClaimedAt" IS NOT NULL)
  )
);

CREATE UNIQUE INDEX "AmuxIdeaReadManifestKeyIntent_ideaId_referenceOrdinal_key"
  ON "AmuxIdeaReadManifestKeyIntent"("ideaId", "referenceOrdinal");
CREATE UNIQUE INDEX "AmuxIdeaReadManifestKeyIntent_auditLogId_key"
  ON "AmuxIdeaReadManifestKeyIntent"("auditLogId");
CREATE UNIQUE INDEX "AmuxIdeaReadManifestKeyIntent_claimAuditLogId_key"
  ON "AmuxIdeaReadManifestKeyIntent"("claimAuditLogId");
CREATE UNIQUE INDEX "AmuxIdeaReadManifestKeyIntent_keyDeleteAuditLogId_key"
  ON "AmuxIdeaReadManifestKeyIntent"("keyDeleteAuditLogId");
CREATE INDEX "AmuxIdeaReadManifestKeyIntent_keyDeletedAt_createdAt_idx"
  ON "AmuxIdeaReadManifestKeyIntent"("keyDeletedAt", "createdAt");

ALTER TABLE "AmuxIdeaReadManifestKeyIntent"
  ADD CONSTRAINT "AmuxIdeaReadManifestKeyIntent_ideaId_fkey"
    FOREIGN KEY ("ideaId") REFERENCES "AmuxIdeaSubmission"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaReadManifestKeyIntent_evidence_fkey"
    FOREIGN KEY ("ideaId", "referenceOrdinal")
    REFERENCES "AmuxIdeaTrackedCheckoutEvidence"("ideaId", "referenceOrdinal")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaReadManifestKeyIntent_auditLogId_fkey"
    FOREIGN KEY ("auditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaReadManifestKeyIntent_claimAuditLogId_fkey"
    FOREIGN KEY ("claimAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "AmuxIdeaReadManifestKeyIntent_keyDeleteAuditLogId_fkey"
    FOREIGN KEY ("keyDeleteAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "amux_v19_read_manifest_key_intent_guard"() RETURNS trigger
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
        WHERE m."ideaId" = NEW."ideaId" AND
          m."referenceOrdinal" = NEW."referenceOrdinal") OR
         NOT EXISTS (SELECT 1 FROM "AmuxIdeaSubmission" i
           WHERE i."id" = NEW."ideaId" AND
             i."submittedAt" + INTERVAL '7 days' <= clock_timestamp()) OR
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
      WHERE m."ideaId" = NEW."ideaId" AND
        m."referenceOrdinal" = NEW."referenceOrdinal") OR
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
     idea_row."analysisDeadlineAt" <= (clock_timestamp() AT TIME ZONE 'UTC') OR
     idea_row."submittedAt" + INTERVAL '7 days' <= clock_timestamp() THEN
    RAISE EXCEPTION 'AMUX v19 key intent idea is unavailable'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaReadManifestKeyIntent_idea_guard';
  END IF;

  SELECT "pinnedCommitSha" INTO evidence_row
  FROM "AmuxIdeaTrackedCheckoutEvidence"
  WHERE "ideaId" = NEW."ideaId" AND "referenceOrdinal" = NEW."referenceOrdinal";
  IF NOT FOUND OR evidence_row."pinnedCommitSha" <> NEW."pinnedCommitSha" OR
     EXISTS (SELECT 1 FROM "AmuxIdeaTrackedCheckoutReadManifest" m
       WHERE m."ideaId" = NEW."ideaId" AND
         m."referenceOrdinal" = NEW."referenceOrdinal") THEN
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

CREATE TRIGGER "AmuxIdeaReadManifestKeyIntent_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaReadManifestKeyIntent"
  FOR EACH ROW EXECUTE FUNCTION "amux_v19_read_manifest_key_intent_guard"();

-- The manifest writer and the sweeper serialize on this row. Once a due
-- retirement claim commits, a late manifest can never become a live body
-- backed by a key that the sweeper is about to destroy.
CREATE OR REPLACE FUNCTION "amux_v19_read_manifest_active_insert_guard"()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE key_row record;
BEGIN
  IF NEW."ciphertext" IS NULL OR NEW."keyId" IS NULL OR
     NEW."keyVersion" IS NULL OR NEW."bodyPurgedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'AMUX v19 read manifest insert requires an active body'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxIdeaTrackedCheckoutReadManifest_active_insert_guard';
  END IF;
  SELECT "ideaId", "referenceOrdinal", "pinnedCommitSha",
         "keyRetirementClaimedAt", "keyDeletedAt"
  INTO key_row FROM "AmuxIdeaReadManifestKeyIntent"
  WHERE "id" = NEW."id" FOR UPDATE;
  IF NOT FOUND OR key_row."ideaId" <> NEW."ideaId" OR
     key_row."referenceOrdinal" <> NEW."referenceOrdinal" OR
     key_row."pinnedCommitSha" <> NEW."pinnedCommitSha" OR
     key_row."keyRetirementClaimedAt" IS NOT NULL OR
     key_row."keyDeletedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'AMUX v19 read manifest key is unavailable'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxIdeaTrackedCheckoutReadManifest_key_claim_guard';
  END IF;
  RETURN NEW;
END;
$$;

-- A legal hold approved after retirement has been claimed would otherwise
-- race the external deletion. Serialize on the same idea row and fail closed
-- until the claim has been verified or manually reconciled.
CREATE FUNCTION "amux_v19_key_claim_hold_guard"() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
  PERFORM 1 FROM "AmuxIdeaSubmission" WHERE "id" = NEW."ideaId" FOR UPDATE;
  IF EXISTS (SELECT 1 FROM "AmuxIdeaReadManifestKeyIntent" k
    WHERE k."ideaId" = NEW."ideaId" AND
      k."keyRetirementClaimedAt" IS NOT NULL AND k."keyDeletedAt" IS NULL) THEN
    RAISE EXCEPTION 'AMUX v19 read-manifest key retirement is in progress'
      USING ERRCODE = '23514',
        CONSTRAINT = 'AmuxIdeaRetentionHold_read_manifest_key_claim';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaRetentionHold_read_manifest_key_claim_guard"
  BEFORE INSERT ON "AmuxIdeaRetentionHold"
  FOR EACH ROW EXECUTE FUNCTION "amux_v19_key_claim_hold_guard"();

COMMIT;
