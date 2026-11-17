-- baseline-check: replace-function-if-body-sha256 "amux_v4_draft_unit_guard" "87fbf70d0fc99175716fa131e17c937effb3224b8e4c6fb80a737c32b9e02d5b" "e4f0bee9bd33c5fbe6a35cc459203fb4cbc593966e578efd6266825417e45bc8"
-- Operator, 2026-11-16: an undecided draft unit no longer expires 30 days
-- after its analysis, so a person who looks late does not find its body
-- deleted. A new unit's own-chunk clock is 36,500 days, matching the first
-- completed chunk's clock (amux_v4_draft_first_expiry_guard), which decides
-- the stored expiresAt.
--
-- expiresAt stays immutable with one exception: a unit that has not expired
-- may move it, in an update that changes nothing else about its state, to
-- exactly its idea's first completed chunk + 36,500 days, never earlier. That
-- moves every such unit onto the open clock below, so an undecided one stays
-- decidable and every unit of an idea keeps one clock (derivation compares
-- them). A decided body still purges 30 days after its decision (its own
-- clock, unchanged), and an expired unit's terminal state is not reopened.
-- The function body is the 20261001102300 one with only those clauses
-- changed; its trigger is unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION amux_v4_draft_unit_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    completed_at timestamp(3);
    first_completed timestamp(3);
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
        IF db_now >= completed_at + INTERVAL '36500 days' THEN
            RAISE EXCEPTION 'unit cannot be created after analysis expiry'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_insert_expired_check';
        END IF;
        NEW."expiresAt" := completed_at + INTERVAL '36500 days';
        RETURN NEW;
    END IF;

    IF NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt" THEN
        SELECT "analysisCompletedAt" INTO first_completed
          FROM public."AmuxIdeaAnalysisChunk"
         WHERE "ideaId" = OLD."ideaId" AND "chunkIndex" = 0 FOR SHARE;
        IF OLD."state" = 'expired' OR NEW."state" IS DISTINCT FROM OLD."state" OR
           first_completed IS NULL OR
           NEW."expiresAt" IS DISTINCT FROM first_completed + INTERVAL '36500 days' OR
           NEW."expiresAt" <= OLD."expiresAt" THEN
            RAISE EXCEPTION 'unit identity and expiry are immutable'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_identity_immutable_check';
        END IF;
    END IF;

    IF NEW."id" IS DISTINCT FROM OLD."id" OR
       NEW."ideaId" IS DISTINCT FROM OLD."ideaId" OR
       NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId" OR
       NEW."chunkIndex" IS DISTINCT FROM OLD."chunkIndex" OR
       NEW."unitIndex" IS DISTINCT FROM OLD."unitIndex" OR
       NEW."unitKind" IS DISTINCT FROM OLD."unitKind" OR
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

-- Every unit that has not expired moves onto the open clock. A proposed body
-- was never purgeable and a decided body keeps its decision clock, so nothing
-- deleted is restored and nothing is deleted sooner.
UPDATE "AmuxIdeaDraftUnit" u
   SET "expiresAt" = c."analysisCompletedAt" + INTERVAL '36500 days',
       "updatedAt" = clock_timestamp() AT TIME ZONE 'UTC'
  FROM "AmuxIdeaAnalysisChunk" c
 WHERE u."state" <> 'expired' AND c."ideaId" = u."ideaId" AND
       c."chunkIndex" = 0 AND c."analysisCompletedAt" IS NOT NULL AND
       u."expiresAt" < c."analysisCompletedAt" + INTERVAL '36500 days';

COMMIT;
