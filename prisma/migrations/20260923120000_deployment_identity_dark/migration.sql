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
    "qualityTier" TEXT,
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

-- ---------------------------------------------------------------------------
-- The rules the comments above claim, enforced rather than described.
-- ---------------------------------------------------------------------------
--
-- An earlier draft of this file said the approval record was append-only and
-- left nothing stopping an UPDATE. A comment that claims more than the database
-- holds is worse than no comment: it is the sentence somebody quotes when
-- asking whether a past disclosure could have been edited.

-- An identifier list is a list of identifiers. The array checks above allow
-- [null], [{}], [""] and duplicates, each of which reads as a recipient or a
-- region to anything that iterates it and is none.
CREATE OR REPLACE FUNCTION "is_identifier_array"(value jsonb)
RETURNS boolean AS $$
    SELECT jsonb_typeof(value) = 'array'
        AND jsonb_array_length(value) > 0
        AND NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(value) AS element
            WHERE jsonb_typeof(element) <> 'string'
               OR btrim(element #>> '{}') = ''
        )
        AND (
            SELECT count(DISTINCT element #>> '{}') FROM jsonb_array_elements(value) AS element
        ) = jsonb_array_length(value);
$$ LANGUAGE sql IMMUTABLE;

ALTER TABLE "EndpointResidencyApproval"
    DROP CONSTRAINT "EndpointResidencyApproval_recipients_present_check";
ALTER TABLE "EndpointResidencyApproval"
    DROP CONSTRAINT "EndpointResidencyApproval_regions_present_check";
ALTER TABLE "EndpointResidencyApproval"
    ADD CONSTRAINT "EndpointResidencyApproval_recipients_present_check"
    CHECK ("is_identifier_array"("allowedRecipients"));
ALTER TABLE "EndpointResidencyApproval"
    ADD CONSTRAINT "EndpointResidencyApproval_regions_present_check"
    CHECK ("is_identifier_array"("allowedRegions"));

-- Append-only, with one exception that has to exist: an approval left open
-- needs a way to end. Setting `effectiveTo` once, forward, is that way. Making
-- the row wholly immutable would leave a permission nobody could withdraw,
-- which is the opposite of the property this record is for.
CREATE OR REPLACE FUNCTION "endpoint_residency_approval_is_append_only"()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."id" IS DISTINCT FROM OLD."id"
        OR NEW."providerEndpointId" IS DISTINCT FROM OLD."providerEndpointId"
        OR NEW."evidenceRef" IS DISTINCT FROM OLD."evidenceRef"
        OR NEW."allowedRecipients" IS DISTINCT FROM OLD."allowedRecipients"
        OR NEW."allowedRegions" IS DISTINCT FROM OLD."allowedRegions"
        OR NEW."enforcementMechanism" IS DISTINCT FROM OLD."enforcementMechanism"
        OR NEW."effectiveFrom" IS DISTINCT FROM OLD."effectiveFrom"
        OR NEW."approvedBy" IS DISTINCT FROM OLD."approvedBy"
        OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
    THEN
        RAISE EXCEPTION
            'EndpointResidencyApproval % is append-only; supersede it with a new row', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD."effectiveTo" IS NOT NULL AND NEW."effectiveTo" IS DISTINCT FROM OLD."effectiveTo" THEN
        RAISE EXCEPTION
            'EndpointResidencyApproval % has already been ended', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "endpoint_residency_approval_is_append_only_trigger"
    BEFORE UPDATE ON "EndpointResidencyApproval"
    FOR EACH ROW
    EXECUTE FUNCTION "endpoint_residency_approval_is_append_only"();

-- Deleting an approval would remove the answer to what was permitted when a
-- request ran, which is the one question it exists to answer.
CREATE OR REPLACE FUNCTION "endpoint_residency_approval_is_not_deletable"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'EndpointResidencyApproval % cannot be deleted; end it with effectiveTo', OLD."id"
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "endpoint_residency_approval_is_not_deletable_trigger"
    BEFORE DELETE ON "EndpointResidencyApproval"
    FOR EACH ROW
    EXECUTE FUNCTION "endpoint_residency_approval_is_not_deletable"();

-- A passed gate is about a particular thing. Change the thing and the evidence
-- no longer describes it, so an enabled deployment cannot have its identity or
-- its capabilities edited underneath a pass: `enabled = false` and a gate reset
-- come first, in the same statement or an earlier one.
CREATE OR REPLACE FUNCTION "model_deployment_gate_follows_identity"()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW."enabled" AND (
        NEW."logicalModelId" IS DISTINCT FROM OLD."logicalModelId"
        OR NEW."providerEndpointId" IS DISTINCT FROM OLD."providerEndpointId"
        OR NEW."upstreamDeploymentName" IS DISTINCT FROM OLD."upstreamDeploymentName"
        OR NEW."modelVersion" IS DISTINCT FROM OLD."modelVersion"
        OR NEW."modelRevision" IS DISTINCT FROM OLD."modelRevision"
        OR NEW."quantization" IS DISTINCT FROM OLD."quantization"
        OR NEW."tokenizerRevision" IS DISTINCT FROM OLD."tokenizerRevision"
        OR NEW."qualityTier" IS DISTINCT FROM OLD."qualityTier"
        OR NEW."capabilities" IS DISTINCT FROM OLD."capabilities"
    ) THEN
        RAISE EXCEPTION
            'ModelDeployment % cannot change what it is while enabled; disable and re-gate it', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "model_deployment_gate_follows_identity_trigger"
    BEFORE UPDATE ON "ModelDeployment"
    FOR EACH ROW
    EXECUTE FUNCTION "model_deployment_gate_follows_identity"();

-- Expiry is part of being gated, not a separate report. A gate that expired is
-- evidence that no longer applies, and an enabled row resting on one is the
-- same state as an ungated row.
ALTER TABLE "ModelDeployment"
    ADD CONSTRAINT "ModelDeployment_enabled_requires_expiry_check"
    CHECK ("enabled" = false OR "qualityGateExpiresAt" IS NOT NULL);
