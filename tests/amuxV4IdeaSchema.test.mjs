import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));
const migrationRoot = path.join(root, "prisma", "migrations");
const migrationName = "20261001102000_amux_v4_idea_schema";
const sql = readFileSync(path.join(migrationRoot, migrationName, "migration.sql"), "utf8");
const portfolioMigrationName = "20261001102100_amux_v4_portfolio_schema";
const portfolioSql = readFileSync(path.join(migrationRoot, portfolioMigrationName, "migration.sql"), "utf8");
const schema = readFileSync(path.join(root, "prisma", "schema.prisma"), "utf8");

test("v4 idea schema is inert and does not change existing AMUX rows", () => {
  assert.doesNotMatch(sql, /(?:ALTER|UPDATE|DELETE)\s+(?:TABLE\s+)?"AmuxWorkItem"/i);
  assert.doesNotMatch(sql, /\bINSERT\s+INTO\b/i);
  assert.match(sql, /CREATE TABLE "AmuxIdeaSubmission"/);
  assert.match(sql, /CREATE TABLE "AmuxIdeaAnalysisChunk"/);
  assert.match(sql, /"analysisDeadlineAt" = "submittedAt" \+ INTERVAL '7 days'/);
});

test("v4 digests have key ids and undecided draft purge has no default", () => {
  for (const name of ["raw", "scope", "payload", "draft"]) {
    assert.match(sql, new RegExp(`"${name}DigestKeyId"`));
    assert.match(schema, new RegExp(`\\b${name}DigestKeyId\\s+String`));
  }
  assert.match(sql, /HMAC-SHA256/);
  assert.match(sql, /"bodyPurgeAfter" TIMESTAMP\(3\),/);
  assert.doesNotMatch(sql, /"bodyPurgeAfter"[^\n]*DEFAULT/i);
  assert.doesNotMatch(sql, /"attempt"\s+BETWEEN\s+\d+\s+AND\s+3/i);
});

test("v4 source, confirmation and chunk boundaries have database relations", () => {
  assert.match(sql, /FOREIGN KEY \("ideaId", "actorUserId"\) REFERENCES "AmuxIdeaSubmission"\("id", "actorUserId"\)/);
  assert.match(sql, /"AmuxIdeaAnalysisChunk_ideaId_actorUserId_fkey"\s+FOREIGN KEY \("ideaId", "actorUserId"\) REFERENCES "AmuxIdeaSubmission"\("id", "actorUserId"\)/);
  assert.match(sql, /FOREIGN KEY \("ideaId", "confirmedByUserId"\)/);
  assert.match(sql, /FOREIGN KEY \("sourceScopeApprovalId", "ideaId"\)/);
  assert.match(sql, /FOREIGN KEY \("ideaId", "chunkIndex"\)\s+REFERENCES "AmuxIdeaAnalysisChunk"/);
  assert.match(sql, /FOREIGN KEY \("currentPreviewId", "ideaId", "chunkIndex"\)/);
  assert.match(sql, /"consumedAt" <= "confirmExpiresAt"/);
  assert.match(sql, /"state" <> 'in_flight' OR "currentPreviewId" IS NOT NULL/);
  assert.match(sql, /"state" <> 'decided' OR "finalDecisionAt" IS NOT NULL/);
  assert.match(sql, /"analysisCompletedAt" IS NULL OR "state" IN \('awaiting_owner', 'completed', 'cancelled'\)/);
});

test("future migrations may not drop the one-active-transfer index", () => {
  const names = readdirSync(migrationRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name > migrationName)
    .map((entry) => entry.name)
    .filter((name) => existsSync(path.join(migrationRoot, name, "migration.sql")))
    .sort();
  for (const name of names) {
    const laterSql = readFileSync(path.join(migrationRoot, name, "migration.sql"), "utf8");
    assert.doesNotMatch(laterSql, /DROP\s+INDEX(?:\s+IF\s+EXISTS)?\s+"AmuxIdeaTransferPreview_one_active_per_chunk"/i, name);
  }
});

test("v4 portfolio schema leaves legacy cards and plaintext briefs unchanged", () => {
  assert.doesNotMatch(portfolioSql, /\bUPDATE\s+"AmuxWorkItem"/i);
  assert.doesNotMatch(portfolioSql, /DROP\s+CONSTRAINT\s+"AmuxWorkItem_execution_brief_pair_check"/i);
  assert.doesNotMatch(portfolioSql, /DROP\s+CONSTRAINT\s+"AmuxWorkItem_sourced_todo_has_brief_check"/i);
  assert.match(portfolioSql, /"sourceSystem" IS DISTINCT FROM 'admin-idea-v4'/);
  assert.match(portfolioSql, /"executionBrief" IS NULL AND "executionBriefDigest" IS NULL/);
  assert.match(portfolioSql, /"v4BriefCiphertext" BYTEA/);
  assert.match(portfolioSql, /"v4TitleCiphertext" BYTEA/);
  assert.match(portfolioSql, /existing sourced-todo CHECK still rejects v4 encrypted-brief Todo/i);
});

test("v4 hierarchy nodes are non-runnable and parent level is checked", () => {
  assert.match(portfolioSql, /"level" IN \('initiative', 'epic', 'feature'\)/);
  assert.match(portfolioSql, /epic requires an active initiative parent/);
  assert.match(portfolioSql, /feature requires an active epic parent/);
  assert.match(portfolioSql, /portfolio revisions are append-only/);
  assert.match(portfolioSql, /"cardType" IS DISTINCT FROM 'story' OR/);
  assert.match(portfolioSql, /"status" NOT IN \('todo', 'doing', 'review'\)/);
  assert.match(portfolioSql, /"AmuxWorkItem_v4_phase_b_inert_check"/);
  assert.match(portfolioSql, /"AmuxWorkItem_v4_source_snapshot_shape_check"/);
  assert.match(portfolioSql, /BEFORE TRUNCATE ON "AmuxPortfolioNodeRevision"/);
});
