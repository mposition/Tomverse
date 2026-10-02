import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const migration = readFileSync(new URL(
  "../prisma/migrations/20261002150000_amux_cli_usage_invocation/migration.sql",
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
