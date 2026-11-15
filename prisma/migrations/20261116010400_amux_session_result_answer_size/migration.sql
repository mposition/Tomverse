-- Owner direction 2026-11-15: an AMUX session analysis answer is no longer
-- refused for its size. The app admits one answer up to 4 MiB
-- (AMUX_INTAKE_SAFETY_MAX_BYTES, lib/amux/intakeLimitsCore.ts: no model returns
-- more than about 0.5 MiB of text in one answer), so the sealed result may be
-- up to 4,194,304 bytes plus the seal's header, IVs, tags and wrapped key
-- (well under 4,096 bytes). Only the ciphertext bound changes; every other
-- condition of the shape CHECK is kept exactly. No row is updated or deleted.
ALTER TABLE "AmuxIdeaSessionAnalysisResult"
  DROP CONSTRAINT "AmuxIdeaSessionAnalysisResult_shape_check",
  ADD CONSTRAINT "AmuxIdeaSessionAnalysisResult_shape_check" CHECK (
    "referenceOrdinal" >= 0 AND "inputTokens" >= 0 AND
    "outputTokens" >= 0 AND
    "inputTokens"::bigint + "outputTokens"::bigint > 0 AND
    "digest" ~ '^[a-f0-9]{64}$' AND
    "digestKeyId" ~ '^[A-Za-z0-9_-]{1,64}$' AND
    (("ciphertext" IS NOT NULL AND
      octet_length("ciphertext") BETWEEN 1 AND 4198400 AND
      "keyId" ~ '^[A-Za-z0-9_-]{1,64}$' AND "keyVersion" > 0 AND
      "bodyPurgedAt" IS NULL) OR
     ("ciphertext" IS NULL AND "keyId" IS NULL AND
      "keyVersion" IS NULL AND "bodyPurgedAt" IS NOT NULL))
  );
