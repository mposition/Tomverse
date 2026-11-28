-- Owner request 2026-11-28: Moonshot's Kimi Code CLI (kimi, on the owner's
-- Kimi Code sign-in) is a sixth worker class. It is unverified at
-- implementation like Cursor and takes v22 read roles only: --print approves
-- every tool call, its file tools read any absolute path and its Shell runs
-- unsandboxed, so no jail holds it once it may write.
-- Each change below is the latest definition (20261110200000) with only
-- `kimi` added:
-- * the registry's provider classes and the CLI model tables' CLIs;
-- * the CLI usage ledger's CLI/provider pair, its source `kimi_wire` (the
--   session wire.jsonl's StatusUpdate token_usage; the stream reports none)
--   and its token semantics as documented for the wire protocol: input_other
--   excludes input_cache_read, and whether output includes thinking is not
--   documented.
-- The capability guard needs no change: only Claude's model and Cursor's
-- implement are held by class there, and the v22 provider table keeps Kimi
-- from implement.
BEGIN;

ALTER TABLE "AmuxWorkerRegistryEvent"
  DROP CONSTRAINT "AmuxWorkerRegistryEvent_provider_class_check",
  ADD CONSTRAINT "AmuxWorkerRegistryEvent_provider_class_check"
      CHECK ("providerClass" IN ('claude', 'codex', 'cursor', 'copilot', 'antigravity', 'kimi'));

ALTER TABLE "AmuxCliModel"
  DROP CONSTRAINT "AmuxCliModel_cli_check",
  ADD CONSTRAINT "AmuxCliModel_cli_check"
      CHECK ("cli" IN ('claude', 'codex', 'cursor', 'copilot', 'antigravity', 'kimi'));

ALTER TABLE "AmuxCliModelLinkEvent"
  DROP CONSTRAINT "AmuxCliModelLinkEvent_cli_check",
  ADD CONSTRAINT "AmuxCliModelLinkEvent_cli_check"
      CHECK ("cli" IN ('claude', 'codex', 'cursor', 'copilot', 'antigravity', 'kimi'));

ALTER TABLE "AmuxCliUsageEvent"
  DROP CONSTRAINT "AmuxCliUsageEvent_source_check",
  ADD CONSTRAINT "AmuxCliUsageEvent_source_check" CHECK (
    ("cli" = 'codex' AND "provider" = 'openai') OR
    ("cli" = 'claude' AND "provider" = 'anthropic') OR
    ("cli" = 'copilot' AND "provider" = 'github-copilot') OR
    ("cli" = 'cursor' AND "provider" = 'cursor') OR
    ("cli" = 'antigravity' AND "provider" = 'antigravity') OR
    ("cli" = 'kimi' AND "provider" = 'kimi') OR
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
      OR ("cli" = 'kimi' AND NOT "inputTokensIncludeCacheRead" AND
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
          ("cli" = 'kimi' AND "source" = 'kimi_wire') OR
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
