-- Owner decision 2026-10-26: Codex, Copilot and Cursor workers may run v22
-- one-shot Tasks as Claude workers do (the app still admits them only while
-- TOMVERSE_AMUX_V22_MULTI_PROVIDER is enabled). Each change is the latest
-- definition with only the new providers added:
-- * a v22 profile may name any provider class's model; a Claude worker stays
--   on a claude-* model (the guard, which reads the registry class);
-- * the CLI usage ledger accepts the Copilot and Cursor CLIs, with the token
--   semantics measured for the v19 channels (Copilot input includes cache
--   reads, Cursor's does not; neither reports reasoning apart from output).
-- baseline-check: replace-function-if-body-sha256 "amux_worker_capability_event_guard" "3e9e0ff0fdede56c071c3b77a1fd650a9f784000b5c2b9852ef348c2076252f9"
BEGIN;

ALTER TABLE "AmuxWorkerCapabilityEvent"
  DROP CONSTRAINT "AmuxWorkerCapabilityEvent_v22_shape_check",
  ADD CONSTRAINT "AmuxWorkerCapabilityEvent_v22_shape_check"
      CHECK (
        ("v22Model" IS NULL AND "v22Roles" IS NULL AND "v22Tools" IS NULL)
        OR (
          -- Spelled out: a NULL inside the comparisons below would make the
          -- whole branch NULL, and a NULL CHECK passes.
          "v22Model" IS NOT NULL AND "v22Roles" IS NOT NULL AND "v22Tools" IS NOT NULL
          AND ("v22Model" ~ '^claude-[A-Za-z0-9._-]{1,120}$'
            OR "v22Model" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$')
          AND pg_catalog.cardinality("v22Roles") BETWEEN 1 AND 4
          AND "v22Roles" <@ ARRAY['design', 'implement', 'investigate', 'review']::TEXT[]
          AND pg_catalog.cardinality("v22Tools") BETWEEN 1 AND 2
          AND "v22Tools" <@ ARRAY['repo_read', 'repo_write']::TEXT[]
        )
      );

CREATE OR REPLACE FUNCTION "amux_worker_capability_event_guard"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
    registry_class TEXT;
    registry_ceiling TEXT;
    registry_state TEXT;
    previous_sequence BIGINT;
    previous_revision INTEGER;
    ceiling_rank INTEGER;
    verified BOOLEAN;
    tag TEXT;
    role TEXT;
    audited BOOLEAN;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_IMMUTABLE';
    END IF;
    IF pg_catalog.current_setting('transaction_isolation') <> 'read committed' THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_ISOLATION';
    END IF;

    -- The registry's lock first (its guard takes the same key), then this
    -- table's: a ceiling change and a capability write never interleave.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('tomverse-amux-worker-registry:' || NEW."workerName")
    );
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtext('tomverse-amux-worker-capability:' || NEW."workerName")
    );

    EXECUTE pg_catalog.format(
        'SELECT "providerClass", "roleCeiling", "desiredState" FROM %I.%I WHERE "workerName" = $1 ORDER BY "sequence" DESC LIMIT 1',
        TG_TABLE_SCHEMA,
        'AmuxWorkerRegistryEvent'
    ) INTO registry_class, registry_ceiling, registry_state USING NEW."workerName";
    IF registry_class IS NULL THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_NOT_REGISTERED';
    END IF;
    IF registry_state = 'retired' THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_RETIRED';
    END IF;
    ceiling_rank := pg_catalog.array_position(ARRAY['chore', 'implementation', 'contract'], registry_ceiling);
    verified := registry_class IN ('claude', 'codex');

    IF pg_catalog.cardinality(NEW."routingTags") <> (SELECT pg_catalog.count(DISTINCT t) FROM pg_catalog.unnest(NEW."routingTags") AS t)
       OR pg_catalog.cardinality(NEW."toolCapabilities") <> (SELECT pg_catalog.count(DISTINCT t) FROM pg_catalog.unnest(NEW."toolCapabilities") AS t)
       OR (NEW."v22Roles" IS NOT NULL AND pg_catalog.cardinality(NEW."v22Roles") <> (SELECT pg_catalog.count(DISTINCT t) FROM pg_catalog.unnest(NEW."v22Roles") AS t))
       OR (NEW."v22Tools" IS NOT NULL AND pg_catalog.cardinality(NEW."v22Tools") <> (SELECT pg_catalog.count(DISTINCT t) FROM pg_catalog.unnest(NEW."v22Tools") AS t)) THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_DUPLICATE';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.unnest(NEW."toolCapabilities") AS t WHERE pg_catalog.length(t) NOT BETWEEN 1 AND 64) THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_TOOLS';
    END IF;

    FOREACH tag IN ARRAY NEW."routingTags" LOOP
        IF tag = 'implementation' AND ceiling_rank < 2 THEN
            RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_TAG_CEILING';
        END IF;
        IF tag IN ('contract', 'architecture', 'security') AND ceiling_rank < 3 THEN
            RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_TAG_CEILING';
        END IF;
        IF tag = 'review' AND NOT verified THEN
            RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_TAG_VERIFIED';
        END IF;
    END LOOP;

    IF NEW."v22Roles" IS NOT NULL THEN
        -- Every provider class may run v22; a Claude worker stays on a
        -- claude-* model (owner decision 2026-10-26).
        IF registry_class = 'claude' AND NEW."v22Model" !~ '^claude-[A-Za-z0-9._-]{1,120}$' THEN
            RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_V22_CLASS';
        END IF;
        FOREACH role IN ARRAY NEW."v22Roles" LOOP
            IF role = 'implement' AND (ceiling_rank < 2 OR NOT ('repo_write' = ANY (NEW."v22Tools"))) THEN
                RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_V22_ROLE';
            END IF;
            IF role = 'design' AND (ceiling_rank < 3 OR NOT ('repo_read' = ANY (NEW."v22Tools"))) THEN
                RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_V22_ROLE';
            END IF;
            IF role = 'investigate' AND NOT ('repo_read' = ANY (NEW."v22Tools")) THEN
                RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_V22_ROLE';
            END IF;
            IF role = 'review' AND (NOT verified OR NOT ('repo_read' = ANY (NEW."v22Tools"))) THEN
                RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_V22_ROLE';
            END IF;
        END LOOP;
    END IF;

    EXECUTE pg_catalog.format(
        'SELECT "sequence", "revision" FROM %I.%I WHERE "workerName" = $1 ORDER BY "sequence" DESC LIMIT 1',
        TG_TABLE_SCHEMA,
        'AmuxWorkerCapabilityEvent'
    ) INTO previous_sequence, previous_revision USING NEW."workerName";
    IF NEW."revision" <> COALESCE(previous_revision, 0) + 1 THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_STALE_REVISION';
    END IF;
    IF previous_sequence IS NOT NULL AND NEW."sequence" <= previous_sequence THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_OUT_OF_ORDER';
    END IF;

    EXECUTE pg_catalog.format(
        'SELECT EXISTS (SELECT 1 FROM %I.%I WHERE "id" = $1 AND "action" = $2 AND "targetType" = $3 AND "targetId" = $4 AND "actorUserId" = $5 AND NOT coalesce(pg_catalog.jsonb_typeof("metadata") = ''object'' AND "metadata" ? ''systemActor'', false) AND xmin = pg_catalog.pg_current_xact_id()::xid)',
        TG_TABLE_SCHEMA,
        'AdminAuditLog'
    ) INTO audited USING NEW."auditLogId", 'amux.worker.capability', 'AmuxWorkerCapabilityEvent', NEW."id", NEW."actorUserId";
    IF audited IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'AMUX_WORKER_CAPABILITY_UNAUDITED';
    END IF;

    NEW."createdAt" := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$$;

ALTER TABLE "AmuxCliUsageEvent"
  DROP CONSTRAINT "AmuxCliUsageEvent_source_check",
  ADD CONSTRAINT "AmuxCliUsageEvent_source_check" CHECK (
    ("cli" = 'codex' AND "provider" = 'openai') OR
    ("cli" = 'claude' AND "provider" = 'anthropic') OR
    ("cli" = 'copilot' AND "provider" = 'github-copilot') OR
    ("cli" = 'cursor' AND "provider" = 'cursor') OR
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
      OR ("cli" = 'copilot' AND "inputTokensIncludeCacheRead" AND
        "reasoningOutputIncludedInOutput" IS NULL)
      OR ("cli" = 'cursor' AND NOT "inputTokensIncludeCacheRead" AND
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
