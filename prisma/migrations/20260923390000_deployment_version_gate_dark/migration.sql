-- Model version gate, dark.
--
-- ADR v2.1 section 3.3. The columns exist so a placement can say which
-- revision it is pinned to, and so a published manifest can copy that
-- answer. Nothing routes from them. ModelDeployment and
-- RoutingIdentityManifestEntry stay on the dark-table list.
--
-- `strong` never drifts, including when allowVersionDrift is set. The
-- default is strong and drift off, so a row that predates this migration
-- cannot move to another revision by omission.
--
-- qualityBenchmarkVersion is part of what a pass means, so the identity
-- trigger refuses to change it on an enabled row, together with the pin.
-- qualityLastVerifiedAt is the clock of a re-check of that same benchmark
-- and may move while the row stays enabled. It is still copied into a
-- manifest, because a publication has to say when the evidence was current.

ALTER TABLE "ModelDeployment"
    ADD COLUMN "versionPinStrength" TEXT NOT NULL DEFAULT 'strong',
    ADD COLUMN "allowVersionDrift" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "qualityBenchmarkVersion" TEXT,
    ADD COLUMN "qualityLastVerifiedAt" TIMESTAMP(3);

ALTER TABLE "ModelDeployment"
    ADD CONSTRAINT "ModelDeployment_versionPinStrength_check"
    CHECK ("versionPinStrength" IN ('strong', 'weak', 'alias_only'));

ALTER TABLE "RoutingIdentityManifestEntry"
    ADD COLUMN "versionPinStrength" TEXT NOT NULL DEFAULT 'strong',
    ADD COLUMN "allowVersionDrift" BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN "qualityBenchmarkVersion" TEXT,
    ADD COLUMN "qualityLastVerifiedAt" TIMESTAMP(3);

ALTER TABLE "RoutingIdentityManifestEntry"
    ADD CONSTRAINT "RoutingIdentityManifestEntry_versionPinStrength_check"
    CHECK ("versionPinStrength" IN ('strong', 'weak', 'alias_only'));

-- Same rule as 20260923120000, with the pin and the benchmark added.
-- Changing those on an enabled row would keep a pass that no longer
-- describes the placement. Disable and re-gate first.
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
        OR NEW."versionPinStrength" IS DISTINCT FROM OLD."versionPinStrength"
        OR NEW."allowVersionDrift" IS DISTINCT FROM OLD."allowVersionDrift"
        OR NEW."qualityBenchmarkVersion" IS DISTINCT FROM OLD."qualityBenchmarkVersion"
    ) THEN
        RAISE EXCEPTION
            'ModelDeployment % cannot change what it is while enabled; disable and re-gate it', OLD."id"
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
