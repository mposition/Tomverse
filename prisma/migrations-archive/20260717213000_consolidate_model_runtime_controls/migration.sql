ALTER TABLE "ModelRegistryEntry"
ADD COLUMN "operationalReason" TEXT,
ADD COLUMN "userVisibleNote" TEXT;

ALTER TABLE "AdminProviderIncident"
ADD COLUMN "previousModelStates" JSONB;

-- Preserve every existing runtime override while moving the source of truth
-- into ModelRegistryEntry. The legacy table is intentionally retained for one
-- rolling-deploy window, but the application no longer reads or writes it.
UPDATE "ModelRegistryEntry" AS registry
SET
  "status" = CASE
    WHEN overrides."status" = 'available' THEN registry."status"
    WHEN overrides."status" IN ('limited', 'disabled', 'coming-soon')
      THEN overrides."status"
    ELSE registry."status"
  END,
  "enabled" = CASE
    WHEN overrides."status" = 'limited' THEN TRUE
    WHEN overrides."status" IN ('disabled', 'coming-soon') THEN FALSE
    ELSE registry."enabled"
  END,
  "operationalReason" = overrides."reason",
  "userVisibleNote" = overrides."visibleNote",
  "updatedById" = COALESCE(overrides."updatedById", registry."updatedById"),
  "updatedByEmail" = COALESCE(overrides."updatedByEmail", registry."updatedByEmail"),
  "updatedAt" = GREATEST(overrides."updatedAt", registry."updatedAt")
FROM "ModelOverride" AS overrides
WHERE registry."id" = overrides."modelId";
