-- AMUX v4 normalized proposal units, phase B. No live writer is enabled.
-- Each unit is independently encrypted, decided and purged; a monolithic
-- chunk ciphertext would retain rejected/expired neighbors after partial
-- approval, so it is forbidden before any non-synthetic draft writer opens.

BEGIN;

ALTER TABLE "AmuxIdeaAnalysisChunk"
    ADD CONSTRAINT "AmuxIdeaAnalysisChunk_no_monolithic_draft_check"
    CHECK ("draftCiphertext" IS NULL AND "draftKeyId" IS NULL AND "draftKeyVersion" IS NULL);

CREATE TABLE "AmuxIdeaDraftUnit" (
    "id" TEXT NOT NULL,
    "ideaId" TEXT NOT NULL,
    "actorUserId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "unitIndex" INTEGER NOT NULL,
    "unitKind" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "bodyCiphertext" BYTEA,
    "bodyKeyId" TEXT,
    "bodyKeyVersion" INTEGER,
    "bodyDigest" TEXT NOT NULL,
    "bodyDigestKeyId" TEXT NOT NULL,
    "finalDecisionAt" TIMESTAMP(3),
    "bodyPurgeAfter" TIMESTAMP(3),
    "bodyPurgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AmuxIdeaDraftUnit_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "AmuxIdeaDraftUnit_unit_index_check" CHECK ("unitIndex" >= 0 AND "chunkIndex" >= 0),
    CONSTRAINT "AmuxIdeaDraftUnit_kind_check" CHECK ("unitKind" IN ('node', 'card', 'evidence')),
    CONSTRAINT "AmuxIdeaDraftUnit_state_check" CHECK ("state" IN ('proposed', 'approved', 'rejected', 'expired')),
    CONSTRAINT "AmuxIdeaDraftUnit_body_pair_check" CHECK (
        ("bodyCiphertext" IS NULL AND "bodyKeyId" IS NULL AND "bodyKeyVersion" IS NULL) OR
        ("bodyCiphertext" IS NOT NULL AND "bodyKeyId" IS NOT NULL AND length("bodyKeyId") > 0 AND
         "bodyKeyVersion" IS NOT NULL AND "bodyKeyVersion" > 0)
    ),
    CONSTRAINT "AmuxIdeaDraftUnit_digest_check" CHECK (
        "bodyDigest" ~ '^[a-f0-9]{64}$' AND length("bodyDigestKeyId") > 0
    ),
    CONSTRAINT "AmuxIdeaDraftUnit_decision_clock_check" CHECK (
        ("state" = 'proposed' AND "finalDecisionAt" IS NULL AND "bodyPurgeAfter" IS NULL) OR
        ("state" IN ('approved', 'rejected') AND "finalDecisionAt" IS NOT NULL AND
         "finalDecisionAt" < "expiresAt" AND
         "bodyPurgeAfter" = "finalDecisionAt" + INTERVAL '30 days') OR
        ("state" = 'expired' AND "finalDecisionAt" IS NULL AND "bodyPurgeAfter" = "expiresAt")
    ),
    CONSTRAINT "AmuxIdeaDraftUnit_purged_check" CHECK (
        (("bodyCiphertext" IS NULL) = ("bodyPurgedAt" IS NOT NULL)) AND
        ("bodyPurgedAt" IS NULL OR
         ("state" <> 'proposed' AND "bodyPurgedAt" >= "bodyPurgeAfter"))
    )
);

CREATE UNIQUE INDEX "AmuxIdeaDraftUnit_ideaId_chunkIndex_unitIndex_key"
    ON "AmuxIdeaDraftUnit"("ideaId", "chunkIndex", "unitIndex");
CREATE INDEX "AmuxIdeaDraftUnit_actorUserId_ideaId_idx"
    ON "AmuxIdeaDraftUnit"("actorUserId", "ideaId");
CREATE INDEX "AmuxIdeaDraftUnit_bodyPurgeAfter_due_idx"
    ON "AmuxIdeaDraftUnit"("bodyPurgeAfter") WHERE "bodyPurgedAt" IS NULL;
CREATE INDEX "AmuxIdeaDraftUnit_expiresAt_open_idx"
    ON "AmuxIdeaDraftUnit"("expiresAt") WHERE "state" = 'proposed';

ALTER TABLE "AmuxIdeaDraftUnit"
    ADD CONSTRAINT "AmuxIdeaDraftUnit_ideaId_actorUserId_fkey"
    FOREIGN KEY ("ideaId", "actorUserId") REFERENCES "AmuxIdeaSubmission"("id", "actorUserId")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
    ADD CONSTRAINT "AmuxIdeaDraftUnit_ideaId_chunkIndex_fkey"
    FOREIGN KEY ("ideaId", "chunkIndex") REFERENCES "AmuxIdeaAnalysisChunk"("ideaId", "chunkIndex")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- A unit's absolute clock is copied from the chunk's completed analysis,
-- never from when a worker finally inserts the row. Once set, completion is
-- immutable so a later chunk update cannot move all child deadlines.
CREATE FUNCTION amux_v4_chunk_completion_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND OLD."analysisCompletedAt" IS NOT NULL AND
       NEW."analysisCompletedAt" IS DISTINCT FROM OLD."analysisCompletedAt" THEN
        RAISE EXCEPTION 'analysis completion clock is immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaAnalysisChunk_completion_immutable_check';
    END IF;
    IF NEW."analysisCompletedAt" IS NOT NULL AND
       NEW."analysisCompletedAt" > (clock_timestamp() AT TIME ZONE 'UTC') THEN
        RAISE EXCEPTION 'analysis completion cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaAnalysisChunk_completion_future_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaAnalysisChunk_completion_immutable"
