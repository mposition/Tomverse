-- Marketing LLM cost ledger (docs/policy/marketing-automation.md §5, policy v4).
--
-- One row per generator LLM call. The app cannot see what the generator sent,
-- so a dispatched call is counted at its reservation -- the most the pinned
-- model can cost for one request -- whatever tokens are reported later. The
-- monthly sum of non-released reservations is what the US$100 cap is checked
-- against, under one advisory lock per UTC month.
--
-- What the database holds on its own, for any writer, including plain SQL:
--   1. Rows are born `reserved`, with nothing of the later phases set.
--   2. The reservation (everything decided when it was made) never changes.
--   3. Five transitions only. The dispatch evidence is set once, by the
--      transition to `dispatched`; the close evidence is set once, by the
--      transition that closes the call. Neither moves afterwards.
--   4. Which columns are set is a function of the state and, for a closed
--      call, of the reason it closed (one CHECK).
--   5. Timestamps are the database's. `createdAt` is read once by the writer
--      from this clock and checked here, not recomputed, so the month the row
--      is counted in is the month whose lock the writer took.
--   6. Expiry closes are refused early, a dispatch is refused late.
--   7. Deletion is retention's alone: past `retentionUntil`, not on legal hold,
--      in a closed state, and inside a transaction that set the retention
--      setting. Truncation is allowed while the table is empty, so suites that reset AdminAuditLog
--      with CASCADE keep working against a ledger that has nothing in it.

