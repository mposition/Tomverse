-- Per-model file-tool tick, set from the Admin Console
-- (lib/generatedArtifactToolPolicy.ts, docs/policy/generated-artifacts.md).
--
-- Expand-only. Nullable with no default and no backfill: NULL means "follow the
-- code" (the verified register, then the provider rule), so the column itself
-- changes nothing on deploy. Seeding and reconciliation never write it; only
-- an administrator's save does.
ALTER TABLE "ModelRegistryEntry" ADD COLUMN "fileToolsOverride" BOOLEAN;
