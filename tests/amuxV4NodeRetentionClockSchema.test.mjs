import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../prisma/migrations/20261001102500_amux_v4_node_retention_clock/migration.sql", import.meta.url),
  "utf8",
);
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

test("v4 node archive records a database-owned immutable 90-day retention clock", () => {
  assert.match(schema, /model AmuxPortfolioNode \{[^}]*?archivedAt\s+DateTime\?/);
  assert.match(schema, /model AmuxPortfolioNode \{[^}]*?contentPurgeAfter\s+DateTime\?/);
  assert.match(migration, /ADD COLUMN "archivedAt" TIMESTAMP\(3\)/);
  assert.match(migration, /ADD COLUMN "contentPurgeAfter" TIMESTAMP\(3\)/);
  assert.match(migration, /AmuxPortfolioNode_retention_clock_check/);
  assert.match(migration, /"contentPurgeAfter" = "archivedAt" \+ INTERVAL '90 days'/);
  assert.match(migration, /NEW\."archivedAt" := db_now/);
  assert.match(migration, /AmuxPortfolioNode_retention_clock_immutable_check/);
  assert.match(migration, /BEFORE INSERT OR UPDATE ON "AmuxPortfolioNode"/);
  assert.doesNotMatch(migration, /\bDELETE\s+FROM\b|DROP\s+CONSTRAINT|ALTER\s+COLUMN\s+"titleCiphertext"/i);
});
