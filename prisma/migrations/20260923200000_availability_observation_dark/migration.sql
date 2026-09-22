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
-- An independent review asked for a canonical observation with an event id,
-- and for the deployment, endpoint and provider views to be derived from it
-- idempotently, so a projection that failed half way can be run again without
-- double-counting. That is this table. `eventId` is unique; a projection
-- applies an event at most once.
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

-- The same closed vocabulary RoutingAttempt.errorClass uses. A second list
-- would let one table call a rate limit something the other could not read.
ALTER TABLE "AvailabilityObservation"
    ADD CONSTRAINT "AvailabilityObservation_errorClass_check"
    CHECK (
        "errorClass" IS NULL
        OR "errorClass" IN (
            'empty_response',
            'first_token_deadline_exceeded',
            'request_failed',
            'process_stopped_after_dispatch',
            'client_gone',
            'completion_handling_failed',
            'provider_pre_token_failure',
            'provider_policy_refusal',
            'provider_payment_required',
            'provider_rate_limited',
            'provider_server_error',
            'provider_network',
            'provider_authentication',
            'provider_request_contract',
            'provider_model_not_found',
            'provider_model_transient',
            'provider_local_rejection',
            'provider_unknown'
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

-- The idempotency key. A projection applies an event at most once, so a
-- rollup that failed half way can be run again.
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
