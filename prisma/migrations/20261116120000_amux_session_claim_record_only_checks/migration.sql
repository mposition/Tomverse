-- Operator, 2026-11-16 (AMUX idea analysis has no artificial stops):
-- * A subscription (max_shadow) claim reserves nothing of the monthly window;
--   its shadow estimate is a record, never a stop. Only that mode may carry a
--   zero reservation; a bounded (paid API) claim keeps reserving its ceiling.
-- * A subscription result whose CLI reported no tokens is still a result: a
--   max_shadow claim may settle succeeded or failed at zero with zero tokens,
--   and its result row may record zero tokens. A paid claim is unchanged.
-- * A retention hold may run as long as the owner sets it, up to the
--   36,500-day horizon every open AMUX clock uses, instead of 90 days; its
--   notice stays seven days before it ends.
-- Every other condition of the three CHECKs is kept exactly. No row is
-- updated or deleted: existing rows all satisfy the wider conditions.
ALTER TABLE "AmuxIdeaSessionAnalysisBudgetClaim"
  DROP CONSTRAINT "AmuxIdeaSessionAnalysisBudgetClaim_values_check",
  ADD CONSTRAINT "AmuxIdeaSessionAnalysisBudgetClaim_values_check" CHECK (
    "inputTokensCap" > 0 AND "outputTokensCap" > 0 AND
    "invocationOrdinal" >= 0 AND
    "inputMicroUsdPerMillion" > 0 AND "outputMicroUsdPerMillion" > 0 AND
    ("reservedMicroUsd" > 0 OR
     ("budgetMode" = 'max_shadow' AND "reservedMicroUsd" = 0)) AND
    "budgetMode" IN ('bounded', 'max_shadow') AND
    "provider" IN ('openai', 'anthropic', 'github-copilot', 'cursor') AND
    "modelId" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$' AND
    (("status" = 'in_flight' AND "closedAt" IS NULL AND
      "settledMicroUsd" IS NULL AND "inputTokens" IS NULL AND
      "outputTokens" IS NULL AND "resolutionAuditLogId" IS NULL) OR
     ("status" = 'outcome_unknown' AND "closedAt" IS NULL AND
      "settledMicroUsd" IS NULL AND "inputTokens" IS NULL AND
      "outputTokens" IS NULL AND "resolutionAuditLogId" IS NOT NULL) OR
     ("status" IN ('succeeded', 'failed', 'owner_consumed', 'released') AND
      "closedAt" IS NOT NULL AND "closedAt" >= "createdAt" AND
      "settledMicroUsd" >= 0 AND
      ("settledMicroUsd" <= "reservedMicroUsd" OR
       ("budgetMode" = 'max_shadow' AND "status" IN ('succeeded', 'failed'))) AND
      "resolutionAuditLogId" IS NOT NULL AND
      (("status" IN ('succeeded', 'failed') AND
        "inputTokens" >= 0 AND "outputTokens" >= 0 AND
        (("settledMicroUsd" > 0 AND "inputTokens" + "outputTokens" > 0) OR
         ("budgetMode" = 'max_shadow' AND "settledMicroUsd" = 0 AND
          "inputTokens" + "outputTokens" = 0))) OR
       ("status" = 'owner_consumed' AND
        ("settledMicroUsd" = "reservedMicroUsd" OR
         ("budgetMode" = 'max_shadow' AND "settledMicroUsd" = 0)) AND
        "inputTokens" IS NULL AND "outputTokens" IS NULL) OR
       ("status" = 'released' AND "settledMicroUsd" = 0 AND
        "inputTokens" IS NULL AND "outputTokens" IS NULL))))
  );

ALTER TABLE "AmuxIdeaSessionAnalysisResult"
  DROP CONSTRAINT "AmuxIdeaSessionAnalysisResult_shape_check",
  ADD CONSTRAINT "AmuxIdeaSessionAnalysisResult_shape_check" CHECK (
    "referenceOrdinal" >= 0 AND "inputTokens" >= 0 AND
    "outputTokens" >= 0 AND
    "digest" ~ '^[a-f0-9]{64}$' AND
    "digestKeyId" ~ '^[A-Za-z0-9_-]{1,64}$' AND
    (("ciphertext" IS NOT NULL AND
      octet_length("ciphertext") BETWEEN 1 AND 4198400 AND
      "keyId" ~ '^[A-Za-z0-9_-]{1,64}$' AND "keyVersion" > 0 AND
      "bodyPurgedAt" IS NULL) OR
     ("ciphertext" IS NULL AND "keyId" IS NULL AND
      "keyVersion" IS NULL AND "bodyPurgedAt" IS NOT NULL))
  );

ALTER TABLE "AmuxIdeaRetentionHold"
  DROP CONSTRAINT "AmuxIdeaRetentionHold_clock_check",
  ADD CONSTRAINT "AmuxIdeaRetentionHold_clock_check" CHECK (
    "expiresAt" > "createdAt" AND
    "expiresAt" <= "createdAt" + INTERVAL '36500 days' AND
    "noticeAt" = GREATEST("createdAt", "expiresAt" - INTERVAL '7 days')
  );
