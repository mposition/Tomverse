-- Deployment identity, added dark.
--
-- Nothing writes these tables, nothing routes from them, and no request
-- consults them. They are added ahead of the facts that will fill them because
-- the independent review asked for exactly that order: additive schema first,
-- activation as its own decision. Adding them later, under a cutover, would
-- mean writing the identity and switching the router onto it in one step.
--
-- Three tables.
--
-- ProviderEndpoint is infrastructure: where a request is actually served.
-- Separate from the model because one Azure resource serves several model
-- deployments under one credential, and "which jurisdiction processed this" is
-- a question about the resource. `gatewayProvider` and `servingProvider` are
-- both present and there is no single `provider` column, because on an
-- aggregator route they differ and a reader could not tell which was meant.
--
-- EndpointResidencyApproval is append-only. An approval is never edited; a
-- change is a new row. An operator who could edit a destination could make a
-- past disclosure look compliant after the fact, and the whole point of the
-- record is to answer what was allowed at the time a request ran. The routing
-- gate reads this rather than the endpoint's own region so that a legal
-- question has one source instead of two that can disagree.
--
-- ModelDeployment is one routable placement of a logical model.
-- `logicalModelId` stays the product's model id and is deliberately not a
-- foreign key: the catalogue is partly static, and a registry edit must not
-- delete a deployment. The same logical model on two endpoints is two rows
-- here and one model to the person using it -- a user's saved model must never
-- become an infrastructure identifier.
--
-- `residencyClass` defaults to 'unproven', which is the accurate state rather
-- than a placeholder: no provider contract has been read and confirmed to name
-- a recipient entity and a processing region. There is no third value for
-- "probably"; whoever needed one would read it as a yes.
--
-- Rollback: drop the three tables. No existing row is read or written by this
-- migration, so nothing else changes and nothing needs backfilling. Past rows
-- are deliberately not given identities they never had.

CREATE TABLE "ProviderEndpoint" (
    "id" TEXT NOT NULL,
    "gatewayProvider" TEXT NOT NULL,
    "servingProvider" TEXT,
    "region" TEXT,
    "endpointUrl" TEXT,
    "resourceId" TEXT,
    "residencyClass" TEXT NOT NULL DEFAULT 'unproven',
    "destinationRegions" JSONB,
    "routingPolicyDigest" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderEndpoint_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "ProviderEndpoint"
    ADD CONSTRAINT "ProviderEndpoint_residencyClass_check"
    CHECK ("residencyClass" IN ('proven', 'unproven'));

CREATE INDEX "ProviderEndpoint_gatewayProvider_enabled_idx"
    ON "ProviderEndpoint"("gatewayProvider", "enabled");
CREATE INDEX "ProviderEndpoint_residencyClass_idx"
    ON "ProviderEndpoint"("residencyClass");

CREATE TABLE "EndpointResidencyApproval" (
    "id" TEXT NOT NULL,
    "providerEndpointId" TEXT NOT NULL,
    "evidenceRef" TEXT NOT NULL,
    "allowedRecipients" JSONB NOT NULL,
    "allowedRegions" JSONB NOT NULL,
    "enforcementMechanism" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "approvedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EndpointResidencyApproval_pkey" PRIMARY KEY ("id")
);

-- An approval that permits nothing is not an approval, and an empty list here
-- would read as "no restriction" to anything that iterated it.
ALTER TABLE "EndpointResidencyApproval"
    ADD CONSTRAINT "EndpointResidencyApproval_recipients_present_check"
    CHECK (jsonb_typeof("allowedRecipients") = 'array' AND jsonb_array_length("allowedRecipients") > 0);
ALTER TABLE "EndpointResidencyApproval"
    ADD CONSTRAINT "EndpointResidencyApproval_regions_present_check"
    CHECK (jsonb_typeof("allowedRegions") = 'array' AND jsonb_array_length("allowedRegions") > 0);
-- A window that ends before it starts would silently permit nothing while
-- looking like an approval.
ALTER TABLE "EndpointResidencyApproval"
    ADD CONSTRAINT "EndpointResidencyApproval_window_check"
    CHECK ("effectiveTo" IS NULL OR "effectiveTo" > "effectiveFrom");

CREATE INDEX "EndpointResidencyApproval_providerEndpointId_effectiveFrom_idx"
    ON "EndpointResidencyApproval"("providerEndpointId", "effectiveFrom");

ALTER TABLE "EndpointResidencyApproval"
    ADD CONSTRAINT "EndpointResidencyApproval_providerEndpointId_fkey"
    FOREIGN KEY ("providerEndpointId") REFERENCES "ProviderEndpoint"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TABLE "ModelDeployment" (
    "id" TEXT NOT NULL,
    "logicalModelId" TEXT NOT NULL,
    "providerEndpointId" TEXT NOT NULL,
    "upstreamDeploymentName" TEXT NOT NULL,
    "modelVersion" TEXT,
    "modelRevision" TEXT,
    "quantization" TEXT,
    "tokenizerRevision" TEXT,
    "qualityGateStatus" TEXT NOT NULL DEFAULT 'pending',
    "qualityGateExpiresAt" TIMESTAMP(3),
    "capabilities" JSONB,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ModelDeployment_pkey" PRIMARY KEY ("id")
);

-- 'stale' is its own state rather than a flavour of 'failed': evidence that
-- expired is not evidence that the model got worse, and treating them alike
-- would make an expiry look like a regression in the report.
ALTER TABLE "ModelDeployment"
    ADD CONSTRAINT "ModelDeployment_qualityGateStatus_check"
    CHECK ("qualityGateStatus" IN ('pending', 'passed', 'failed', 'stale'));

-- An enabled deployment has to be gated. The default is disabled and pending,
-- so nothing can be switched on by omission.
ALTER TABLE "ModelDeployment"
    ADD CONSTRAINT "ModelDeployment_enabled_requires_gate_check"
    CHECK ("enabled" = false OR "qualityGateStatus" = 'passed');

CREATE UNIQUE INDEX "ModelDeployment_providerEndpointId_upstreamDeploymentName_key"
    ON "ModelDeployment"("providerEndpointId", "upstreamDeploymentName");
CREATE INDEX "ModelDeployment_logicalModelId_enabled_idx"
    ON "ModelDeployment"("logicalModelId", "enabled");

ALTER TABLE "ModelDeployment"
    ADD CONSTRAINT "ModelDeployment_providerEndpointId_fkey"
    FOREIGN KEY ("providerEndpointId") REFERENCES "ProviderEndpoint"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;
