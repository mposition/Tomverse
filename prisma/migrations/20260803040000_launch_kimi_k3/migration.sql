-- One-time launch transition for the pre-registered Kimi K3 row. The exact
-- coming-soon predicate preserves any later operator disablement; catalogue
-- reconciliation must not re-enable an intentionally paused provider model
-- on every boot.
UPDATE "ModelRegistryEntry"
SET
  "enabled" = TRUE,
  "publiclyListed" = TRUE,
  "status" = 'enabled',
  "operationalReason" = NULL,
  "userVisibleNote" = NULL
WHERE "id" = 'kimi-k3'
  AND "enabled" = FALSE
  AND "publiclyListed" = FALSE
  AND "status" = 'coming-soon';
