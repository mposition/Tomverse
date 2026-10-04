import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../prisma/migrations/20261001102600_amux_v4_unit_decisions/migration.sql", import.meta.url),
  "utf8",
);
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");
const portfolioMigration = readFileSync(
  new URL("../prisma/migrations/20261001102100_amux_v4_portfolio_schema/migration.sql", import.meta.url),
  "utf8",
);

test("v4 owner decisions have a separate dark ledger and cannot rewrite legacy approvals", () => {
  assert.match(schema, /model AmuxIdeaUnitDecision \{/);
  assert.match(migration, /CREATE TABLE "AmuxIdeaUnitDecision"/);
  assert.doesNotMatch(migration, /ALTER TABLE "AmuxIntakeApproval"|ALTER TABLE "AmuxLocalIntakeApproval"/);
  assert.match(migration, /AmuxIdeaUnitDecision_one_prepared_per_unit/);
  assert.match(migration, /AmuxIdeaUnitDecision_one_consumed_per_unit/);
  assert.match(migration, /FOREIGN KEY \("draftUnitId", "ideaId", "actorUserId", "chunkIndex"\)/);
  assert.match(migration, /FOREIGN KEY \("sourcePreviewId", "ideaId", "chunkIndex"\)/);
  assert.match(migration, /AmuxIdeaUnitDecision_consume_source_check/);
  assert.match(migration, /current_preview_id = decision\."sourcePreviewId"/);
  assert.match(migration, /AmuxIdeaUnitDecision_action_base_check/);
  assert.match(migration, /"linkedNodeId" = "baseNodeId"/);
  assert.match(migration, /"linkedWorkItemId" = "baseWorkItemId"/);
});

test("decision receipts are keyed, expire in fifteen minutes and freeze unknown outcomes", () => {
  assert.match(migration, /"confirmationDigest" ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(migration, /"ownerSessionDigest" ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.match(migration, /INTERVAL '15 minutes'/);
  assert.match(migration, /AmuxIdeaUnitDecision_unknown_freeze_check/);
  assert.match(migration, /AmuxIdeaUnitDecision_terminal_immutable_check/);
  assert.match(migration, /AmuxIdeaUnitDecision_no_truncate_check/);
  assert.match(migration, /AmuxIdeaUnitDecision_audit_distinct_check/);
  assert.match(migration, /amux_v4_unit_audit_matches\(NEW\."finalAuditLogId"/);
  assert.match(migration, /FOREIGN KEY \("prepareAuditLogId"\) REFERENCES "AdminAuditLog"/);
  assert.match(migration, /FOREIGN KEY \("finalAuditLogId"\) REFERENCES "AdminAuditLog"/);
  assert.match(migration, /OLD\."outcomeUnknownResolvedAt" IS NOT NULL/);
  assert.match(migration, /w\."v4SourceApprovalId" = NEW\."id"/);
  assert.match(migration, /r\."decisionId" = NEW\."id"/);
});

test("unknown-effect probes use the v4 columns rather than a legacy approval source", () => {
  assert.match(portfolioMigration, /ADD COLUMN "v4SourceApprovalId" TEXT/);
  assert.match(portfolioMigration, /"decisionId" TEXT NOT NULL/);
  assert.match(schema, /v4SourceApprovalId\s+String\?/);
  assert.match(schema, /model AmuxPortfolioNodeRevision \{[^}]*decisionId\s+String/s);
  assert.doesNotMatch(portfolioMigration, /FOREIGN KEY \("v4SourceApprovalId"\)/);
  assert.doesNotMatch(portfolioMigration, /FOREIGN KEY \("decisionId"\)/);
});
