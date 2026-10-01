-- A non-content client request nonce makes a lost submission response
-- readable without blindly repeating a write. The server still creates the
-- idea id. The phase-A table has no writer, so no existing live rows exist.

BEGIN;

ALTER TABLE "AmuxIdeaSubmission"
  ADD COLUMN "requestId" UUID NOT NULL;

CREATE UNIQUE INDEX "AmuxIdeaSubmission_requestId_key"
  ON "AmuxIdeaSubmission"("requestId");

ALTER TABLE "AmuxIdeaSubmission"
  ADD CONSTRAINT "AmuxIdeaSubmission_completion_before_deadline_check"
  CHECK ("analysisCompletedAt" IS NULL OR "analysisCompletedAt" < "analysisDeadlineAt"),
  ADD CONSTRAINT "AmuxIdeaSubmission_raw_purge_bound_check"
  CHECK (
    "rawCiphertext" IS NULL OR (
      "rawPurgeAfter" IS NOT NULL AND
      "rawPurgeAfter" <= LEAST(
        "analysisDeadlineAt",
        COALESCE("analysisCompletedAt", "analysisDeadlineAt"),
        COALESCE("cancelledAt", "analysisDeadlineAt")
      )
    )
  );

CREATE FUNCTION "amux_v4_idea_identity_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id" OR
     NEW."requestId" IS DISTINCT FROM OLD."requestId" OR
     NEW."actorUserId" IS DISTINCT FROM OLD."actorUserId" OR
     NEW."submittedAt" IS DISTINCT FROM OLD."submittedAt" OR
     NEW."analysisDeadlineAt" IS DISTINCT FROM OLD."analysisDeadlineAt" THEN
    RAISE EXCEPTION 'AMUX v4 idea identity and submission clock are immutable'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSubmission_identity_immutable_check';
  END IF;
  IF OLD."rawPurgeAfter" IS NOT NULL AND NEW."rawCiphertext" IS NOT NULL AND
     (NEW."rawPurgeAfter" IS NULL OR NEW."rawPurgeAfter" > OLD."rawPurgeAfter") THEN
    RAISE EXCEPTION 'AMUX v4 raw purge eligibility cannot be postponed'
      USING ERRCODE = '23514', CONSTRAINT = 'AmuxIdeaSubmission_raw_purge_monotonic_check';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AmuxIdeaSubmission_identity_guard"
  BEFORE UPDATE ON "AmuxIdeaSubmission"
  FOR EACH ROW EXECUTE FUNCTION "amux_v4_idea_identity_guard"();

COMMIT;