CREATE TABLE "MarketingLlmCall" (
    "id" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "reservePayloadDigest" TEXT NOT NULL,
    "requestDigest" TEXT NOT NULL,
    "configSnapshot" JSONB NOT NULL,
    "generatorRunId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "reservedInputTokens" INTEGER NOT NULL,
    "reservedOutputTokens" INTEGER NOT NULL,
    "reservedMicroUsd" INTEGER NOT NULL,
    "monthStart" TIMESTAMP(3) NOT NULL,
    "reservationAuditLogId" TEXT NOT NULL,
    "legalHold" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL,
    -- Overwritten by the insert trigger; the default only lets a writer omit it.
    "retentionUntil" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dispatchIntentId" TEXT,
    "adapterConfigDigest" TEXT,
    "dispatchDigest" TEXT,
    "dispatchAuditLogId" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "closeDigest" TEXT,
    "closeAuditLogId" TEXT,
    "closedAt" TIMESTAMP(3),
    "closeReason" TEXT,
    "observationId" TEXT,
    "reportedModel" TEXT,
    "reportedServiceTier" TEXT,
    "reportedInputTokens" INTEGER,
    "reportedOutputTokens" INTEGER,
    "consumerDigest" TEXT,

    CONSTRAINT "MarketingLlmCall_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "MarketingLlmCall_id_check"
        CHECK ("id" ~ '^[a-z0-9]{20,40}$'),
    CONSTRAINT "MarketingLlmCall_uuid_check"
        CHECK ("requestKey" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            AND ("dispatchIntentId" IS NULL OR "dispatchIntentId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
            AND ("observationId" IS NULL OR "observationId" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
    CONSTRAINT "MarketingLlmCall_digest_check"
        CHECK ("reservePayloadDigest" ~ '^[0-9a-f]{64}$'
            AND "requestDigest" ~ '^[0-9a-f]{64}$'
            AND ("adapterConfigDigest" IS NULL OR "adapterConfigDigest" ~ '^[0-9a-f]{64}$')
            AND ("dispatchDigest" IS NULL OR "dispatchDigest" ~ '^[0-9a-f]{64}$')
            AND ("closeDigest" IS NULL OR "closeDigest" ~ '^[0-9a-f]{64}$')
            AND ("consumerDigest" IS NULL OR "consumerDigest" ~ '^[0-9a-f]{64}$')),
    CONSTRAINT "MarketingLlmCall_shape_check"
        CHECK ("generatorRunId" ~ '^[A-Za-z0-9_-]{1,64}$'
            AND "purpose" IN ('draft', 'market_intel', 'brief')
            AND "provider" = 'openai'
            AND "model" ~ '^[A-Za-z0-9._:/-]{1,128}$'
            AND jsonb_typeof("configSnapshot") = 'object'
            AND octet_length("configSnapshot"::text) <= 4096
            AND "reservedInputTokens" BETWEEN 1 AND 2000000
            AND "reservedOutputTokens" BETWEEN 1 AND 100000
            AND "reservedMicroUsd" BETWEEN 1 AND 5000000
            AND ("reportedModel" IS NULL OR "reportedModel" ~ '^[A-Za-z0-9._:/-]{1,128}$')
            AND ("reportedServiceTier" IS NULL OR "reportedServiceTier" ~ '^[a-z_]{1,32}$')
            AND ("reportedInputTokens" IS NULL OR "reportedInputTokens" >= 0)
            AND ("reportedOutputTokens" IS NULL OR "reportedOutputTokens" >= 0)),
    -- The plan's state x column matrix, with the closed reasons paired to their
    -- state and to whether the row keeps an observation.
    CONSTRAINT "MarketingLlmCall_state_check"
        CHECK (
            num_nulls("dispatchIntentId", "adapterConfigDigest", "dispatchDigest",
                      "dispatchAuditLogId", "dispatchedAt") IN (0, 5)
            AND num_nulls("closeDigest", "closeAuditLogId", "closedAt", "closeReason") IN (0, 4)
            AND num_nulls("observationId", "reportedModel", "reportedServiceTier",
                          "reportedInputTokens", "reportedOutputTokens") IN (0, 5)
            AND CASE "state"
                WHEN 'reserved' THEN
                    "dispatchIntentId" IS NULL AND "closeDigest" IS NULL
                    AND "observationId" IS NULL AND "consumerDigest" IS NULL
                WHEN 'dispatched' THEN
                    "dispatchIntentId" IS NOT NULL AND "closeDigest" IS NULL
                    AND "observationId" IS NULL AND "consumerDigest" IS NULL
                WHEN 'settled' THEN
                    "dispatchIntentId" IS NOT NULL AND "closeDigest" IS NOT NULL
                    AND "closeReason" = 'settled' AND "observationId" IS NOT NULL
                WHEN 'unknown_retained' THEN
                    "dispatchIntentId" IS NOT NULL AND "closeDigest" IS NOT NULL
                    AND CASE
                        WHEN "closeReason" IN ('tokens_over_bound', 'model_mismatch', 'tier_mismatch')
                            THEN "observationId" IS NOT NULL
                        WHEN "closeReason" IN ('reported_unknown', 'dispatch_expired')
                            THEN "observationId" IS NULL
                        ELSE false
                    END
                WHEN 'released' THEN
                    "dispatchIntentId" IS NULL AND "closeDigest" IS NOT NULL
                    AND "closeReason" IN ('reported_undispatched', 'reservation_expired')
                    AND "observationId" IS NULL AND "consumerDigest" IS NULL
                ELSE false
            END
            AND ("consumerDigest" IS NULL OR "purpose" = 'draft')
        )
);

CREATE UNIQUE INDEX "MarketingLlmCall_requestKey_key" ON "MarketingLlmCall"("requestKey");
CREATE UNIQUE INDEX "MarketingLlmCall_dispatchIntentId_key" ON "MarketingLlmCall"("dispatchIntentId");
CREATE UNIQUE INDEX "MarketingLlmCall_observationId_key" ON "MarketingLlmCall"("observationId");
CREATE UNIQUE INDEX "MarketingLlmCall_reservationAuditLogId_key" ON "MarketingLlmCall"("reservationAuditLogId");
CREATE UNIQUE INDEX "MarketingLlmCall_dispatchAuditLogId_key" ON "MarketingLlmCall"("dispatchAuditLogId");
CREATE UNIQUE INDEX "MarketingLlmCall_closeAuditLogId_key" ON "MarketingLlmCall"("closeAuditLogId");
CREATE INDEX "MarketingLlmCall_monthStart_state_idx" ON "MarketingLlmCall"("monthStart", "state");
CREATE INDEX "MarketingLlmCall_state_createdAt_idx" ON "MarketingLlmCall"("state", "createdAt");
CREATE INDEX "MarketingLlmCall_state_dispatchedAt_idx" ON "MarketingLlmCall"("state", "dispatchedAt");
CREATE INDEX "MarketingLlmCall_retentionUntil_idx" ON "MarketingLlmCall"("retentionUntil");

ALTER TABLE "MarketingLlmCall" ADD CONSTRAINT "MarketingLlmCall_reservationAuditLogId_fkey"
    FOREIGN KEY ("reservationAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MarketingLlmCall" ADD CONSTRAINT "MarketingLlmCall_dispatchAuditLogId_fkey"
    FOREIGN KEY ("dispatchAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MarketingLlmCall" ADD CONSTRAINT "MarketingLlmCall_closeAuditLogId_fkey"
    FOREIGN KEY ("closeAuditLogId") REFERENCES "AdminAuditLog"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE FUNCTION "marketing_llm_call_insert_guard"() RETURNS trigger AS $$
DECLARE
    now_utc TIMESTAMP(3) := (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
BEGIN
    IF NEW."state" IS DISTINCT FROM 'reserved' OR NEW."legalHold" THEN
        RAISE EXCEPTION 'marketing_llm_call_insert_not_reserved';
    END IF;
    IF num_nonnulls(NEW."dispatchIntentId", NEW."adapterConfigDigest", NEW."dispatchDigest",
                    NEW."dispatchAuditLogId", NEW."dispatchedAt", NEW."closeDigest",
                    NEW."closeAuditLogId", NEW."closedAt", NEW."closeReason",
                    NEW."observationId", NEW."reportedModel", NEW."reportedServiceTier",
                    NEW."reportedInputTokens", NEW."reportedOutputTokens",
                    NEW."consumerDigest") <> 0 THEN
        RAISE EXCEPTION 'marketing_llm_call_insert_not_reserved';
    END IF;
    -- The writer read createdAt from this clock once and locked its month; the
    -- row must be counted in that month, so the value is checked, not replaced.
    IF NEW."createdAt" > now_utc
        OR NEW."createdAt" < now_utc - INTERVAL '10 seconds'
        OR NEW."monthStart" IS DISTINCT FROM date_trunc('month', NEW."createdAt") THEN
        RAISE EXCEPTION 'marketing_llm_call_reservation_clock_invalid';
    END IF;
    NEW."retentionUntil" := NEW."createdAt" + INTERVAL '24 months';
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE FUNCTION "marketing_llm_call_update_guard"() RETURNS trigger AS $$
DECLARE
    now_utc TIMESTAMP(3) := (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC');
    dispatch_keys TEXT[] := ARRAY['dispatchIntentId', 'adapterConfigDigest', 'dispatchDigest',
                                  'dispatchAuditLogId', 'dispatchedAt'];
    close_keys TEXT[] := ARRAY['closeDigest', 'closeAuditLogId', 'closedAt', 'closeReason',
                               'observationId', 'reportedModel', 'reportedServiceTier',
                               'reportedInputTokens', 'reportedOutputTokens'];
    old_rest JSONB;
    new_rest JSONB;
BEGIN
    IF OLD."state" = NEW."state" THEN
        -- Same state: a legal-hold flip, or the one consumer write on a closed
        -- draft call. Never both, never anything else.
        old_rest := to_jsonb(OLD) - 'legalHold' - 'consumerDigest';
        new_rest := to_jsonb(NEW) - 'legalHold' - 'consumerDigest';
        IF old_rest IS DISTINCT FROM new_rest THEN
            RAISE EXCEPTION 'marketing_llm_call_update_invalid';
        END IF;
        IF OLD."consumerDigest" IS DISTINCT FROM NEW."consumerDigest" THEN
            IF OLD."consumerDigest" IS NOT NULL
                OR OLD."state" NOT IN ('settled', 'unknown_retained')
                OR OLD."legalHold" IS DISTINCT FROM NEW."legalHold" THEN
                RAISE EXCEPTION 'marketing_llm_call_update_invalid';
            END IF;
        END IF;
        RETURN NEW;
    END IF;

    IF OLD."legalHold" IS DISTINCT FROM NEW."legalHold"
        OR NEW."consumerDigest" IS NOT NULL THEN
        RAISE EXCEPTION 'marketing_llm_call_update_invalid';
    END IF;

    IF OLD."state" = 'reserved' AND NEW."state" = 'dispatched' THEN
        IF now_utc >= OLD."createdAt" + INTERVAL '15 minutes' THEN
            RAISE EXCEPTION 'marketing_llm_call_dispatch_late';
        END IF;
        old_rest := to_jsonb(OLD) - 'state' - dispatch_keys;
        new_rest := to_jsonb(NEW) - 'state' - dispatch_keys;
        NEW."dispatchedAt" := now_utc;
    ELSIF OLD."state" = 'reserved' AND NEW."state" = 'released' THEN
        -- A reservation is dispatchable strictly before createdAt + 15 minutes
        -- and expirable from that instant on, so no moment is neither.
        IF NEW."closeReason" = 'reservation_expired'
            AND now_utc < OLD."createdAt" + INTERVAL '15 minutes' THEN
            RAISE EXCEPTION 'marketing_llm_call_expiry_early';
        END IF;
        old_rest := to_jsonb(OLD) - 'state' - close_keys;
        new_rest := to_jsonb(NEW) - 'state' - close_keys;
        NEW."closedAt" := now_utc;
    ELSIF OLD."state" = 'dispatched' AND NEW."state" IN ('settled', 'unknown_retained') THEN
        IF NEW."closeReason" = 'dispatch_expired'
            AND now_utc < OLD."dispatchedAt" + INTERVAL '1 hour' THEN
            RAISE EXCEPTION 'marketing_llm_call_expiry_early';
        END IF;
        old_rest := to_jsonb(OLD) - 'state' - close_keys;
        new_rest := to_jsonb(NEW) - 'state' - close_keys;
        NEW."closedAt" := now_utc;
    ELSE
        RAISE EXCEPTION 'marketing_llm_call_transition_invalid';
    END IF;

    -- Everything the transition does not set is unchanged: the reservation,
    -- and for a close the dispatch evidence that came before it.
    IF old_rest IS DISTINCT FROM new_rest THEN
        RAISE EXCEPTION 'marketing_llm_call_update_invalid';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE FUNCTION "marketing_llm_call_delete_guard"() RETURNS trigger AS $$
BEGIN
    IF pg_catalog.current_setting('tomverse.marketing_retention_compaction', true) IS DISTINCT FROM 'on'
        OR OLD."legalHold"
        OR OLD."state" NOT IN ('settled', 'unknown_retained', 'released')
        OR OLD."retentionUntil" >= (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC') THEN
        RAISE EXCEPTION 'marketing_llm_call_delete_forbidden';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

-- The table is named from the trigger's own arguments, never by search_path:
-- an empty temporary table of the same name would otherwise answer for it.
CREATE FUNCTION "marketing_llm_call_no_nonempty_truncate"() RETURNS trigger AS $$
DECLARE
    non_empty BOOLEAN;
BEGIN
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %I.%I)', TG_TABLE_SCHEMA, TG_TABLE_NAME)
        INTO non_empty;
    IF non_empty THEN
        RAISE EXCEPTION 'marketing_llm_call_delete_forbidden';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp;

CREATE TRIGGER "MarketingLlmCall_insert_guard"
    BEFORE INSERT ON "MarketingLlmCall"
    FOR EACH ROW EXECUTE FUNCTION "marketing_llm_call_insert_guard"();
CREATE TRIGGER "MarketingLlmCall_update_guard"
    BEFORE UPDATE ON "MarketingLlmCall"
    FOR EACH ROW EXECUTE FUNCTION "marketing_llm_call_update_guard"();
CREATE TRIGGER "MarketingLlmCall_delete_guard"
    BEFORE DELETE ON "MarketingLlmCall"
    FOR EACH ROW EXECUTE FUNCTION "marketing_llm_call_delete_guard"();
CREATE TRIGGER "MarketingLlmCall_no_truncate"
    BEFORE TRUNCATE ON "MarketingLlmCall"
    FOR EACH STATEMENT EXECUTE FUNCTION "marketing_llm_call_no_nonempty_truncate"();
