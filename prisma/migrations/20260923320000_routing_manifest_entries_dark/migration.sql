-- What each published manifest actually held. Added dark.
--
-- Nothing writes an entry and nothing reads one.
-- `npm run check:dark-tables` holds that.
--
-- ---------------------------------------------------------------------------
-- Why a digest was not enough
-- ---------------------------------------------------------------------------
--
-- The manifest table stored a digest and a count and called that an answer to
-- "what was allowed at the time". It is not. A digest proves a set of values
-- was not altered *if you still have the values*, and `ModelDeployment` and
-- `ProviderEndpoint` are mutable rows that will have moved by the time anybody
-- asks. An independent review rejected the first version on exactly that:
-- section 4.4 asks for a reconstruction, and a hash is a verification.
--
-- So each manifest publishes its entries. Every field a decision turns on is
-- copied at publication, and the residency approval is a foreign key rather
-- than a copy -- that table is append-only, so its recipients, regions,
-- enforcement mechanism, evidence and dates are already immutable where they
-- are, and copying them would be a second place they could disagree.
--
-- ---------------------------------------------------------------------------
-- Why these columns and not the first list
-- ---------------------------------------------------------------------------
--
-- The first field list was smaller than what this repository already calls
-- identity, and the gap was exploitable without a single forbidden write.
-- `model_deployment_gate_follows_identity()` refuses to leave a deployment
-- enabled when any of nine columns changes, and five of them were missing:
-- `modelRevision`, `quantization`, `tokenizerRevision`, `qualityTier`,
-- `capabilities`.
--
-- The sequence: disable the deployment, which moves the digest; change
-- `capabilities` while it is disabled, which the trigger permits; re-enable
-- and restore `qualityGateStatus`. Every digested value is back where it
-- started and the candidate filter reads different capabilities.
--
-- `qualityGateExpiresAt` joins them, because the same migration calls the
-- expiry part of the gate and two placements whose evidence expires on
-- different days are not the same manifest.
--
-- `ProviderEndpoint` has no such trigger at all, so `gatewayProvider`,
-- `servingProvider`, `endpointUrl` and its own `enabled` move under a stable
-- id. Those decide where the request goes and who receives it, which section
-- 2.1 puts in the upper layer -- swap the two rows, and if the answer or its
-- legality changes, it belongs here.
--
-- Deliberately absent: `routingPolicyDigest` (intent, not eligibility),
-- `region` and `destinationRegions` (derived from the approval this row points
-- at), `resourceId` and `cloudAccountId` (the URL routes, and who pays is the
-- layer below), and anything credential, quota or priced -- section 3 makes
-- that last one a hard invariant.
--
-- ---------------------------------------------------------------------------
-- Why foreign keys as well as copies
-- ---------------------------------------------------------------------------
--
-- The copies answer what the values were. The keys stop a manifest naming a
-- deployment, endpoint or approval that never existed. RESTRICT on all three,
-- for the reason the grain columns use it: a published manifest is a record,
-- and the way to stop routing to a placement is to disable it rather than to
-- delete the rows saying it was once published.
--
-- Rollback: drop this table. Nothing else is read or written.

CREATE TABLE "RoutingIdentityManifestEntry" (
    "id" TEXT NOT NULL,
    "manifestId" TEXT NOT NULL,

    -- The placement.
    "modelDeploymentId" TEXT NOT NULL,
    "logicalModelId" TEXT NOT NULL,
    "upstreamDeploymentName" TEXT NOT NULL,
    "modelVersion" TEXT,
    "modelRevision" TEXT,
    "quantization" TEXT,
    "tokenizerRevision" TEXT,
    "qualityTier" TEXT,
    -- Canonical JSON, produced by `canonicalCapabilities()`. Text rather than
    -- jsonb because the digest covers these exact bytes, and jsonb does not
    -- promise to give back the bytes it was given.
    "capabilities" TEXT NOT NULL,
    "qualityGateStatus" TEXT NOT NULL,
    "qualityGateExpiresAt" TIMESTAMP(3),
    "deploymentEnabled" BOOLEAN NOT NULL,

    -- The endpoint it is served from.
    "providerEndpointId" TEXT NOT NULL,
    "gatewayProvider" TEXT NOT NULL,
    "servingProvider" TEXT,
    "endpointUrl" TEXT,
    "endpointResidencyClass" TEXT NOT NULL,
    "endpointEnabled" BOOLEAN NOT NULL,

    -- What it was allowed by. Null while an endpoint has no approval, which
    -- is every endpoint today.
    "residencyApprovalId" TEXT,

    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RoutingIdentityManifestEntry_pkey" PRIMARY KEY ("id")
);

