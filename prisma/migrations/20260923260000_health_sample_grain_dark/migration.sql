-- The grain columns on the two tables health is actually sampled from. Added
-- dark.
--
-- Nothing reads or writes them, and `npm run check:dark-tables` holds that for
-- the four column names as well as for the dark tables beside them.
--
-- ---------------------------------------------------------------------------
-- Why these two tables
-- ---------------------------------------------------------------------------
--
-- The router's candidate filter reads `ProviderProbeResult` (through
-- `readProbeHealth` in lib/routerRuntimeSignals.ts) and its dispatch signals
-- come from `RoutingAttempt`. `ProviderHealthState` is the public status page
-- and the operator recovery path, and it is deliberately untouched.
--
-- Both samples are per provider. Routing needs them per deployment, and
-- neither table has anywhere to say which deployment a sample came from. That
-- gap is the first of the five things the design's section 8.1 lists as
-- required before the candidate filter can cut over to the deployment grain,
-- and this closes it in the schema.
--
-- It closes only that. A column with nowhere for a value to come from is not a
-- sample: the probe scheduler still dispatches one representative model per
-- provider, so every row will carry NULL until a per-deployment canary exists,
-- which is prerequisite 2 and is blocked behind the identity config writer.
-- Adding the columns first is what lets that work be a writer change rather
-- than a writer change plus a migration on two live tables.
--
-- ---------------------------------------------------------------------------
-- Why nullable, and why no backfill
-- ---------------------------------------------------------------------------
--
-- Every existing row was written before deployments existed. There is no
-- record of which placement served them and no rule that could recover one --
-- a provider had one endpoint as far as this repository is concerned, and
-- writing that in would be inventing the attribution the whole identity change
-- exists to stop.
--
-- ---------------------------------------------------------------------------
-- Why RESTRICT and not CASCADE
-- ---------------------------------------------------------------------------
--
-- These are historical records. A probe result and an attempt say what
-- happened, and deleting the deployment they name must not delete them or
-- quietly drop the attribution: the way to stop routing to a placement is to
-- disable it, and a placement that answered turns is one whose history has to
-- keep saying so.
--
-- `AvailabilityObservation` gets the same two foreign keys here, which it
-- should have had when it was added. Without them its deployment and endpoint
-- columns accept an id matching no row, and an observation attributed to
-- nothing is indistinguishable from one attributed to something until somebody
-- joins.
--
-- Rollback: drop the four columns, the two constraints and the four foreign
-- keys. Nothing reads them.

-- ---------------------------------------------------------------------------
-- 1. ProviderProbeResult
-- ---------------------------------------------------------------------------

ALTER TABLE "ProviderProbeResult"
    ADD COLUMN "providerEndpointId" TEXT,
    ADD COLUMN "modelDeploymentId" TEXT;

-- An endpoint is what a deployment is served from, so a sample that names a
-- deployment and no endpoint cannot be rolled up to one: it would sit in the
-- deployment view and vanish from the endpoint view, which reads as an
-- endpoint that had no trouble. Same rule as AvailabilityObservation, and
-- stated the same way on purpose.
ALTER TABLE "ProviderProbeResult"
    ADD CONSTRAINT "ProviderProbeResult_deployment_has_endpoint_check"
    CHECK ("modelDeploymentId" IS NULL OR "providerEndpointId" IS NOT NULL);

CREATE INDEX "ProviderProbeResult_modelDeploymentId_createdAt_idx"
    ON "ProviderProbeResult"("modelDeploymentId", "createdAt")
    WHERE "modelDeploymentId" IS NOT NULL;
CREATE INDEX "ProviderProbeResult_providerEndpointId_createdAt_idx"
    ON "ProviderProbeResult"("providerEndpointId", "createdAt")
    WHERE "providerEndpointId" IS NOT NULL;

ALTER TABLE "ProviderProbeResult"
    ADD CONSTRAINT "ProviderProbeResult_providerEndpointId_fkey"
    FOREIGN KEY ("providerEndpointId") REFERENCES "ProviderEndpoint"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "ProviderProbeResult"
    ADD CONSTRAINT "ProviderProbeResult_modelDeploymentId_fkey"
    FOREIGN KEY ("modelDeploymentId") REFERENCES "ModelDeployment"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- 2. RoutingAttempt
-- ---------------------------------------------------------------------------

ALTER TABLE "RoutingAttempt"
    ADD COLUMN "providerEndpointId" TEXT,
    ADD COLUMN "modelDeploymentId" TEXT;

ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_deployment_has_endpoint_check"
    CHECK ("modelDeploymentId" IS NULL OR "providerEndpointId" IS NOT NULL);

CREATE INDEX "RoutingAttempt_modelDeploymentId_createdAt_idx"
    ON "RoutingAttempt"("modelDeploymentId", "createdAt")
    WHERE "modelDeploymentId" IS NOT NULL;
CREATE INDEX "RoutingAttempt_providerEndpointId_createdAt_idx"
    ON "RoutingAttempt"("providerEndpointId", "createdAt")
    WHERE "providerEndpointId" IS NOT NULL;

ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_providerEndpointId_fkey"
    FOREIGN KEY ("providerEndpointId") REFERENCES "ProviderEndpoint"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "RoutingAttempt"
    ADD CONSTRAINT "RoutingAttempt_modelDeploymentId_fkey"
    FOREIGN KEY ("modelDeploymentId") REFERENCES "ModelDeployment"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- 3. The foreign keys AvailabilityObservation should have had
-- ---------------------------------------------------------------------------

ALTER TABLE "AvailabilityObservation"
    ADD CONSTRAINT "AvailabilityObservation_providerEndpointId_fkey"
    FOREIGN KEY ("providerEndpointId") REFERENCES "ProviderEndpoint"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "AvailabilityObservation"
    ADD CONSTRAINT "AvailabilityObservation_modelDeploymentId_fkey"
    FOREIGN KEY ("modelDeploymentId") REFERENCES "ModelDeployment"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
