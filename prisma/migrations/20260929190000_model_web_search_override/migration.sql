-- Per-model web search override, set from the Admin Console
-- (lib/webSearchOverride.ts, docs/policy/credit-and-cost-limits.md).
--
-- Expand-only. Nullable with no default and no backfill: NULL means "follow the
-- code", which is exactly what every model does today, so this migration
-- changes no model's behaviour on deploy. Seeding and reconciliation never
-- write the column; only an administrator's save does.
ALTER TABLE "ModelRegistryEntry" ADD COLUMN "webSearchOverride" TEXT;

-- Closed list. There is deliberately no value for a provider's native search
-- tool: its cost ceiling is verified per model in code, not chosen in a form.
ALTER TABLE "ModelRegistryEntry"
    ADD CONSTRAINT "ModelRegistryEntry_webSearchOverride_check"
    CHECK ("webSearchOverride" IS NULL OR "webSearchOverride" IN ('off', 'app-managed'));
