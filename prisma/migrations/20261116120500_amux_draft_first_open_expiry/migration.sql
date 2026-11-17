-- baseline-check: replace-function-if-body-sha256 "amux_v4_draft_first_expiry_guard" "212acdd46278f76f9b422b03cd6e6919a115fe45c0b7e27d5f767599bc3d0cd2" "89568e8cc44db32dfb57921f0ece2f235a8f11721adbd74cfacefb51ade1a931"
-- Operator, 2026-11-16: an undecided draft no longer expires 30 days after
-- the idea's first completed analysis (and is no longer deleted a day later).
-- Like the analysis deadline of 2026-11-15, the column stays and a new draft
-- unit's clock is set 36,500 days after that first completion, so every
-- reader keeps one rule. The clock is still the FIRST completed chunk's, never
-- a later page's. The function body is the 20261005100000 one with only the
-- interval changed; its trigger (BEFORE INSERT) is unchanged.
BEGIN;

CREATE OR REPLACE FUNCTION amux_v4_draft_first_expiry_guard()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE first_completed timestamp(3);
BEGIN
  SELECT "analysisCompletedAt" INTO first_completed FROM public."AmuxIdeaAnalysisChunk"
   WHERE "ideaId" = NEW."ideaId" AND "chunkIndex" = 0 FOR SHARE;
  IF first_completed IS NULL OR
     (clock_timestamp() AT TIME ZONE 'UTC') >= first_completed + INTERVAL '36500 days' THEN
    RAISE EXCEPTION 'first analysis clock expired or missing'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaDraftUnit_first_expiry_check';
  END IF;
  NEW."expiresAt" := first_completed + INTERVAL '36500 days';
  RETURN NEW;
END;
$$;

COMMIT;
