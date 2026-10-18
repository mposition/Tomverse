-- Candidate-authored bundle bytes are separate from the content-free ledger.
-- This table grants no public-source, evaluation, promotion or runtime authority.
CREATE TABLE "ChatUnifiedOptimizerCandidatePayload" (
  "candidateId" UUID NOT NULL,
  "bundleDigest" TEXT NOT NULL,
  "bodySha256" TEXT NOT NULL,
  "bundleJson" TEXT NOT NULL,
  "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ChatUnifiedOptimizerCandidatePayload_pkey"
    PRIMARY KEY ("candidateId"),
  CONSTRAINT "ChatUnifiedOptimizerCandidatePayload_closed_check" CHECK (
    "bundleDigest" ~ '^[0-9a-f]{64}$'
    AND "bodySha256" ~ '^[0-9a-f]{64}$'
    AND octet_length("bundleJson") BETWEEN 1 AND 262144
    AND "bodySha256" = encode(sha256(convert_to("bundleJson", 'UTF8')), 'hex')
  ),
  CONSTRAINT "ChatUnifiedOptimizerCandidatePayload_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "ChatUnifiedOptimizerCandidate"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE FUNCTION "chat_unified_optimizer_candidate_payload_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  candidate_bundle_digest TEXT;
BEGIN
  SELECT "bundleDigest" INTO candidate_bundle_digest
  FROM "ChatUnifiedOptimizerCandidate" WHERE "id" = NEW."candidateId";
  IF candidate_bundle_digest IS NULL OR
      candidate_bundle_digest <> NEW."bundleDigest" THEN
    RAISE EXCEPTION 'chat_unified_optimizer_candidate_payload_mismatch'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChatUnifiedOptimizerCandidatePayload_guard"
BEFORE INSERT ON "ChatUnifiedOptimizerCandidatePayload"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_candidate_payload_guard"();
CREATE TRIGGER "ChatUnifiedOptimizerCandidatePayload_immutable"
BEFORE UPDATE OR DELETE ON "ChatUnifiedOptimizerCandidatePayload"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_immutable"();
CREATE TRIGGER "ChatUnifiedOptimizerCandidatePayload_no_truncate"
BEFORE TRUNCATE ON "ChatUnifiedOptimizerCandidatePayload"
FOR EACH STATEMENT EXECUTE FUNCTION "chat_unified_optimizer_immutable"();
