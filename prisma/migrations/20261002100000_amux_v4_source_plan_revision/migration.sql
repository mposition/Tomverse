-- AMUX v4 dark source-plan revision boundary. This migration is additive:
-- no writer, CLI call, owner approval, promotion or deployment is enabled.
-- Only server-keyed digests of ordered source units are retained here; raw
-- ideas, private paths, excerpts and model responses remain in their own
-- separately purgeable encrypted fields.
-- The future writer must use manifestDigestKeyId for both manifestDigest and
-- unitDigests, with an idea/revision-specific HMAC domain; the database cannot
-- verify a secret-keyed digest or bind audit metadata by itself.

BEGIN;
-- A busy audit writer must not leave this migration queued behind its lock.
SET LOCAL lock_timeout = '5s';

-- Versioned and immutable by policy: changing this function later would make
-- historical CHECK results unstable during dump/restore.
CREATE FUNCTION amux_v4_keyed_digest_array_valid(digests text[])
RETURNS boolean LANGUAGE sql IMMUTABLE STRICT SET search_path = pg_catalog, public, pg_temp AS $$
    SELECT cardinality(digests) > 0 AND NOT EXISTS (
        SELECT 1 FROM unnest(digests) AS entry(value)
         WHERE entry.value IS NULL OR entry.value !~ '^[a-f0-9]{64}$'
    );
$$;

CREATE TABLE "AmuxIdeaSourcePlanRevision" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "revisionNumber" INTEGER NOT NULL,
    "startChunkIndex" INTEGER NOT NULL,
    "sourceUnitCount" INTEGER NOT NULL,
    "unitDigests" TEXT[] NOT NULL,
    "manifestDigest" TEXT NOT NULL,
    "manifestDigestKeyId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "predecessorId" TEXT,
    "creationAuditLogId" TEXT NOT NULL,
    "activatedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmuxIdeaSourcePlanRevision_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxIdeaSourcePlanRevision_position_check" CHECK (
        "revisionNumber" >= 1 AND "startChunkIndex" >= 0 AND "sourceUnitCount" >= 1 AND
        cardinality("unitDigests") = "sourceUnitCount" AND
        array_ndims("unitDigests") = 1 AND array_lower("unitDigests", 1) = 1 AND
        amux_v4_keyed_digest_array_valid("unitDigests")
    ),
    CONSTRAINT "AmuxIdeaSourcePlanRevision_manifest_digest_check" CHECK (
        "manifestDigest" ~ '^[a-f0-9]{64}$' AND length("manifestDigestKeyId") > 0
    ),
    CONSTRAINT "AmuxIdeaSourcePlanRevision_predecessor_check" CHECK (
        ("revisionNumber" = 1 AND "predecessorId" IS NULL AND "startChunkIndex" = 0) OR
        ("revisionNumber" > 1 AND "predecessorId" IS NOT NULL AND
         "predecessorId" <> "id")
    ),
    CONSTRAINT "AmuxIdeaSourcePlanRevision_state_check" CHECK (
        "state" IN ('prepared', 'active', 'awaiting_owner', 'superseded', 'complete', 'cancelled')
    ),
    CONSTRAINT "AmuxIdeaSourcePlanRevision_clock_check" CHECK (
        ("state" = 'prepared' AND "activatedAt" IS NULL AND "closedAt" IS NULL) OR
        ("state" = 'active' AND "activatedAt" IS NOT NULL AND "closedAt" IS NULL) OR
        ("state" = 'cancelled' AND "closedAt" IS NOT NULL AND
         ("activatedAt" IS NULL OR "closedAt" >= "activatedAt")) OR
        ("state" IN ('awaiting_owner', 'superseded', 'complete') AND
         "activatedAt" IS NOT NULL AND "closedAt" IS NOT NULL AND "closedAt" >= "activatedAt")
    )
);

CREATE UNIQUE INDEX "AmuxIdeaSourcePlanRevision_ideaId_revisionNumber_key"
    ON "AmuxIdeaSourcePlanRevision"("ideaId", "revisionNumber");
CREATE UNIQUE INDEX "AmuxIdeaSourcePlanRevision_ideaId_startChunkIndex_key"
    ON "AmuxIdeaSourcePlanRevision"("ideaId", "startChunkIndex");
CREATE UNIQUE INDEX "AmuxIdeaSourcePlanRevision_id_ideaId_key"
    ON "AmuxIdeaSourcePlanRevision"("id", "ideaId");
CREATE UNIQUE INDEX "AmuxIdeaSourcePlanRevision_id_ideaId_startChunkIndex_key"
    ON "AmuxIdeaSourcePlanRevision"("id", "ideaId", "startChunkIndex");
CREATE UNIQUE INDEX "AmuxIdeaSourcePlanRevision_predecessorId_key"
    ON "AmuxIdeaSourcePlanRevision"("predecessorId") WHERE "predecessorId" IS NOT NULL;
