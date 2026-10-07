-- Per-CLI-invocation, content-free observation. No existing usage or credit
-- tables are altered, and this migration does not enable execution.
CREATE TABLE "AmuxCliUsageEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "invocationId" TEXT NOT NULL,
  "receiptDigest" TEXT NOT NULL,
  "bindingKind" TEXT NOT NULL,
  "attemptId" TEXT,
  "analysisHoldId" TEXT,
  "taskId" TEXT,
  "worker" TEXT NOT NULL,
  "cli" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "selectedModelId" TEXT NOT NULL,
  "actualModelId" TEXT,
  "cliVersion" TEXT,
  "authentication" TEXT NOT NULL,
  "startedAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3) NOT NULL,
  "status" TEXT NOT NULL,
  "completeness" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "inputTokens" BIGINT,
  "outputTokens" BIGINT,
  "cacheReadInputTokens" BIGINT,
  "cacheCreationInputTokens" BIGINT,
  "reasoningOutputTokens" BIGINT,
  "inputTokensIncludeCacheRead" BOOLEAN NOT NULL,
  "inputTokensIncludeCacheWrite" BOOLEAN,
  "reasoningOutputIncludedInOutput" BOOLEAN,
  "completedTurns" INTEGER NOT NULL,
  "pricingVersion" TEXT,
  "projectedApiCostMicrousd" BIGINT,
  "actualApiCostMicrousd" BIGINT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retentionUntil" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxCliUsageEvent_binding_check" CHECK (
    ("bindingKind" = 'task_attempt' AND "attemptId" IS NOT NULL AND
      "analysisHoldId" IS NULL AND "taskId" IS NOT NULL)
    OR ("bindingKind" = 'idea_analysis' AND "attemptId" IS NULL AND
      "analysisHoldId" IS NOT NULL AND "taskId" IS NULL)
  ),
  CONSTRAINT "AmuxCliUsageEvent_source_check" CHECK (
    ("cli" = 'codex' AND "provider" = 'openai') OR
    ("cli" = 'claude' AND "provider" = 'anthropic')
  ),
  CONSTRAINT "AmuxCliUsageEvent_digest_check" CHECK (
    "receiptDigest" ~ '^[a-f0-9]{64}$' AND
    ("invocationId" ~ '^[A-Za-z0-9:_-]{1,128}$')
  ),
  CONSTRAINT "AmuxCliUsageEvent_shape_check" CHECK (
    "status" IN ('succeeded','failed','interrupted','outcome_unknown') AND
    "authentication" IN ('subscription','api_key','unknown') AND
    "completeness" IN ('reported_complete','reported_partial','unknown') AND
    "endedAt" >= "startedAt" AND "completedTurns" BETWEEN 0 AND 128 AND
    ("completeness" <> 'reported_complete' OR "completedTurns" > 0) AND
    (("cli" = 'codex' AND "inputTokensIncludeCacheRead" AND
       "reasoningOutputIncludedInOutput" IS TRUE)
      OR ("cli" = 'claude' AND NOT "inputTokensIncludeCacheRead" AND
        "inputTokensIncludeCacheWrite" IS FALSE)) AND
    ("actualModelId" IS NULL OR length("actualModelId") BETWEEN 1 AND 160) AND
    (("completeness" = 'unknown' AND "source" = 'unreported' AND
       "inputTokens" IS NULL AND "outputTokens" IS NULL AND
       "cacheReadInputTokens" IS NULL AND "cacheCreationInputTokens" IS NULL AND
       "reasoningOutputTokens" IS NULL)
      OR ("completeness" <> 'unknown' AND
        (("cli" = 'codex' AND "source" = 'codex_jsonl') OR
          ("cli" = 'claude' AND "source" = 'claude_result')) AND
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
    ("pricingVersion" IS NULL OR "projectedApiCostMicrousd" IS NOT NULL)
  ),
  CONSTRAINT "AmuxCliUsageEvent_attemptId_fkey" FOREIGN KEY ("attemptId")
    REFERENCES "AmuxExecutionAttempt"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxCliUsageEvent_analysisHoldId_fkey" FOREIGN KEY ("analysisHoldId")
    REFERENCES "AmuxIdeaAnalysisBudgetHold"("id") ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "AmuxCliUsageEvent_invocationId_key" ON "AmuxCliUsageEvent"("invocationId");
CREATE INDEX "AmuxCliUsageEvent_taskId_createdAt_idx" ON "AmuxCliUsageEvent"("taskId","createdAt");
CREATE INDEX "AmuxCliUsageEvent_worker_createdAt_idx" ON "AmuxCliUsageEvent"("worker","createdAt");
CREATE INDEX "AmuxCliUsageEvent_actualModelId_createdAt_idx" ON "AmuxCliUsageEvent"("actualModelId","createdAt");
CREATE INDEX "AmuxCliUsageEvent_retentionUntil_idx" ON "AmuxCliUsageEvent"("retentionUntil");

CREATE FUNCTION "amux_cli_usage_event_guard"() RETURNS trigger AS $$
DECLARE bound_task TEXT;
DECLARE bound_worker TEXT;
DECLARE bound_source TEXT;
DECLARE bound_assignment_worker TEXT;
DECLARE bound_assignment_provider TEXT;
DECLARE bound_assignment_model TEXT;
DECLARE bound_provider TEXT;
DECLARE bound_model TEXT;
DECLARE bound_dispatched TIMESTAMP(3);
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'AMUX CLI usage events are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."retentionUntil" > clock_timestamp() THEN
      RAISE EXCEPTION 'AMUX CLI usage retention has not elapsed';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."retentionUntil" <> NEW."createdAt" + interval '13 months' THEN
    RAISE EXCEPTION 'AMUX CLI usage retention must be 13 months';
  END IF;
  IF NEW."bindingKind" = 'task_attempt' THEN
    SELECT a."taskId", a."worker", w."sourceSystem", va."workerName",
      va."provider", va."modelId"
      INTO bound_task, bound_worker, bound_source,
        bound_assignment_worker, bound_assignment_provider, bound_assignment_model
    FROM "AmuxExecutionAttempt" a
    JOIN "AmuxWorkItem" w ON w."id" = a."taskId"
    LEFT JOIN "AmuxV22WorkerAssignment" va ON va."id" = w."v22AssignmentId"
    WHERE a."id" = NEW."attemptId";
    IF bound_task IS DISTINCT FROM NEW."taskId" OR
        bound_worker IS DISTINCT FROM NEW."worker" THEN
      RAISE EXCEPTION 'AMUX CLI usage attempt binding mismatch';
    END IF;
    IF bound_source = 'admin-idea-v4' AND
        (bound_assignment_worker IS DISTINCT FROM NEW."worker" OR
         bound_assignment_provider IS DISTINCT FROM NEW."provider" OR
         bound_assignment_model IS DISTINCT FROM NEW."selectedModelId") THEN
      RAISE EXCEPTION 'AMUX CLI usage v4 assignment mismatch';
    END IF;
  ELSIF NEW."bindingKind" = 'idea_analysis' THEN
    SELECT "provider", "modelId", "dispatchedAt"
      INTO bound_provider, bound_model, bound_dispatched
    FROM "AmuxIdeaAnalysisBudgetHold" WHERE "id" = NEW."analysisHoldId";
    IF bound_provider IS DISTINCT FROM NEW."provider" OR
        bound_model IS DISTINCT FROM NEW."selectedModelId" OR
        bound_dispatched IS NULL OR
        NEW."worker" <> 'amux-intake' THEN
      RAISE EXCEPTION 'AMUX CLI usage analysis binding mismatch';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AmuxCliUsageEvent_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxCliUsageEvent"
  FOR EACH ROW EXECUTE FUNCTION "amux_cli_usage_event_guard"();

CREATE FUNCTION "amux_cli_usage_event_no_truncate"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'AMUX CLI usage events cannot be truncated';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AmuxCliUsageEvent_no_truncate"
  BEFORE TRUNCATE ON "AmuxCliUsageEvent"
  FOR EACH STATEMENT EXECUTE FUNCTION "amux_cli_usage_event_no_truncate"();

-- Only non-overlapping cells of at least five calls survive raw-row expiry.
-- A closed calendar year is finalized once, before its first expired row is
-- removed, so later bounded purge passes never recompute a partial cohort.
CREATE TABLE "AmuxCliUsageAggregateCohort" (
  "cohortYear" INTEGER NOT NULL PRIMARY KEY,
  "publishedCells" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retentionUntil" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxCliUsageAggregateCohort_shape_check" CHECK (
    "cohortYear" BETWEEN 2020 AND 9999 AND "publishedCells" >= 0)
);

CREATE TABLE "AmuxCliUsageAggregate" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "cohortYear" INTEGER NOT NULL,
  "provider" TEXT NOT NULL,
  "grain" TEXT NOT NULL,
  "periodStart" DATE NOT NULL,
  "model" TEXT,
  "role" TEXT,
  "calls" INTEGER NOT NULL,
  "reportedCalls" INTEGER NOT NULL,
  "inputTokens" BIGINT NOT NULL,
  "outputTokens" BIGINT NOT NULL,
  "cacheReadInputTokens" BIGINT NOT NULL,
  "cacheCreationInputTokens" BIGINT NOT NULL,
  "projectedApiCostMicrousd" BIGINT NOT NULL,
  "projectedCalls" INTEGER NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "retentionUntil" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AmuxCliUsageAggregate_cohort_fkey" FOREIGN KEY ("cohortYear")
    REFERENCES "AmuxCliUsageAggregateCohort"("cohortYear")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxCliUsageAggregate_shape_check" CHECK (
    "provider" IN ('openai','anthropic') AND
    "grain" IN ('month_role_model','month_model','month_provider',
      'quarter_provider','year_provider') AND
    "calls" >= 5 AND "reportedCalls" BETWEEN 0 AND "calls" AND
    "projectedCalls" BETWEEN 0 AND "calls" AND
    "inputTokens" >= 0 AND "outputTokens" >= 0 AND
    "cacheReadInputTokens" >= 0 AND "cacheCreationInputTokens" >= 0 AND
    "projectedApiCostMicrousd" >= 0 AND
    EXTRACT(YEAR FROM "periodStart") = "cohortYear" AND
    (("grain" = 'month_role_model' AND "model" IS NOT NULL AND "role" IS NOT NULL)
      OR ("grain" = 'month_model' AND "model" IS NOT NULL AND "role" IS NULL)
      OR ("grain" IN ('month_provider','quarter_provider','year_provider')
        AND "model" IS NULL AND "role" IS NULL))
  )
);
CREATE INDEX "AmuxCliUsageAggregate_retentionUntil_idx"
  ON "AmuxCliUsageAggregate"("retentionUntil");