-- One entry per deployment per manifest. Two would be two answers to what
-- that placement was, in a record that exists to have one.
CREATE UNIQUE INDEX "RoutingIdentityManifestEntry_manifestId_modelDeploymentId_key"
    ON "RoutingIdentityManifestEntry"("manifestId", "modelDeploymentId");

CREATE INDEX "RoutingIdentityManifestEntry_modelDeploymentId_idx"
    ON "RoutingIdentityManifestEntry"("modelDeploymentId");
CREATE INDEX "RoutingIdentityManifestEntry_residencyApprovalId_idx"
    ON "RoutingIdentityManifestEntry"("residencyApprovalId")
    WHERE "residencyApprovalId" IS NOT NULL;

-- Cascade to the manifest, RESTRICT to everything the entry describes.
--
-- Cascade is not a way to delete a manifest: the manifest's own trigger
-- refuses DELETE, so it never fires. It is here so the relation says the
-- entries belong to the publication rather than existing beside it.
ALTER TABLE "RoutingIdentityManifestEntry"
    ADD CONSTRAINT "RoutingIdentityManifestEntry_manifestId_fkey"
    FOREIGN KEY ("manifestId") REFERENCES "RoutingIdentityManifest"("id")
    ON DELETE CASCADE ON UPDATE RESTRICT;

ALTER TABLE "RoutingIdentityManifestEntry"
    ADD CONSTRAINT "RoutingIdentityManifestEntry_modelDeploymentId_fkey"
    FOREIGN KEY ("modelDeploymentId") REFERENCES "ModelDeployment"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "RoutingIdentityManifestEntry"
    ADD CONSTRAINT "RoutingIdentityManifestEntry_providerEndpointId_fkey"
    FOREIGN KEY ("providerEndpointId") REFERENCES "ProviderEndpoint"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "RoutingIdentityManifestEntry"
    ADD CONSTRAINT "RoutingIdentityManifestEntry_residencyApprovalId_fkey"
    FOREIGN KEY ("residencyApprovalId") REFERENCES "EndpointResidencyApproval"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Published once and never edited, the same as the manifest it belongs to.
-- An entry that could be rewritten would make the digest a claim about
-- whatever the row says now.
CREATE OR REPLACE FUNCTION "routing_identity_manifest_entry_is_immutable"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'RoutingIdentityManifestEntry % is published; publish a new manifest version', OLD."id"
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "routing_identity_manifest_entry_is_immutable_trigger"
    BEFORE UPDATE OR DELETE ON "RoutingIdentityManifestEntry"
    FOR EACH ROW
    EXECUTE FUNCTION "routing_identity_manifest_entry_is_immutable"();

-- TRUNCATE does not fire an ON DELETE trigger, so it walks past the row
-- trigger above and needs its own.
CREATE OR REPLACE FUNCTION "routing_identity_manifest_entry_is_not_truncatable"()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'RoutingIdentityManifestEntry is published history and cannot be truncated'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "routing_identity_manifest_entry_is_not_truncatable_trigger"
    BEFORE TRUNCATE ON "RoutingIdentityManifestEntry"
    FOR EACH STATEMENT
    EXECUTE FUNCTION "routing_identity_manifest_entry_is_not_truncatable"();

-- ---------------------------------------------------------------------------
-- The manifest's own blank test, corrected
-- ---------------------------------------------------------------------------
--
-- `RoutingIdentityManifest_approvedBy_present_check` used the six-character
-- class the cache evidence reference uses, and its comment claimed that made
-- the two sides refuse the same strings. It did not: `manifestProblems()` used
-- `String.trim()`, which strips U+00A0 and every other Unicode space, so a
-- name of one non-breaking space was refused there and accepted here.
--
-- The validator now uses the same six characters. The constraint is recreated
-- unchanged so that this file records which definition is the agreed one, and
-- so a reader of the older migration does not have to guess which side moved.
ALTER TABLE "RoutingIdentityManifest"
    DROP CONSTRAINT "RoutingIdentityManifest_approvedBy_present_check";

ALTER TABLE "RoutingIdentityManifest"
    ADD CONSTRAINT "RoutingIdentityManifest_approvedBy_present_check"
    CHECK ("approvedBy" ~ E'[^ \\t\\n\\r\\f\\v]');
