import assert from "node:assert/strict";
import test from "node:test";
import { PROVIDER_API_CONFIGURATION } from "../lib/modelRegistryShared.ts";
import { readMigrationSqlFiles } from "./support/repositoryFiles.mjs";

const constraintName =
  'ADD CONSTRAINT "ModelRegistryEntry_provider_connection_allowlist_check"';

const currentProviderConstraintSql = () => {
  const candidates = readMigrationSqlFiles()
    .filter((entry) => entry.sql.includes(constraintName))
    .sort((left, right) => left.name.localeCompare(right.name));

  assert.ok(candidates.length > 0, "provider connection constraint is missing");
  return candidates.at(-1).sql;
};

test("the latest provider connection constraint permits every code-owned mapping", () => {
  const sql = currentProviderConstraintSql();

  for (const [provider, configuration] of Object.entries(
    PROVIDER_API_CONFIGURATION
  )) {
    assert.ok(sql.includes(`"provider" = '${provider}'`), provider);
    assert.ok(sql.includes(`"apiBaseUrl" = '${configuration.baseUrl}'`), provider);
    assert.ok(
      sql.includes(`"apiKeyEnvName" = '${configuration.apiKeyEnvName}'`),
      provider
    );
  }
});