CREATE INDEX "AmuxCliUsageAggregateCohort_retentionUntil_idx"
  ON "AmuxCliUsageAggregateCohort"("retentionUntil");

CREATE FUNCTION "amux_cli_usage_aggregate_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'AMUX CLI aggregate is immutable'; END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."retentionUntil" > clock_timestamp() THEN
      RAISE EXCEPTION 'AMUX CLI aggregate retention has not elapsed';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."retentionUntil" <> NEW."createdAt" + interval '36 months' THEN
    RAISE EXCEPTION 'AMUX CLI aggregate retention must be 36 months';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "AmuxCliUsageAggregate_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxCliUsageAggregate"
  FOR EACH ROW EXECUTE FUNCTION "amux_cli_usage_aggregate_guard"();
CREATE TRIGGER "AmuxCliUsageAggregateCohort_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "AmuxCliUsageAggregateCohort"
  FOR EACH ROW EXECUTE FUNCTION "amux_cli_usage_aggregate_guard"();
CREATE TRIGGER "AmuxCliUsageAggregate_no_truncate"
  BEFORE TRUNCATE ON "AmuxCliUsageAggregate"
  FOR EACH STATEMENT EXECUTE FUNCTION "amux_cli_usage_event_no_truncate"();
CREATE TRIGGER "AmuxCliUsageAggregateCohort_no_truncate"
  BEFORE TRUNCATE ON "AmuxCliUsageAggregateCohort"
  FOR EACH STATEMENT EXECUTE FUNCTION "amux_cli_usage_event_no_truncate"();
