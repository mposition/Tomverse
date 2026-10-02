-- Dark v24/v25 aggregate storage only. This does not add a writer, purge job,
-- Admin reader or activation switch. Final cells are immutable and all cells
-- for one provider-year must arrive in the same transaction as its seal.
CREATE TABLE "AmuxCliUsageAggregateFinalization" (
  "id" TEXT NOT NULL,
  "year" INTEGER NOT NULL,
  "providerScopeKey" VARCHAR(64) NOT NULL,
  "outcome" TEXT NOT NULL,
  "rawInvocationCount" INTEGER,
  "creationXid" BIGINT NOT NULL DEFAULT txid_current(),
  "finalizedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AmuxCliUsageAggregateFinalization_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AmuxCliUsageAggregateFinalization_scope_check" CHECK (
    "year" BETWEEN 1000 AND 9998 AND
    "providerScopeKey" IN ('openai', 'anthropic', 'actualProviderUnknown')
  ),
  CONSTRAINT "AmuxCliUsageAggregateFinalization_outcome_check" CHECK (
    ("outcome" = 'published' AND "rawInvocationCount" >= 5) OR
    ("outcome" IN ('empty', 'excluded_small') AND "rawInvocationCount" IS NULL)
  )
);
CREATE UNIQUE INDEX "AmuxCliUsageAggregateFinalization_year_providerScopeKey_key"
  ON "AmuxCliUsageAggregateFinalization"("year", "providerScopeKey");
CREATE INDEX "AmuxCliUsageAggregateFinalization_finalizedAt_idx"
  ON "AmuxCliUsageAggregateFinalization"("finalizedAt");

CREATE TABLE "AmuxCliUsageAggregateCell" (
  "id" TEXT NOT NULL,
  "finalizationId" TEXT NOT NULL,
  "granularity" TEXT NOT NULL,
  "period" VARCHAR(7) NOT NULL,
  "actualModelId" VARCHAR(160),
  "workerRole" VARCHAR(32),
  "invocationCount" INTEGER NOT NULL,
  "inputTokens" BIGINT,
  "outputTokens" BIGINT,
  "cacheReadInputTokens" BIGINT,
  "cacheCreationInputTokens" BIGINT,
  "unknownInputCount" INTEGER NOT NULL,
  "unknownOutputCount" INTEGER NOT NULL,
  "unknownCacheReadCount" INTEGER NOT NULL,
  "unknownCacheCreationCount" INTEGER NOT NULL,
  "firstRecordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AmuxCliUsageAggregateCell_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "AmuxCliUsageAggregateCell_finalizationId_fkey" FOREIGN KEY ("finalizationId")
    REFERENCES "AmuxCliUsageAggregateFinalization"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "AmuxCliUsageAggregateCell_shape_check" CHECK (
    "invocationCount" >= 5 AND
    ("actualModelId" IS NULL OR (
      "actualModelId" ~ '^[A-Za-z0-9._/\[\]-]{1,160}$' AND
      "actualModelId" !~ '(^/|/$|//|(^|/)\.{1,2}(/|$))'
    )) AND
    ("workerRole" IS NULL OR "workerRole" ~ '^[a-z][a-z0-9_]{0,31}$') AND
    (("granularity" = 'month_role' AND "period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
      AND "actualModelId" IS NOT NULL AND "workerRole" IS NOT NULL) OR
     ("granularity" = 'month_model' AND "period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
      AND "actualModelId" IS NOT NULL AND "workerRole" IS NULL) OR
     ("granularity" = 'month' AND "period" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'
      AND "actualModelId" IS NULL AND "workerRole" IS NULL) OR
     ("granularity" = 'quarter' AND "period" ~ '^[0-9]{4}-Q[1-4]$'
      AND "actualModelId" IS NULL AND "workerRole" IS NULL) OR
     ("granularity" = 'year' AND "period" ~ '^[0-9]{4}$'
      AND "actualModelId" IS NULL AND "workerRole" IS NULL))
  ),
  CONSTRAINT "AmuxCliUsageAggregateCell_token_visibility_check" CHECK (
    "unknownInputCount" BETWEEN 0 AND "invocationCount" AND
    "unknownOutputCount" BETWEEN 0 AND "invocationCount" AND
    "unknownCacheReadCount" BETWEEN 0 AND "invocationCount" AND
    "unknownCacheCreationCount" BETWEEN 0 AND "invocationCount" AND
    (("invocationCount" - "unknownInputCount" >= 5 AND "inputTokens" >= 0) OR
      ("invocationCount" - "unknownInputCount" < 5 AND "inputTokens" IS NULL)) AND
    (("invocationCount" - "unknownOutputCount" >= 5 AND "outputTokens" >= 0) OR
      ("invocationCount" - "unknownOutputCount" < 5 AND "outputTokens" IS NULL)) AND
    (("invocationCount" - "unknownCacheReadCount" >= 5 AND "cacheReadInputTokens" >= 0) OR
      ("invocationCount" - "unknownCacheReadCount" < 5 AND "cacheReadInputTokens" IS NULL)) AND
    (("invocationCount" - "unknownCacheCreationCount" >= 5 AND "cacheCreationInputTokens" >= 0) OR
      ("invocationCount" - "unknownCacheCreationCount" < 5 AND "cacheCreationInputTokens" IS NULL))
  )
);
CREATE INDEX "AmuxCliUsageAggregateCell_finalizationId_idx"
  ON "AmuxCliUsageAggregateCell"("finalizationId");
