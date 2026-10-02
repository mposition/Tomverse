-- AMUX v22/v23 content-free CLI usage schema only. No writer, collector,
-- aggregate, purge job, migration apply, or runtime switch is enabled here.
-- One row per invocation avoids mutable child rows after receipt creation.
CREATE FUNCTION amux_cli_usage_models_valid(
  payload JSONB, usage_cli TEXT, usage_completeness TEXT,
  total_input BIGINT, total_output BIGINT, total_cache_read BIGINT,
  total_cache_creation BIGINT
) RETURNS BOOLEAN
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  item JSONB;
  observed JSONB;
  model_name TEXT;
  key_name TEXT;
  token_text TEXT;
  seen TEXT[] := ARRAY[]::TEXT[];
  input_sum NUMERIC := 0;
  output_sum NUMERIC := 0;
  cache_read_sum NUMERIC := 0;
  cache_creation_sum NUMERIC := 0;
BEGIN
  IF payload IS NULL OR jsonb_typeof(payload) <> 'array'
      OR jsonb_array_length(payload) > 16 THEN
    RETURN FALSE;
  END IF;
  IF usage_completeness = 'unknown' OR usage_cli = 'codex' THEN
    RETURN jsonb_array_length(payload) = 0;
  END IF;
  IF usage_cli <> 'claude' THEN RETURN FALSE; END IF;
  IF jsonb_array_length(payload) = 0 THEN
    -- A partial Claude result may report totals without per-model detail.
    RETURN usage_completeness = 'reported_partial';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(payload) LOOP
    IF jsonb_typeof(item) <> 'object' OR NOT (item ? 'modelId')
        OR NOT (item ? 'observed')
        OR (SELECT count(*) FROM jsonb_object_keys(item)) <> 2 THEN
      RETURN FALSE;
    END IF;
    model_name := item ->> 'modelId';
    IF jsonb_typeof(item -> 'modelId') <> 'string'
        OR model_name !~ '^[A-Za-z0-9._/\[\]-]{1,160}$'
        OR model_name ~ '(^/|/$|//|(^|/)\.{1,2}(/|$))'
        OR model_name = ANY(seen) THEN
      RETURN FALSE;
    END IF;
    seen := array_append(seen, model_name);
    observed := item -> 'observed';
    IF jsonb_typeof(observed) <> 'object'
        OR NOT (observed ? 'inputTokens') OR NOT (observed ? 'outputTokens')
        OR NOT (observed ? 'cacheReadInputTokens')
        OR NOT (observed ? 'cacheCreationInputTokens')
        OR NOT (observed ? 'reasoningOutputTokens')
        OR (SELECT count(*) FROM jsonb_object_keys(observed)) <> 5
        OR observed -> 'reasoningOutputTokens' <> 'null'::JSONB THEN
      RETURN FALSE;
    END IF;
    FOREACH key_name IN ARRAY ARRAY['inputTokens', 'outputTokens',
        'cacheReadInputTokens', 'cacheCreationInputTokens'] LOOP
      token_text := observed ->> key_name;
      IF jsonb_typeof(observed -> key_name) <> 'number'
          OR token_text !~ '^(0|[1-9][0-9]{0,15})$'
          OR token_text::NUMERIC > 9007199254740991 THEN
        RETURN FALSE;
      END IF;
    END LOOP;
    input_sum := input_sum + (observed ->> 'inputTokens')::NUMERIC;
    output_sum := output_sum + (observed ->> 'outputTokens')::NUMERIC;
    cache_read_sum := cache_read_sum + (observed ->> 'cacheReadInputTokens')::NUMERIC;
    cache_creation_sum := cache_creation_sum + (observed ->> 'cacheCreationInputTokens')::NUMERIC;
  END LOOP;
  RETURN input_sum = total_input AND output_sum = total_output
    AND cache_read_sum = total_cache_read
    AND cache_creation_sum = total_cache_creation;
END;
$$;