CREATE UNIQUE INDEX "AmuxIdeaSourcePlanRevision_creationAuditLogId_key"
    ON "AmuxIdeaSourcePlanRevision"("creationAuditLogId");
CREATE UNIQUE INDEX "AmuxIdeaSourcePlanRevision_one_active_per_idea"
    ON "AmuxIdeaSourcePlanRevision"("ideaId") WHERE "state" = 'active';
CREATE INDEX "AmuxIdeaSourcePlanRevision_ideaId_state_idx"
    ON "AmuxIdeaSourcePlanRevision"("ideaId", "state");

ALTER TABLE "AmuxIdeaSourcePlanRevision"
    ADD CONSTRAINT "AmuxIdeaSourcePlanRevision_ideaId_actorUserId_fkey"
    FOREIGN KEY ("ideaId", "actorUserId") REFERENCES "AmuxIdeaSubmission"("id", "actorUserId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaSourcePlanRevision_predecessorId_ideaId_fkey"
    FOREIGN KEY ("predecessorId", "ideaId") REFERENCES "AmuxIdeaSourcePlanRevision"("id", "ideaId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaSourcePlanRevision_creationAuditLogId_fkey"
    FOREIGN KEY ("creationAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AmuxIdeaSubmission"
    ADD COLUMN "currentSourcePlanRevisionId" TEXT;
CREATE UNIQUE INDEX "AmuxIdeaSubmission_currentSourcePlanRevisionId_id_key"
    ON "AmuxIdeaSubmission"("currentSourcePlanRevisionId", "id");
ALTER TABLE "AmuxIdeaSubmission"
    ADD CONSTRAINT "AmuxIdeaSubmission_currentSourcePlanRevisionId_id_fkey"
    FOREIGN KEY ("currentSourcePlanRevisionId", "id")
    REFERENCES "AmuxIdeaSourcePlanRevision"("id", "ideaId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AmuxIdeaAnalysisChunk"
    ADD COLUMN "sourcePlanRevisionId" TEXT,
    ADD COLUMN "planStartChunkIndex" INTEGER,
    ADD COLUMN "revisionChunkIndex" INTEGER,
    ADD COLUMN "coverageStatus" TEXT,
    ADD COLUMN "continuationKind" TEXT,
    ADD COLUMN "outputPartIndex" INTEGER,
    ADD COLUMN "outputPending" BOOLEAN;
ALTER TABLE "AmuxIdeaAnalysisChunk"
    ADD CONSTRAINT "AmuxIdeaAnalysisChunk_plan_position_check" CHECK (
        ("sourcePlanRevisionId" IS NULL AND "planStartChunkIndex" IS NULL AND
         "revisionChunkIndex" IS NULL) OR
        ("sourcePlanRevisionId" IS NOT NULL AND "planStartChunkIndex" IS NOT NULL AND
         "revisionChunkIndex" IS NOT NULL AND "planStartChunkIndex" >= 0 AND
         "revisionChunkIndex" >= 0 AND
         "chunkIndex" = "planStartChunkIndex" + "revisionChunkIndex")
    ),
    ADD CONSTRAINT "AmuxIdeaAnalysisChunk_cursor_check" CHECK (COALESCE(
        ("coverageStatus" IS NULL AND "continuationKind" IS NULL AND
         "outputPartIndex" IS NULL AND "outputPending" IS NULL) OR
        ("coverageStatus" IN ('complete', 'more', 'needs_owner_input') AND
         "sourcePlanRevisionId" IS NOT NULL AND "coveredStartOrdinal" IS NOT NULL AND
         "coveredEndOrdinal" IS NOT NULL AND "outputPartIndex" IS NOT NULL AND
         "outputPartIndex" >= 0 AND "outputPending" IS NOT NULL AND
         (("coverageStatus" = 'complete' AND "continuationKind" IS NULL AND
           "outputPending" = false AND "remainingStartOrdinal" IS NULL AND
           "remainingEndOrdinal" IS NULL) OR
          ("coverageStatus" = 'more' AND "continuationKind" IN ('input', 'output') AND
           "outputPending" = ("continuationKind" = 'output') AND
           "remainingStartOrdinal" IS NOT NULL AND
           (("continuationKind" = 'input' AND
             "remainingStartOrdinal" = "coveredEndOrdinal" + 1) OR
            ("continuationKind" = 'output' AND
             "remainingStartOrdinal" = "coveredEndOrdinal"))) OR
          ("coverageStatus" = 'needs_owner_input' AND
           ("continuationKind" IS NULL OR "continuationKind" = 'input') AND
           "outputPending" = false AND
           (("continuationKind" IS NULL AND "remainingStartOrdinal" IS NULL AND
             "remainingEndOrdinal" IS NULL) OR
            ("continuationKind" = 'input' AND
             "remainingStartOrdinal" = "coveredEndOrdinal" + 1 AND
             "remainingEndOrdinal" IS NOT NULL)))))
    , false));
CREATE UNIQUE INDEX "AmuxIdeaAnalysisChunk_plan_chunk_key"
    ON "AmuxIdeaAnalysisChunk"("sourcePlanRevisionId", "revisionChunkIndex");
CREATE UNIQUE INDEX "AmuxIdeaAnalysisChunk_idea_chunk_plan_key"
    ON "AmuxIdeaAnalysisChunk"("ideaId", "chunkIndex", "sourcePlanRevisionId");
CREATE UNIQUE INDEX "AmuxIdeaAnalysisChunk_current_preview_plan_key"
    ON "AmuxIdeaAnalysisChunk"("currentPreviewId", "ideaId", "chunkIndex", "sourcePlanRevisionId");
ALTER TABLE "AmuxIdeaAnalysisChunk"
    ADD CONSTRAINT "AmuxIdeaAnalysisChunk_source_plan_fkey"
    FOREIGN KEY ("sourcePlanRevisionId", "ideaId", "planStartChunkIndex")
    REFERENCES "AmuxIdeaSourcePlanRevision"("id", "ideaId", "startChunkIndex")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AmuxIdeaTransferPreview"
    ADD COLUMN "sourcePlanRevisionId" TEXT,
    ADD COLUMN "sourceUnitOrdinal" INTEGER;
ALTER TABLE "AmuxIdeaTransferPreview"
    ADD CONSTRAINT "AmuxIdeaTransferPreview_plan_unit_check" CHECK (
        ("sourcePlanRevisionId" IS NULL AND "sourceUnitOrdinal" IS NULL) OR
        ("sourcePlanRevisionId" IS NOT NULL AND "sourceUnitOrdinal" IS NOT NULL AND
         "sourceUnitOrdinal" >= 0)
    );
CREATE INDEX "AmuxIdeaTransferPreview_sourcePlanRevisionId_idx"
    ON "AmuxIdeaTransferPreview"("sourcePlanRevisionId");
CREATE UNIQUE INDEX "AmuxIdeaTransferPreview_id_idea_chunk_plan_key"
    ON "AmuxIdeaTransferPreview"("id", "ideaId", "chunkIndex", "sourcePlanRevisionId");
ALTER TABLE "AmuxIdeaTransferPreview"
    ADD CONSTRAINT "AmuxIdeaTransferPreview_sourcePlanRevisionId_ideaId_fkey"
    FOREIGN KEY ("sourcePlanRevisionId", "ideaId")
    REFERENCES "AmuxIdeaSourcePlanRevision"("id", "ideaId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaTransferPreview_chunk_plan_fkey"
    FOREIGN KEY ("ideaId", "chunkIndex", "sourcePlanRevisionId")
    REFERENCES "AmuxIdeaAnalysisChunk"("ideaId", "chunkIndex", "sourcePlanRevisionId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AmuxIdeaAnalysisChunk"
    ADD CONSTRAINT "AmuxIdeaAnalysisChunk_current_preview_plan_fkey"
    FOREIGN KEY ("currentPreviewId", "ideaId", "chunkIndex", "sourcePlanRevisionId")
    REFERENCES "AmuxIdeaTransferPreview"("id", "ideaId", "chunkIndex", "sourcePlanRevisionId")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- State changes cannot rewrite the ordered source identity. The database
-- supplies transition clocks; a future single writer must additionally lock
-- the idea row and compare its current plan pointer before each write.
CREATE FUNCTION amux_v4_source_plan_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    db_now timestamp(3) := clock_timestamp() AT TIME ZONE 'UTC';
    prior_revision integer;
    prior_start integer;
    prior_state text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'source plan deletion is refused'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSourcePlanRevision_no_delete_check';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW."state" <> 'prepared' OR NEW."activatedAt" IS NOT NULL OR
           NEW."closedAt" IS NOT NULL THEN
            RAISE EXCEPTION 'source plan must start prepared'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSourcePlanRevision_insert_check';
        END IF;
        IF NEW."predecessorId" IS NOT NULL THEN
            SELECT "revisionNumber", "startChunkIndex", "state"
              INTO prior_revision, prior_start, prior_state
              FROM public."AmuxIdeaSourcePlanRevision"
             WHERE "id" = NEW."predecessorId" AND "ideaId" = NEW."ideaId" FOR SHARE;
            IF NOT FOUND OR prior_revision + 1 <> NEW."revisionNumber" OR
               prior_start >= NEW."startChunkIndex" OR
               prior_state NOT IN ('awaiting_owner', 'superseded', 'complete', 'cancelled') THEN
                RAISE EXCEPTION 'source plan predecessor is not a closed adjacent revision'
                    USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSourcePlanRevision_predecessor_order_check';
            END IF;
        END IF;
        RETURN NEW;
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id" OR
       NEW."ideaId" IS DISTINCT FROM OLD."ideaId" OR
       NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId" OR
       NEW."revisionNumber" IS DISTINCT FROM OLD."revisionNumber" OR
       NEW."startChunkIndex" IS DISTINCT FROM OLD."startChunkIndex" OR
       NEW."sourceUnitCount" IS DISTINCT FROM OLD."sourceUnitCount" OR
       NEW."unitDigests" IS DISTINCT FROM OLD."unitDigests" OR
       NEW."manifestDigest" IS DISTINCT FROM OLD."manifestDigest" OR
       NEW."manifestDigestKeyId" IS DISTINCT FROM OLD."manifestDigestKeyId" OR
       NEW."predecessorId" IS DISTINCT FROM OLD."predecessorId" OR
       NEW."creationAuditLogId" IS DISTINCT FROM OLD."creationAuditLogId" OR
       NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'source plan identity is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSourcePlanRevision_identity_immutable_check';
    END IF;
    IF NEW."state" IS NOT DISTINCT FROM OLD."state" THEN
        IF NEW."activatedAt" IS DISTINCT FROM OLD."activatedAt" OR
           NEW."closedAt" IS DISTINCT FROM OLD."closedAt" THEN
            RAISE EXCEPTION 'source plan clocks are database-owned'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSourcePlanRevision_clock_immutable_check';
        END IF;
        RETURN NEW;
    END IF;
    IF OLD."state" = 'prepared' AND NEW."state" = 'active' THEN
        NEW."activatedAt" := db_now;
        NEW."closedAt" := NULL;
    ELSIF OLD."state" = 'prepared' AND NEW."state" = 'cancelled' THEN
        NEW."activatedAt" := NULL;
        NEW."closedAt" := db_now;
    ELSIF OLD."state" = 'active' AND
          NEW."state" IN ('awaiting_owner', 'superseded', 'complete', 'cancelled') THEN
        NEW."activatedAt" := OLD."activatedAt";
        NEW."closedAt" := db_now;
    ELSIF OLD."state" = 'awaiting_owner' AND NEW."state" = 'superseded' THEN
        NEW."activatedAt" := OLD."activatedAt";
        NEW."closedAt" := OLD."closedAt";
    ELSE
        RAISE EXCEPTION 'source plan transition is refused'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSourcePlanRevision_transition_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaSourcePlanRevision_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaSourcePlanRevision"
FOR EACH ROW EXECUTE FUNCTION amux_v4_source_plan_guard();

CREATE FUNCTION amux_v4_chunk_plan_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF OLD."sourcePlanRevisionId" IS NOT NULL AND
       (NEW."sourcePlanRevisionId" IS DISTINCT FROM OLD."sourcePlanRevisionId" OR
        NEW."planStartChunkIndex" IS DISTINCT FROM OLD."planStartChunkIndex" OR
        NEW."revisionChunkIndex" IS DISTINCT FROM OLD."revisionChunkIndex") THEN
        RAISE EXCEPTION 'bound chunk cannot change source plan or global identity'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaAnalysisChunk_plan_immutable_check';
    END IF;
    IF OLD."sourcePlanRevisionId" IS NULL AND NEW."sourcePlanRevisionId" IS NOT NULL AND
       OLD."analysisCompletedAt" IS NOT NULL THEN
        RAISE EXCEPTION 'completed chunk cannot be retroactively rebound'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaAnalysisChunk_late_plan_binding_check';
    END IF;
    IF OLD."coverageStatus" IS NOT NULL AND
       (NEW."coverageStatus" IS DISTINCT FROM OLD."coverageStatus" OR
        NEW."continuationKind" IS DISTINCT FROM OLD."continuationKind" OR
        NEW."outputPartIndex" IS DISTINCT FROM OLD."outputPartIndex" OR
        NEW."outputPending" IS DISTINCT FROM OLD."outputPending" OR
        NEW."coveredStartOrdinal" IS DISTINCT FROM OLD."coveredStartOrdinal" OR
        NEW."coveredEndOrdinal" IS DISTINCT FROM OLD."coveredEndOrdinal" OR
        NEW."remainingStartOrdinal" IS DISTINCT FROM OLD."remainingStartOrdinal" OR
        NEW."remainingEndOrdinal" IS DISTINCT FROM OLD."remainingEndOrdinal") THEN
        RAISE EXCEPTION 'completed cursor is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaAnalysisChunk_cursor_immutable_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaAnalysisChunk_plan_immutable"
BEFORE UPDATE ON "AmuxIdeaAnalysisChunk"
FOR EACH ROW EXECUTE FUNCTION amux_v4_chunk_plan_immutable();

COMMIT;
