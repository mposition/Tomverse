import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const migrationName = "20261001111800_amux_v4_frontier_model_catalog";
const migrationRoot = new URL("../prisma/migrations/", import.meta.url);
const migration = readFileSync(new URL(`${migrationName}/migration.sql`, migrationRoot), "utf8");
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

test("Frontier catalog is dark, additive and does not seed model names", () => {
  assert.match(schema, /model AmuxIdeaFrontierModelApproval \{/);
  assert.match(schema, /one active approval per provider\/model\.\nmodel AmuxIdeaFrontierModelApproval \{/);
  assert.match(schema, /no plain SHA-256 of a short idea is retained\.\nmodel AmuxIdeaSubmission \{/);
  assert.match(migration, /CREATE TABLE "AmuxIdeaFrontierModelApproval"/);
  assert.doesNotMatch(migration, /\bINSERT\s+INTO\b|\bUPDATE\s+"AmuxWorkItem"|\bALTER\s+TABLE\s+"AmuxIdeaSubmission"/i);
  assert.doesNotMatch(migration, /gpt-6|claude-|opus|fable/i);
  assert.match(migration, /"provider" IN \('openai', 'anthropic'\)/);
  assert.match(migration, /"status" IN \('approved', 'revoked'\)/);
});

test("approval and revocation require distinct actor-bound audit records", () => {
  assert.match(migration, /FOREIGN KEY \("approvalAuditLogId"\) REFERENCES "AdminAuditLog"/);
  assert.match(migration, /FOREIGN KEY \("revocationAuditLogId"\) REFERENCES "AdminAuditLog"/);
  assert.match(migration, /amux\.idea\.frontier_model\.approved/);
  assert.match(migration, /amux\.idea\.frontier_model\.revoked/);
  assert.match(migration, /"targetId" IS DISTINCT FROM NEW\."id"/);
  assert.match(migration, /entryHash" ~ '\^\[a-f0-9\]\{64\}\$'\) IS DISTINCT FROM TRUE/);
  assert.match(migration, /OLD\."status" <> 'approved' OR NEW\."status" <> 'revoked'/);
  assert.match(migration, /BEFORE TRUNCATE ON "AmuxIdeaFrontierModelApproval"/);
  assert.match(migration, /current_setting\('transaction_isolation'\) <> 'read committed'/);
  assert.match(migration, /EXISTS \(SELECT 1 FROM public\."AmuxIdeaFrontierModelApproval" LIMIT 1\)/);
  assert.match(migration, /AmuxIdeaFrontierModelApproval_one_active_model/);
  assert.match(migration, /amux_v4_frontier_duplicate_effort_refused/);
});

test("later migrations cannot remove the one-active Frontier invariant", () => {
  for (const entry of readdirSync(migrationRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name <= migrationName) continue;
    const later = readFileSync(new URL(`${entry.name}/migration.sql`, migrationRoot), "utf8");
    assert.doesNotMatch(later,
      /DROP\s+INDEX(?:\s+IF\s+EXISTS)?\s+"AmuxIdeaFrontierModelApproval_one_active_model"/i,
      entry.name);
    assert.doesNotMatch(later,
      /DROP\s+TABLE(?:\s+IF\s+EXISTS)?\s+"AmuxIdeaFrontierModelApproval"|DROP\s+TRIGGER[^;]*"AmuxIdeaFrontierModelApproval_guard"|ALTER\s+TABLE[^;]*"AmuxIdeaFrontierModelApproval"[^;]*DISABLE\s+TRIGGER|CREATE\s+OR\s+REPLACE\s+FUNCTION\s+amux_v4_frontier_model_approval_guard/i,
      entry.name);
  }
});
