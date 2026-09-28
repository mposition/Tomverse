-- One availability observation, added dark.
--
-- Same condition as the tables before it: nothing reads or writes it, and
-- `npm run check:dark-tables` holds that.
--
-- ---------------------------------------------------------------------------
-- Why one record and three summaries
-- ---------------------------------------------------------------------------
--
-- The routing work needs availability per deployment, and the samples that
-- exist are per provider: `recordProviderHealthHeartbeat` increments
-- `ProviderHealthState` from real traffic, and the scheduler inserts a
-- `ProviderProbeResult` per provider for one representative model. The two
-- share no identifier, so the same outage is two facts nothing can join.
--
-- An independent review asked for a canonical observation with an event id
-- that the deployment, endpoint and provider views can be derived from. This
-- table is that record and no more than that.
--
-- What the unique index gives is exactly one thing: the same observation
-- cannot be inserted twice, and a second attempt raises a unique violation
-- rather than adding a row. **That is not an idempotent projection.** There
-- are no rollup tables here, nothing records which events a rollup has
-- already applied, and two projectors running at once would each believe they
-- were first. A projection that can be re-run safely needs a record of what it
-- has applied, per grain, and that is a separate piece of work. An earlier
-- draft of this comment claimed it was already true.
--
-- Neither existing table is changed or deleted. They are the grain the public
-- status page and the operator recovery path read, and this is the grain the
-- router will read. Replacing them in the same change would have meant cutting
-- the router over to a sample that does not exist yet.
--
-- ---------------------------------------------------------------------------
-- What is deliberately null
-- ---------------------------------------------------------------------------
--
-- `modelDeploymentId` and `providerEndpointId` are nullable and nothing is
-- backfilled. An observation made before deployments existed genuinely had
-- none, and giving it one would be an attribution nobody made -- the same rule
-- the rest of this work follows. `provider` is not nullable, because it is
-- knowable for every observation there has ever been.
--
-- Three sources stay apart for the reason `ProviderHealthState` already keeps
-- them apart in separate columns: an operator proving the API answers is not
-- the same claim as "real user traffic is being served", and a synthetic probe
-- is neither.
--
-- Rollback: drop the table. Nothing else is read or written.

CREATE TABLE "AvailabilityObservation" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "modelDeploymentId" TEXT,
    "providerEndpointId" TEXT,
    "provider" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "errorClass" TEXT,
    "latencyMs" INTEGER,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AvailabilityObservation_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AvailabilityObservation"
    ADD CONSTRAINT "AvailabilityObservation_source_check"
    CHECK ("source" IN ('real_traffic', 'synthetic_probe', 'operator_verification'));

ALTER TABLE "AvailabilityObservation"
    ADD CONSTRAINT "AvailabilityObservation_outcome_check"
    CHECK ("outcome" IN ('succeeded', 'failed'));

-- A success has nothing to classify, and a failure that classifies nothing is
-- the record this whole line of work exists to stop being written.
ALTER TABLE "AvailabilityObservation"
    ADD CONSTRAINT "AvailabilityObservation_error_class_matches_outcome_check"
    CHECK (
        ("outcome" = 'failed' AND "errorClass" IS NOT NULL)
        OR ("outcome" = 'succeeded' AND "errorClass" IS NULL)
    );

-- Which failures mean the provider could not serve the request.
--
-- The spelling is shared with RoutingAttempt.errorClass on purpose: an attempt
-- and an observation calling a rate limit different things is how the two
-- grains of health stopped being joinable. What is not shared is which of them
-- counts as unavailable.
--
-- The first draft of this file admitted the whole vocabulary, which would have
-- put a rate limit, an empty answer, a client disconnect and our own process
-- stopping into an availability rollup. RoutingAttempt draws those lines with
-- failureLayer; an observation has no layer, so the line is drawn by which
-- classes may appear at all. A rate limit counted as unavailable here would
-- undo QuotaCapacityState in the summary it feeds.
ALTER TABLE "AvailabilityObservation"
    ADD CONSTRAINT "AvailabilityObservation_errorClass_check"
    CHECK (
        "errorClass" IS NULL
        OR "errorClass" IN (
            'provider_server_error',
            'provider_network',
            'provider_unknown',
            'first_token_deadline_exceeded'
        )
    );

ALTER TABLE "AvailabilityObservation"
    ADD CONSTRAINT "AvailabilityObservation_latency_non_negative_check"
    CHECK ("latencyMs" IS NULL OR "latencyMs" >= 0);

-- An endpoint is the thing a deployment is served from, so an observation that
-- names a deployment and no endpoint cannot be rolled up to one. It would sit
-- in the deployment view and vanish from the endpoint view, which reads as an
-- endpoint that had no trouble.
ALTER TABLE "AvailabilityObservation"
    ADD CONSTRAINT "AvailabilityObservation_deployment_has_endpoint_check"
    CHECK ("modelDeploymentId" IS NULL OR "providerEndpointId" IS NOT NULL);

-- The key a projection would be idempotent on, once one exists. Today it
-- stops the same observation being inserted twice, which is all it stops.
CREATE UNIQUE INDEX "AvailabilityObservation_eventId_key"
    ON "AvailabilityObservation"("eventId");

CREATE INDEX "AvailabilityObservation_provider_observedAt_idx"
    ON "AvailabilityObservation"("provider", "observedAt");
CREATE INDEX "AvailabilityObservation_providerEndpointId_observedAt_idx"
    ON "AvailabilityObservation"("providerEndpointId", "observedAt");
CREATE INDEX "AvailabilityObservation_modelDeploymentId_observedAt_idx"
    ON "AvailabilityObservation"("modelDeploymentId", "observedAt");
CREATE INDEX "AvailabilityObservation_source_observedAt_idx"
    ON "AvailabilityObservation"("source", "observedAt");

-- Append-only. A rollup is derived from these rows, so editing one after the
-- fact changes a summary that has already been read and leaves nothing saying
-- it moved.
CREATE OR REPLACE FUNCTION "availability_observation_is_append_only"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'AvailabilityObservation % is append-only; record a new observation', OLD."id"
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "availability_observation_is_append_only_trigger"
    BEFORE UPDATE OR DELETE ON "AvailabilityObservation"
    FOR EACH ROW
    EXECUTE FUNCTION "availability_observation_is_append_only"();

-- TRUNCATE does not fire an ON DELETE trigger, so the row trigger above walks
-- straight past it. It needs its own, and a statement-level one because there
-- is no row to be called for.
--
-- This stops the application, not the database owner: a superuser can disable
-- the trigger, and `session_replication_role = replica` skips it. What it
-- makes impossible is the ordinary mistake.
CREATE OR REPLACE FUNCTION "availability_observation_is_not_truncatable"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'AvailabilityObservation is append-only and cannot be truncated'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "availability_observation_is_not_truncatable_trigger"
    BEFORE TRUNCATE ON "AvailabilityObservation"
    FOR EACH STATEMENT
    EXECUTE FUNCTION "availability_observation_is_not_truncatable"();
