import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AMUX_TASK_ROLE_PROPOSALS } from "../lib/amux/ideaAnalysisChunkCore.ts";
import { AMUX_CLI_USAGE_WORKER_ROLES } from "../lib/amux/cliUsageRoleCore.ts";

const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const migration = readFileSync(new URL(
  "../prisma/migrations/20261002150000_amux_cli_usage_invocation/migration.sql",
  import.meta.url,
), "utf8");
const roleMigration = readFileSync(new URL(
  "../prisma/migrations/20261002170000_amux_cli_usage_role_snapshot/migration.sql",
  import.meta.url,
), "utf8");
const yearFenceMigration = readFileSync(new URL(
  "../prisma/migrations/20261002190000_amux_cli_usage_year_insert_fence/migration.sql",
  import.meta.url,
), "utf8");

test("the v22/v23 CLI receipt is separate from credits and cost reservations", () => {
  assert.match(schema, /model AmuxCliUsageInvocation \{/);
  assert.doesNotMatch(schema, /model AmuxCliUsageModel \{/);
  assert.match(schema, /modelsJson\s+Json/);
  assert.match(schema, /recordedAt\s+DateTime @default\(now\(\)\) @db\.Timestamptz\(3\)/);
  assert.match(schema, /@@index\(\[recordedAt, invocationId\]\)/);
  assert.doesNotMatch(migration, /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|FROM)?\s*"(?:Credit|ChatCredit|AmuxCostLedger)/i);
  assert.doesNotMatch(migration, /(?:prompt|transcript|responseBody|credential|secret)"\s+(?:TEXT|BYTEA|JSONB)/i);
});

test("the database owns the retention clock and refuses receipt rewrites", () => {
  assert.match(migration, /BEFORE INSERT ON "AmuxCliUsageInvocation"/);
  assert.match(migration, /NEW\."recordedAt" := clock_timestamp\(\)/);
  assert.match(migration, /BEFORE UPDATE ON "AmuxCliUsageInvocation"/);
  assert.match(migration, /"recordedAt", "invocationId"/);
  assert.doesNotMatch(migration, /CREATE TABLE "AmuxCliUsageModel"/);
});

test("unknown usage is nullable, never represented as zero by default", () => {
  for (const field of ["inputTokens", "outputTokens", "cacheReadInputTokens",
    "cacheCreationInputTokens", "reasoningOutputTokens"]) {
    assert.match(schema, new RegExp(`${field}\\s+BigInt\\?`));
  }
  assert.match(migration, /"completeness" = 'unknown' AND "inputTokens" IS NULL/);
  assert.match(migration, /"cli" = 'codex' AND "cacheCreationInputTokens" IS NULL/);
  assert.match(migration, /"cli" = 'claude' AND "reasoningOutputTokens" IS NULL/);
  assert.doesNotMatch(migration, /"(?:inputTokens|outputTokens|cacheReadInputTokens)" BIGINT (?:NOT NULL )?DEFAULT 0/);
});

test("the migration is additive and has no collection or runtime enablement", () => {
  assert.doesNotMatch(migration, /^\s*(?:DROP\b|TRUNCATE\b|ALTER TABLE\b|INSERT INTO\b|UPDATE\s+"|DELETE FROM\b)/im);
  assert.doesNotMatch(migration, /(?:TOMVERSE_AMUX|feature\.|AppSetting)/);
  assert.match(migration, /CREATE TABLE "AmuxCliUsageInvocation"/);
  assert.match(migration, /CREATE FUNCTION amux_cli_usage_models_valid\(/);
  assert.match(migration, /"AmuxCliUsageInvocation_models_check" CHECK/);
  assert.match(migration, /"AmuxCliUsageInvocation_identifiers_check" CHECK/);
  assert.match(migration, /jsonb_array_length\(payload\) > 16/);
  assert.match(migration, /model_name = ANY\(seen\)/);
  assert.match(migration, /RETURN usage_completeness = 'reported_partial'/);
  assert.ok(migration.includes(String.raw`model_name ~ '(^/|/$|//|(^|/)\.{1,2}(/|$))'`));
  assert.ok(migration.includes(String.raw`"selectedModelId" !~ '(^/|/$|//|(^|/)\.{1,2}(/|$))'`));
});

test("the dark role snapshot requires an empty receipt table and has no default", () => {
  assert.match(schema, /workerRole\s+String\s+@db\.VarChar\(32\)/);
  assert.match(roleMigration, /ADD COLUMN "workerRole" VARCHAR\(32\) NOT NULL/);
  assert.doesNotMatch(roleMigration, /ADD COLUMN "workerRole"[^\n]*\bDEFAULT\b|INSERT INTO|UPDATE\s+"AmuxCliUsageInvocation"/i);
  assert.match(roleMigration, /"contextKind" = 'idea_analysis' AND "workerRole" = 'idea_analysis'/);
  assert.match(roleMigration, /"AmuxCliUsageInvocation_workerRole_context_check" CHECK/);
});

test("the usage role vocabulary tracks approved Task roles plus idea analysis", () => {
  assert.deepEqual(AMUX_CLI_USAGE_WORKER_ROLES.filter((role) => role !== "idea_analysis"),
    AMUX_TASK_ROLE_PROPOSALS);
  assert.equal(AMUX_CLI_USAGE_WORKER_ROLES.at(-1), "idea_analysis");
});

test("an inserted receipt keeps its year lock until commit and refuses a sealed year", () => {
  // The replaced original is only a DB clock stamp, and its trigger is INSERT
  // only. Pin both sides so replacement cannot silently drop older behavior.
  assert.match(migration, /CREATE FUNCTION amux_cli_usage_set_recorded_at\(\)[\s\S]*?NEW\."recordedAt" := clock_timestamp\(\);\s*RETURN NEW;\s*END;/);
  assert.match(migration, /CREATE TRIGGER "AmuxCliUsageInvocation_set_recordedAt"\s+BEFORE INSERT ON "AmuxCliUsageInvocation"\s+FOR EACH ROW/);
  assert.match(yearFenceMigration, /CREATE OR REPLACE FUNCTION amux_cli_usage_set_recorded_at/);
  assert.match(yearFenceMigration, /NEW\."recordedAt" := clock_timestamp\(\)/);
  assert.match(yearFenceMigration, /current_setting\('transaction_isolation'\) <> 'read committed'/);
  assert.match(yearFenceMigration, /"recordedAt" AT TIME ZONE 'UTC'/);
  assert.match(yearFenceMigration, /pg_advisory_xact_lock_shared\(1095587160, usage_year\)/);
  assert.match(yearFenceMigration, /"providerScopeKey" = ''actualProviderUnknown''/);
  assert.match(yearFenceMigration, /IF year_sealed THEN/);
  assert.match(yearFenceMigration, /ERRCODE = 'AX005'/);
  assert.doesNotMatch(yearFenceMigration, /\b(?:INSERT INTO|UPDATE|DELETE FROM|TRUNCATE)\b/i);
});
