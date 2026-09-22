-- How much room a quota scope has left, added dark.
--
-- Same condition as the tables before it: nothing reads or writes it, and
-- `npm run check:dark-tables` holds that.
--
-- ---------------------------------------------------------------------------
-- Why capacity is not health
-- ---------------------------------------------------------------------------
--
-- A 429 says this key is spending too fast. A 5xx says the provider could not
-- serve the request. They call for opposite responses -- wait, versus go
-- somewhere else -- and today they increment the same counter:
-- `PROVIDER_SCOPED` in lib/providerErrorClassification.ts puts `RATE_LIMIT`
-- beside `SERVER_ERROR` and `NETWORK`, and `recordProviderHealthHeartbeat`
-- adds one to `ProviderHealthState.consecutiveFailures` for all of them.
--
-- So a peak-hour rate limit marches a healthy provider toward a circuit
-- breaker and pushes its traffic onto a fallback that is about to meet the
-- same wall. That is the failure this table separates out.
--
-- Nothing here reaches provider health and nothing in provider health reaches
-- here. Keeping the two apart is the same decision the repository already
-- makes three times over in `ProviderHealthState`, where real traffic,
-- synthetic probes and operator verification each get their own columns so
-- that one stream cannot overwrite another.
--
-- ---------------------------------------------------------------------------
-- Why a demotion expires and a failure count does not
-- ---------------------------------------------------------------------------
--
-- `deprioritizeUntil` is a timestamp, not a counter. A scope that was busy
-- this afternoon returns on its own; nothing has to notice it recovered and
-- nothing has to write a recovery probe. A counter needs somebody to clear it,
-- and the somebody is usually a success that never comes because the counter
-- is what stopped the traffic.
--
-- One row per scope. The scope already says what is being counted, and a
-- second row would be a second answer to how much is left.
--
-- Rollback: drop the table. Nothing else is read or written.

CREATE TABLE "QuotaCapacityState" (
    "id" TEXT NOT NULL,
    "quotaScopeId" TEXT NOT NULL,
    "rateLimitedCount" INTEGER NOT NULL DEFAULT 0,
    "windowStartedAt" TIMESTAMP(3),
    "retryAfterUntil" TIMESTAMP(3),
    "deprioritizeUntil" TIMESTAMP(3),
    "concurrencyLimit" INTEGER,
    "concurrencyInUse" INTEGER NOT NULL DEFAULT 0,
    "tokenBucketRemaining" INTEGER,
    "tokenBucketRefilledAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "QuotaCapacityState_pkey" PRIMARY KEY ("id")
);

-- Counts do not go backwards past zero. A negative in-use count would read as
-- spare capacity, which is the direction that lets too much through.
ALTER TABLE "QuotaCapacityState"
    ADD CONSTRAINT "QuotaCapacityState_counts_non_negative_check"
    CHECK (
        "rateLimitedCount" >= 0
        AND "concurrencyInUse" >= 0
        AND ("concurrencyLimit" IS NULL OR "concurrencyLimit" >= 0)
        AND ("tokenBucketRemaining" IS NULL OR "tokenBucketRemaining" >= 0)
    );

-- A count belongs to a window. Without one, "seven rate limits" is a number
-- with no period attached and every reader picks their own.
ALTER TABLE "QuotaCapacityState"
    ADD CONSTRAINT "QuotaCapacityState_count_has_window_check"
    CHECK ("rateLimitedCount" = 0 OR "windowStartedAt" IS NOT NULL);

-- A bucket that has a level has a time it was filled to it. A remaining count
-- with no refill time cannot be aged, so it would be believed forever.
ALTER TABLE "QuotaCapacityState"
    ADD CONSTRAINT "QuotaCapacityState_bucket_has_refill_check"
    CHECK (
        ("tokenBucketRemaining" IS NULL AND "tokenBucketRefilledAt" IS NULL)
        OR ("tokenBucketRemaining" IS NOT NULL AND "tokenBucketRefilledAt" IS NOT NULL)
    );

CREATE UNIQUE INDEX "QuotaCapacityState_quotaScopeId_key"
    ON "QuotaCapacityState"("quotaScopeId");
CREATE INDEX "QuotaCapacityState_deprioritizeUntil_idx"
    ON "QuotaCapacityState"("deprioritizeUntil");
CREATE INDEX "QuotaCapacityState_retryAfterUntil_idx"
    ON "QuotaCapacityState"("retryAfterUntil");

-- Cascade: the state is how much room this scope has, and without the scope it
-- is a number about nothing.
ALTER TABLE "QuotaCapacityState"
    ADD CONSTRAINT "QuotaCapacityState_quotaScopeId_fkey"
    FOREIGN KEY ("quotaScopeId") REFERENCES "QuotaScope"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT;
