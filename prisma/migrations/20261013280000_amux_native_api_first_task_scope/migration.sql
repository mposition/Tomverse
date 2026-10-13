-- Policy v40 authorizes native API settlement only for the approved FIRST
-- recovery Task. The existing Codex, Claude CLI and API provenance clauses
-- are unchanged; this adds the narrow API-only identity and budget guard.
BEGIN;

ALTER TABLE "AmuxCliUsageEvent"
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
    ("pricingVersion" IS NULL OR "projectedApiCostMicrousd" IS NOT NULL) AND
    ("cli" <> 'anthropic_api' OR (
      "bindingKind" = 'task_attempt' AND
      "taskId" = 'c48886b9-86f8-4631-8db8-c0b288a707af' AND
      "status" IN ('succeeded','failed') AND
      "actualModelId" = "selectedModelId" AND
      "completedTurns" BETWEEN 1 AND 8 AND
      "projectedApiCostMicrousd" IS NOT NULL AND
      "projectedApiCostMicrousd" BETWEEN 0 AND 3400000 AND
      "pricingVersion" IS NOT NULL AND
      "actualApiCostMicrousd" IS NULL)));

COMMIT;