CREATE INDEX "AmuxCliUsageAggregateCell_firstRecordedAt_idx"
  ON "AmuxCliUsageAggregateCell"("firstRecordedAt");
CREATE UNIQUE INDEX "AmuxCliUsageAggregateCell_final_dimensions_key"
  ON "AmuxCliUsageAggregateCell"("finalizationId", "granularity", "period",
    "actualModelId", "workerRole") NULLS NOT DISTINCT;

CREATE FUNCTION amux_cli_aggregate_finalize_stamp() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  NEW."creationXid" := txid_current();
  NEW."finalizedAt" := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxCliUsageAggregateFinalization_stamp"
  BEFORE INSERT ON "AmuxCliUsageAggregateFinalization"
  FOR EACH ROW EXECUTE FUNCTION amux_cli_aggregate_finalize_stamp();

CREATE FUNCTION amux_cli_aggregate_cell_stamp_and_scope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  parent_year INTEGER;
  parent_xid BIGINT;
  parent_outcome TEXT;
BEGIN
  EXECUTE pg_catalog.format(
    'SELECT "year", "creationXid", "outcome" FROM %I."AmuxCliUsageAggregateFinalization" WHERE "id" = $1 FOR KEY SHARE',
    TG_TABLE_SCHEMA
  ) INTO parent_year, parent_xid, parent_outcome USING NEW."finalizationId";
  IF parent_year IS NULL OR parent_xid <> txid_current() OR parent_outcome <> 'published'
      OR substring(NEW."period" FROM 1 FOR 4) <> parent_year::TEXT THEN
    RAISE EXCEPTION 'AMUX CLI aggregate cell must be part of its provider-year finalization'
      USING ERRCODE = 'AX002';
  END IF;
  NEW."firstRecordedAt" := clock_timestamp();
  RETURN NEW;
END;
$$;
CREATE TRIGGER "AmuxCliUsageAggregateCell_stamp_and_scope"
  BEFORE INSERT ON "AmuxCliUsageAggregateCell"
  FOR EACH ROW EXECUTE FUNCTION amux_cli_aggregate_cell_stamp_and_scope();

CREATE FUNCTION amux_cli_aggregate_refuse_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'AMUX CLI aggregate finalization is immutable'
    USING ERRCODE = 'AX003';
END;
$$;
CREATE TRIGGER "AmuxCliUsageAggregateFinalization_refuse_change"
  BEFORE UPDATE OR DELETE ON "AmuxCliUsageAggregateFinalization"
  FOR EACH ROW EXECUTE FUNCTION amux_cli_aggregate_refuse_change();
CREATE TRIGGER "AmuxCliUsageAggregateCell_refuse_change"
  BEFORE UPDATE OR DELETE ON "AmuxCliUsageAggregateCell"
  FOR EACH ROW EXECUTE FUNCTION amux_cli_aggregate_refuse_change();
CREATE TRIGGER "AmuxCliUsageAggregateFinalization_refuse_truncate"
  BEFORE TRUNCATE ON "AmuxCliUsageAggregateFinalization"
  FOR EACH STATEMENT EXECUTE FUNCTION amux_cli_aggregate_refuse_change();
CREATE TRIGGER "AmuxCliUsageAggregateCell_refuse_truncate"
  BEFORE TRUNCATE ON "AmuxCliUsageAggregateCell"
  FOR EACH STATEMENT EXECUTE FUNCTION amux_cli_aggregate_refuse_change();

CREATE FUNCTION amux_cli_aggregate_finalization_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  target_id TEXT;
  parent_outcome TEXT;
  raw_count INTEGER;
  cell_count BIGINT;
  invocation_sum BIGINT;
BEGIN
  IF TG_TABLE_NAME = 'AmuxCliUsageAggregateCell' THEN
    target_id := NEW."finalizationId";
  ELSE
    target_id := NEW."id";
  END IF;
  EXECUTE pg_catalog.format(
    'SELECT f."outcome", f."rawInvocationCount", count(c."id"), coalesce(sum(c."invocationCount"), 0) FROM %I."AmuxCliUsageAggregateFinalization" f LEFT JOIN %I."AmuxCliUsageAggregateCell" c ON c."finalizationId" = f."id" WHERE f."id" = $1 GROUP BY f."id"',
    TG_TABLE_SCHEMA, TG_TABLE_SCHEMA
  ) INTO parent_outcome, raw_count, cell_count, invocation_sum USING target_id;
  IF parent_outcome IS NULL OR
     (parent_outcome = 'published' AND
      (cell_count = 0 OR invocation_sum <> raw_count)) OR
     (parent_outcome <> 'published' AND cell_count <> 0) THEN
    RAISE EXCEPTION 'AMUX CLI aggregate finalization is incomplete'
      USING ERRCODE = 'AX004';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER "AmuxCliUsageAggregateFinalization_complete"
  AFTER INSERT ON "AmuxCliUsageAggregateFinalization"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION amux_cli_aggregate_finalization_complete();
CREATE CONSTRAINT TRIGGER "AmuxCliUsageAggregateCell_complete"
  AFTER INSERT ON "AmuxCliUsageAggregateCell"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  EXECUTE FUNCTION amux_cli_aggregate_finalization_complete();