CREATE TABLE "AmuxCliUsageInvocation" (
  "invocationId" UUID NOT NULL,
  "contextKind" TEXT NOT NULL,
  "cardId" VARCHAR(160),
  "taskId" VARCHAR(160),
  "runId" VARCHAR(160),
  "attemptId" VARCHAR(160),
  "workerId" VARCHAR(160),
  "ideaId" VARCHAR(160),
  "chunkIndex" INTEGER,
  "agentId" VARCHAR(32),
  "cli" TEXT NOT NULL,
  "cliVersion" VARCHAR(64) NOT NULL,
  "authKind" TEXT NOT NULL,
  "selectedModelId" VARCHAR(160) NOT NULL,
  "startedAt" TIMESTAMPTZ(3) NOT NULL,
  "endedAt" TIMESTAMPTZ(3) NOT NULL,
  "status" TEXT NOT NULL,
  "completeness" TEXT NOT NULL,
  "completedTurns" INTEGER NOT NULL,
  "inputTokens" BIGINT,
  "outputTokens" BIGINT,
  "cacheReadInputTokens" BIGINT,
  "cacheCreationInputTokens" BIGINT,
  "reasoningOutputTokens" BIGINT,
  "inputTokensIncludeCacheRead" BOOLEAN,
  "inputTokensIncludeCacheWrite" BOOLEAN,
  "reasoningOutputIncludedInOutput" BOOLEAN,
  "modelsJson" JSONB NOT NULL,
  "receiptDigest" CHAR(64) NOT NULL,
  "recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "AmuxCliUsageInvocation_pkey" PRIMARY KEY ("invocationId"),
  CONSTRAINT "AmuxCliUsageInvocation_context_check" CHECK (
    ("contextKind" = 'worker' AND "cardId" IS NOT NULL AND "taskId" IS NOT NULL
      AND "runId" IS NOT NULL AND "attemptId" IS NOT NULL AND "workerId" IS NOT NULL
      AND "ideaId" IS NULL AND "chunkIndex" IS NULL AND "agentId" IS NULL)
    OR
    ("contextKind" = 'idea_analysis' AND "cardId" IS NULL AND "taskId" IS NULL
      AND "runId" IS NULL AND "attemptId" IS NULL AND "workerId" IS NULL
      AND "ideaId" IS NOT NULL AND "chunkIndex" IS NOT NULL AND "chunkIndex" >= 0
      AND "agentId" = 'amux-intake')
  ),
  CONSTRAINT "AmuxCliUsageInvocation_identifiers_check" CHECK (
    ("cardId" IS NULL OR "cardId" ~ '^[A-Za-z0-9:_-]{1,160}$')
    AND ("taskId" IS NULL OR "taskId" ~ '^[A-Za-z0-9:_-]{1,160}$')
    AND ("runId" IS NULL OR "runId" ~ '^[A-Za-z0-9:_-]{1,160}$')
    AND ("attemptId" IS NULL OR "attemptId" ~ '^[A-Za-z0-9:_-]{1,160}$')
    AND ("workerId" IS NULL OR "workerId" ~ '^[A-Za-z0-9:_-]{1,160}$')
    AND ("ideaId" IS NULL OR "ideaId" ~ '^[A-Za-z0-9:_-]{1,160}$')
    AND ("agentId" IS NULL OR "agentId" = 'amux-intake')
    AND "cliVersion" ~ '^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$'
    AND "selectedModelId" ~ '^[A-Za-z0-9._/\[\]-]{1,160}$'
    AND "selectedModelId" !~ '(^/|/$|//|(^|/)\.{1,2}(/|$))'
  ),
  CONSTRAINT "AmuxCliUsageInvocation_cli_check" CHECK ("cli" IN ('codex', 'claude')),
  CONSTRAINT "AmuxCliUsageInvocation_authKind_check" CHECK ("authKind" IN ('subscription', 'api_key')),
  CONSTRAINT "AmuxCliUsageInvocation_status_check" CHECK ("status" IN ('succeeded', 'failed', 'timeout', 'outcome_unknown')),
  CONSTRAINT "AmuxCliUsageInvocation_completeness_check" CHECK ("completeness" IN ('reported_complete', 'reported_partial', 'unknown')),
  CONSTRAINT "AmuxCliUsageInvocation_clock_check" CHECK (
    "endedAt" >= "startedAt" AND "completedTurns" BETWEEN 0 AND 128
      AND ("completeness" <> 'reported_complete' OR "status" = 'succeeded')
      AND ("completeness" <> 'reported_complete' OR "completedTurns" > 0)
      AND ("cli" <> 'codex' OR "completeness" = 'unknown' OR "completedTurns" = 1)
      AND ("cli" <> 'claude' OR "completeness" <> 'unknown' OR "completedTurns" = 0)
  ),
  CONSTRAINT "AmuxCliUsageInvocation_digest_check" CHECK (
    "receiptDigest" ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT "AmuxCliUsageInvocation_counts_check" CHECK (
    ("inputTokens" IS NULL OR "inputTokens" BETWEEN 0 AND 9007199254740991)
    AND ("outputTokens" IS NULL OR "outputTokens" BETWEEN 0 AND 9007199254740991)
    AND ("cacheReadInputTokens" IS NULL OR "cacheReadInputTokens" BETWEEN 0 AND 9007199254740991)
    AND ("cacheCreationInputTokens" IS NULL OR "cacheCreationInputTokens" BETWEEN 0 AND 9007199254740991)
    AND ("reasoningOutputTokens" IS NULL OR "reasoningOutputTokens" BETWEEN 0 AND 9007199254740991)
    AND (("completeness" = 'unknown' AND "inputTokens" IS NULL
      AND "outputTokens" IS NULL AND "cacheReadInputTokens" IS NULL
      AND "cacheCreationInputTokens" IS NULL AND "reasoningOutputTokens" IS NULL)
      OR ("completeness" <> 'unknown' AND "inputTokens" IS NOT NULL
        AND "outputTokens" IS NOT NULL AND "cacheReadInputTokens" IS NOT NULL))
  ),
  CONSTRAINT "AmuxCliUsageInvocation_cli_shape_check" CHECK (
    ("cli" = 'codex' AND "cacheCreationInputTokens" IS NULL
      AND "inputTokensIncludeCacheRead" IS TRUE
      AND "inputTokensIncludeCacheWrite" IS NULL
      AND "reasoningOutputIncludedInOutput" IS TRUE)
    OR
    ("cli" = 'claude' AND "reasoningOutputTokens" IS NULL
      AND "inputTokensIncludeCacheRead" IS FALSE
      AND "inputTokensIncludeCacheWrite" IS FALSE
      AND "reasoningOutputIncludedInOutput" IS NULL
      AND ("completeness" = 'unknown' OR "cacheCreationInputTokens" IS NOT NULL))
  ),
  CONSTRAINT "AmuxCliUsageInvocation_models_check" CHECK (
    amux_cli_usage_models_valid("modelsJson", "cli", "completeness",
      "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens")
  )
);

CREATE INDEX "AmuxCliUsageInvocation_recordedAt_invocationId_idx"
  ON "AmuxCliUsageInvocation"("recordedAt", "invocationId");
CREATE INDEX "AmuxCliUsageInvocation_contextKind_attemptId_idx"
  ON "AmuxCliUsageInvocation"("contextKind", "attemptId");
CREATE INDEX "AmuxCliUsageInvocation_contextKind_ideaId_chunkIndex_idx"
  ON "AmuxCliUsageInvocation"("contextKind", "ideaId", "chunkIndex");

-- The database, not a caller's JSON or application clock, starts retention.
CREATE FUNCTION amux_cli_usage_set_recorded_at() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW."recordedAt" := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxCliUsageInvocation_set_recordedAt"
  BEFORE INSERT ON "AmuxCliUsageInvocation"
  FOR EACH ROW EXECUTE FUNCTION amux_cli_usage_set_recorded_at();

-- A receipt can be inserted once or deleted by the future retention path.
CREATE FUNCTION amux_cli_usage_refuse_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'AMUX CLI usage receipt is immutable' USING ERRCODE = 'AX001';
END;
$$;
CREATE TRIGGER "AmuxCliUsageInvocation_refuse_update"
  BEFORE UPDATE ON "AmuxCliUsageInvocation"
  FOR EACH ROW EXECUTE FUNCTION amux_cli_usage_refuse_update();
