import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { PROVIDER_API_CONFIGURATION } from "../lib/modelRegistryShared.ts";

const migrationsRoot = join(process.cwd(), "prisma", "migrations");
const constraintName =
  'ADD CONSTRAINT "ModelRegistryEntry_provider_connection_allowlist_check"';

const currentProviderConstraintSql = () => {
  const candidates = readdirSync(migrationsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      name: entry.name,
      sql: readFileSync(
        join(migrationsRoot, entry.name, "migration.sql"),
        "utf8"
      ),
    }))
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
