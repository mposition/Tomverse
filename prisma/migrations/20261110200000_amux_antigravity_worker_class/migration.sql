-- Owner decision 2026-11-10: Google's Antigravity CLI (agy, Gemini 4 on the
-- owner's Google AI Pro sign-in) is a fifth worker class. It is unverified,
-- reaches implementation like Copilot, and may take v22 implement: its shell
-- is found on PATH, so the sidecar's jail holds it (measured on agy 1.5.4).
-- Each change below is the latest definition with only `antigravity` added:
-- * the registry's provider classes and the CLI model tables' CLIs;
-- * the CLI usage ledger's CLI/provider pair and its token semantics, as
--   measured: input excludes cache reads (one step reported more cache
--   reads than input), and whether output includes thinking is not known.
-- The capability guard needs no change: only Claude's model and Cursor's
-- implement are held by class there.
BEGIN;

ALTER TABLE "AmuxWorkerRegistryEvent"
  DROP CONSTRAINT "AmuxWorkerRegistryEvent_provider_class_check",
  ADD CONSTRAINT "AmuxWorkerRegistryEvent_provider_class_check"
      CHECK ("providerClass" IN ('claude', 'codex', 'cursor', 'copilot', 'antigravity'));

ALTER TABLE "AmuxCliModel"
  DROP CONSTRAINT "AmuxCliModel_cli_check",
  ADD CONSTRAINT "AmuxCliModel_cli_check"
      CHECK ("cli" IN ('claude', 'codex', 'cursor', 'copilot', 'antigravity'));

ALTER TABLE "AmuxCliModelLinkEvent"
  DROP CONSTRAINT "AmuxCliModelLinkEvent_cli_check",
  ADD CONSTRAINT "AmuxCliModelLinkEvent_cli_check"
      CHECK ("cli" IN ('claude', 'codex', 'cursor', 'copilot', 'antigravity'));

ALTER TABLE "AmuxCliUsageEvent"
  DROP CONSTRAINT "AmuxCliUsageEvent_source_check",
  ADD CONSTRAINT "AmuxCliUsageEvent_source_check" CHECK (
    ("cli" = 'codex' AND "provider" = 'openai') OR
    ("cli" = 'claude' AND "provider" = 'anthropic') OR
    ("cli" = 'copilot' AND "provider" = 'github-copilot') OR
    ("cli" = 'cursor' AND "provider" = 'cursor') OR
    ("cli" = 'antigravity' AND "provider" = 'antigravity') OR
    ("cli" = 'anthropic_api' AND "provider" = 'anthropic')),
  DROP CONSTRAINT "AmuxCliUsageEvent_shape_check",
  ADD CONSTRAINT "AmuxCliUsageEvent_shape_check" CHECK (
    "status" IN ('succeeded','failed','interrupted','outcome_unknown') AND
    "authentication" IN ('subscription','api_key','unknown') AND
    "completeness" IN ('reported_complete','reported_partial','unknown') AND
    "endedAt" >= "startedAt" AND "completedTurns" BETWEEN 0 AND 10000 AND
    ("completeness" <> 'reported_complete' OR "completedTurns" > 0) AND
    (("cli" = 'codex' AND "inputTokensIncludeCacheRead" AND
       "reasoningOutputIncludedInOutput" IS TRUE)
      OR ("cli" = 'claude' AND NOT "inputTokensIncludeCacheRead" AND
        "inputTokensIncludeCacheWrite" IS FALSE)
      OR ("cli" = 'copilot' AND "inputTokensIncludeCacheRead" AND
        "reasoningOutputIncludedInOutput" IS NULL)
      OR ("cli" = 'cursor' AND NOT "inputTokensIncludeCacheRead" AND
        "reasoningOutputIncludedInOutput" IS NULL)
      OR ("cli" = 'antigravity' AND NOT "inputTokensIncludeCacheRead" AND
        "reasoningOutputIncludedInOutput" IS NULL)
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
          ("cli" = 'copilot' AND "source" = 'copilot_json') OR
          ("cli" = 'cursor' AND "source" = 'cursor_stream') OR
          ("cli" = 'antigravity' AND "source" = 'antigravity_stream') OR
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
      "actualApiCostMicrousd" IS NULL)) AND
    ("cliFailure" IS NULL OR ("cli" = 'claude' AND "status" = 'failed')));

COMMIT;