BEFORE INSERT OR UPDATE ON "AmuxIdeaAnalysisChunk"
FOR EACH ROW EXECUTE FUNCTION amux_v4_chunk_completion_immutable();

CREATE FUNCTION amux_v4_draft_unit_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    completed_at timestamp(3);
    db_now timestamp(3) := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'unit deletion requires a separately approved retention path'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_no_delete_check';
    END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT "analysisCompletedAt" INTO completed_at
          FROM public."AmuxIdeaAnalysisChunk"
         WHERE "ideaId" = NEW."ideaId" AND "chunkIndex" = NEW."chunkIndex" FOR SHARE;
        IF completed_at IS NULL OR NEW."state" <> 'proposed' THEN
            RAISE EXCEPTION 'unit requires a completed chunk and proposed state'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_insert_boundary_check';
        END IF;
        IF db_now >= completed_at + INTERVAL '30 days' THEN
            RAISE EXCEPTION 'unit cannot be created after analysis expiry'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_insert_expired_check';
        END IF;
        NEW."expiresAt" := completed_at + INTERVAL '30 days';
        RETURN NEW;
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id" OR
       NEW."ideaId" IS DISTINCT FROM OLD."ideaId" OR
       NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId" OR
       NEW."chunkIndex" IS DISTINCT FROM OLD."chunkIndex" OR
       NEW."unitIndex" IS DISTINCT FROM OLD."unitIndex" OR
       NEW."unitKind" IS DISTINCT FROM OLD."unitKind" OR
       NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" OR
       NEW."bodyDigest" IS DISTINCT FROM OLD."bodyDigest" OR
       NEW."bodyDigestKeyId" IS DISTINCT FROM OLD."bodyDigestKeyId" OR
       NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
        RAISE EXCEPTION 'unit identity and expiry are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_identity_immutable_check';
    END IF;

    IF OLD."state" = 'proposed' AND NEW."state" IS DISTINCT FROM OLD."state" THEN
        IF NEW."state" IN ('approved', 'rejected') THEN
            IF db_now >= OLD."expiresAt" THEN
                RAISE EXCEPTION 'unit decision after expiry is refused'
                    USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_decision_expired_check';
            END IF;
            NEW."finalDecisionAt" := db_now;
            NEW."bodyPurgeAfter" := db_now + INTERVAL '30 days';
        ELSIF NEW."state" = 'expired' THEN
            IF db_now < OLD."expiresAt" THEN
                RAISE EXCEPTION 'unit cannot expire early'
                    USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_early_expiry_check';
            END IF;
            NEW."bodyPurgeAfter" := OLD."expiresAt";
        ELSE
            RAISE EXCEPTION 'unit transition is refused'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_transition_check';
        END IF;
    ELSIF NEW."state" IS DISTINCT FROM OLD."state" OR
          NEW."finalDecisionAt" IS DISTINCT FROM OLD."finalDecisionAt" OR
          NEW."bodyPurgeAfter" IS DISTINCT FROM OLD."bodyPurgeAfter" THEN
        RAISE EXCEPTION 'unit terminal state and purge clock are immutable'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_transition_check';
    END IF;

    IF OLD."bodyPurgedAt" IS NOT NULL THEN
        IF NEW."bodyCiphertext" IS DISTINCT FROM OLD."bodyCiphertext" OR
           NEW."bodyKeyId" IS DISTINCT FROM OLD."bodyKeyId" OR
           NEW."bodyKeyVersion" IS DISTINCT FROM OLD."bodyKeyVersion" OR
           NEW."bodyPurgedAt" IS DISTINCT FROM OLD."bodyPurgedAt" THEN
            RAISE EXCEPTION 'purged unit body cannot be restored'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_no_resurrection_check';
        END IF;
    ELSIF OLD."bodyCiphertext" IS NOT NULL AND NEW."bodyCiphertext" IS NULL THEN
        IF NEW."state" = 'proposed' OR NEW."bodyPurgeAfter" IS NULL OR
           db_now < NEW."bodyPurgeAfter" THEN
            RAISE EXCEPTION 'unit body purge is not yet eligible'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_early_purge_check';
        END IF;
        NEW."bodyKeyId" := NULL;
        NEW."bodyKeyVersion" := NULL;
        NEW."bodyPurgedAt" := db_now;
    ELSIF NEW."bodyCiphertext" IS DISTINCT FROM OLD."bodyCiphertext" OR
          NEW."bodyKeyId" IS DISTINCT FROM OLD."bodyKeyId" OR
          NEW."bodyKeyVersion" IS DISTINCT FROM OLD."bodyKeyVersion" OR
          NEW."bodyPurgedAt" IS DISTINCT FROM OLD."bodyPurgedAt" THEN
        RAISE EXCEPTION 'unit body is immutable until eligible purge'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_body_immutable_check';
    END IF;
    RETURN NEW;
END;
$$;

CREATE TRIGGER "AmuxIdeaDraftUnit_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaDraftUnit"
FOR EACH ROW EXECUTE FUNCTION amux_v4_draft_unit_guard();

COMMIT;
