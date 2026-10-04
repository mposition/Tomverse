-- Refuse a newly completed analysis after its immutable seven-day idea
-- deadline. Existing completed chunks remain readable and decidable; this
-- migration neither rewrites them nor starts an analysis worker.
-- baseline-check: replace-function-if-body-sha256 "amux_v4_chunk_completion_immutable" "d0e8a0fa6cd37de122a54f71385e408c8b21444e262bdee17e0df632f4441b2b"

BEGIN;

CREATE OR REPLACE FUNCTION amux_v4_chunk_completion_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE
    deadline_at timestamp(3);
    db_now timestamp(3) := clock_timestamp() AT TIME ZONE 'UTC';
    first_completion boolean;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD."analysisCompletedAt" IS NOT NULL AND
           NEW."analysisCompletedAt" IS DISTINCT FROM OLD."analysisCompletedAt" THEN
            RAISE EXCEPTION 'analysis completion clock is immutable'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaAnalysisChunk_completion_immutable_check';
        END IF;
        first_completion :=
            (OLD."analysisCompletedAt" IS NULL AND NEW."analysisCompletedAt" IS NOT NULL) OR
            (OLD."state" NOT IN ('draft_ready', 'partially_decided', 'decided') AND
             NEW."state" IN ('draft_ready', 'partially_decided', 'decided'));
    ELSE
        first_completion := NEW."analysisCompletedAt" IS NOT NULL;
    END IF;
    IF NEW."analysisCompletedAt" IS NOT NULL AND
       NEW."analysisCompletedAt" > db_now THEN
        RAISE EXCEPTION 'analysis completion cannot be in the future'
            USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaAnalysisChunk_completion_future_check';
    END IF;
    IF first_completion THEN
        SELECT "analysisDeadlineAt" INTO deadline_at
          FROM public."AmuxIdeaSubmission" WHERE "id" = NEW."ideaId";
        IF deadline_at IS NULL OR db_now >= deadline_at OR
           NEW."analysisCompletedAt" >= deadline_at THEN
            RAISE EXCEPTION 'analysis completion is past the idea deadline'
                USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaAnalysisChunk_completion_deadline_check';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

COMMIT;
