-- AMUX v4 policy v11: every page of one idea uses the first page's immutable
-- completion clock for its 30-day owner decision window. Do not rewrite older
-- migrations or silently reinterpret existing rows with a later deadline.
BEGIN;

LOCK TABLE public."AmuxIdeaDraftUnit" IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM public."AmuxIdeaDraftUnit" AS unit
        JOIN public."AmuxIdeaAnalysisChunk" AS first_chunk
          ON first_chunk."ideaId" = unit."ideaId" AND first_chunk."chunkIndex" = 0
        WHERE first_chunk."analysisCompletedAt" IS NULL OR
              unit."expiresAt" IS DISTINCT FROM
                first_chunk."analysisCompletedAt" + INTERVAL '30 days'
    ) THEN
        RAISE EXCEPTION 'existing AMUX draft expiry requires owner resolution before migration'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_origin_expiry_precheck';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION amux_v4_draft_unit_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    completed_at timestamp(3);
    first_completed_at timestamp(3);
    db_now timestamp(3) := clock_timestamp() AT TIME ZONE 'UTC';
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'unit deletion requires a separately approved retention path'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_no_delete_check';
    END IF;
    IF TG_OP = 'INSERT' THEN
        SELECT current_chunk."analysisCompletedAt", first_chunk."analysisCompletedAt"
          INTO completed_at, first_completed_at
          FROM public."AmuxIdeaAnalysisChunk" AS current_chunk
          JOIN public."AmuxIdeaAnalysisChunk" AS first_chunk
            ON first_chunk."ideaId" = current_chunk."ideaId" AND
               first_chunk."chunkIndex" = 0
         WHERE current_chunk."ideaId" = NEW."ideaId" AND
               current_chunk."chunkIndex" = NEW."chunkIndex"
         FOR SHARE OF current_chunk, first_chunk;
        IF completed_at IS NULL OR first_completed_at IS NULL OR
           NEW."state" <> 'proposed' THEN
            RAISE EXCEPTION 'unit requires completed current and first chunks and proposed state'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_insert_boundary_check';
        END IF;
        IF db_now >= first_completed_at + INTERVAL '30 days' THEN
            RAISE EXCEPTION 'unit cannot be created after first analysis expiry'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_insert_expired_check';
        END IF;
        NEW."expiresAt" := first_completed_at + INTERVAL '30 days';
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

COMMIT;
