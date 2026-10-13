-- Policy v40 requires the native Anthropic Messages API receipt to retain
-- honest provenance. Existing Codex and Claude CLI rows and branches are
-- unchanged; this adds one complete, API-key-only settlement-writer shape.
BEGIN;

ALTER TABLE "AmuxCliUsageEvent"
  DROP CONSTRAINT "AmuxCliUsageEvent_source_check",
  ADD CONSTRAINT "AmuxCliUsageEvent_source_check" CHECK (
    ("cli" = 'codex' AND "provider" = 'openai') OR
    ("cli" = 'claude' AND "provider" = 'anthropic') OR
    ("cli" = 'anthropic_api' AND "provider" = 'anthropic')),
  DROP CONSTRAINT "AmuxCliUsageEvent_shape_check",
  ADD CONSTRAINT "AmuxCliUsageEvent_shape_check" CHECK (
    "status" IN ('succeeded','failed','interrupted','outcome_unknown') AND
    "authentication" IN ('subscription','api_key','unknown') AND
    "completeness" IN ('reported_complete','reported_partial','unknown') AND
    "endedAt" >= "startedAt" AND "completedTurns" BETWEEN 0 AND 128 AND
    ("completeness" <> 'reported_complete' OR "completedTurns" > 0) AND
    (("cli" = 'codex' AND "inputTokensIncludeCacheRead" AND
       "reasoningOutputIncludedInOutput" IS TRUE)
      OR ("cli" = 'claude' AND NOT "inputTokensIncludeCacheRead" AND
        "inputTokensIncludeCacheWrite" IS FALSE)
      OR ("cli" = 'anthropic_api' AND "authentication" = 'api_key' AND
        "completeness" = 'reported_complete' AND "cliVersion" IS NULL AND
        NOT "inputTokensIncludeCacheRead" AND
        "inputTokensIncludeCacheWrite" IS FALSE AND
        "reasoningOutputIncludedInOutput" IS NULL AND
        "actualModelId" IS NOT NULL AND
        "cacheCreationInputTokens" IS NOT NULL AND
        "reasoningOutputTokens" IS NULL)) AND
    ("actualModelId" IS NULL OR length("actualModelId") BETWEEN 1 AND 160) AND
    (("completeness" = 'unknown' AND "source" = 'unreported' AND
       "inputTokens" IS NULL AND "outputTokens" IS NULL AND
       "cacheReadInputTokens" IS NULL AND "cacheCreationInputTokens" IS NULL AND
       "reasoningOutputTokens" IS NULL)
      OR ("completeness" <> 'unknown' AND
        (("cli" = 'codex' AND "source" = 'codex_jsonl') OR
          ("cli" = 'claude' AND "source" = 'claude_result') OR
          ("cli" = 'anthropic_api' AND
            "source" = 'anthropic_messages_api')) AND
        "inputTokens" IS NOT NULL AND "outputTokens" IS NOT NULL AND
        "cacheReadInputTokens" IS NOT NULL AND
        ("inputTokens" > 0 OR "outputTokens" > 0 OR
          "cacheReadInputTokens" > 0 OR "cacheCreationInputTokens" > 0))) AND
    ("inputTokens" IS NULL OR "inputTokens" >= 0) AND
    ("outputTokens" IS NULL OR "outputTokens" >= 0) AND
    ("cacheReadInputTokens" IS NULL OR "cacheReadInputTokens" >= 0) AND
    ("cacheCreationInputTokens" IS NULL OR "cacheCreationInputTokens" >= 0) AND
    ("reasoningOutputTokens" IS NULL OR "reasoningOutputTokens" >= 0) AND
    ("projectedApiCostMicrousd" IS NULL OR
      ("projectedApiCostMicrousd" >= 0 AND "pricingVersion" IS NOT NULL)) AND
    ("actualApiCostMicrousd" IS NULL OR "actualApiCostMicrousd" >= 0) AND
    ("pricingVersion" IS NULL OR "projectedApiCostMicrousd" IS NOT NULL));

COMMIT;
