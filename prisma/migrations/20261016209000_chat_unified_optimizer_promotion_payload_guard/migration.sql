-- A prepared pointer cannot reference a candidate whose proposal bytes are
-- absent. This is a data-completeness guard, not runtime authorization.
CREATE FUNCTION "chat_unified_optimizer_promotion_payload_guard"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "ChatUnifiedOptimizerCandidatePayload" p
    JOIN "ChatUnifiedOptimizerCandidate" c
      ON c."id" = p."candidateId"
    WHERE p."candidateId" = NEW."candidateId"
      AND c."cycleId" = NEW."cycleId"
      AND c."candidateDigest" = NEW."candidateDigest"
      AND c."bundleDigest" = NEW."candidateBundleDigest"
      AND p."bundleDigest" = NEW."candidateBundleDigest"
      AND p."bodySha256" =
        encode(sha256(convert_to(p."bundleJson", 'UTF8')), 'hex')
  ) THEN
    RAISE EXCEPTION 'chat_unified_optimizer_promotion_payload_refused'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "ChatUnifiedOptimizerPromotionReceipt_payload_guard"
BEFORE INSERT ON "ChatUnifiedOptimizerPromotionReceipt"
FOR EACH ROW EXECUTE FUNCTION "chat_unified_optimizer_promotion_payload_guard"();
