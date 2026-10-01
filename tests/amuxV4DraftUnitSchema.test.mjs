import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../prisma/migrations/20261001102300_amux_v4_draft_units/migration.sql", import.meta.url),
  "utf8",
);
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

test("v4 proposal units are independently encrypted and cannot coexist with a monolithic draft body", () => {
  assert.match(migration, /CREATE TABLE "AmuxIdeaDraftUnit"/);
  assert.match(migration, /AmuxIdeaAnalysisChunk_no_monolithic_draft_check/);
  assert.match(migration, /"draftCiphertext" IS NULL AND "draftKeyId" IS NULL AND "draftKeyVersion" IS NULL/);
  assert.match(migration, /"bodyCiphertext" BYTEA/);
  assert.match(migration, /"bodyKeyId" TEXT/);
  assert.match(migration, /"bodyDigestKeyId" TEXT NOT NULL/);
  assert.match(schema, /model AmuxIdeaDraftUnit \{/);
});

test("unit identity, owner and independent purge state are database-bound", () => {
  assert.match(migration, /UNIQUE INDEX "AmuxIdeaDraftUnit_ideaId_chunkIndex_unitIndex_key"/);
  assert.match(migration, /FOREIGN KEY \("ideaId", "actorUserId"\) REFERENCES "AmuxIdeaSubmission"\("id", "actorUserId"\)/);
  assert.match(migration, /FOREIGN KEY \("ideaId", "chunkIndex"\) REFERENCES "AmuxIdeaAnalysisChunk"\("ideaId", "chunkIndex"\)/);
  assert.match(migration, /"state" IN \('proposed', 'approved', 'rejected', 'expired'\)/);
  assert.match(migration, /"expiresAt" TIMESTAMP\(3\) NOT NULL/);
  assert.match(migration, /NEW\."expiresAt" := completed_at \+ INTERVAL '30 days'/);
  assert.match(migration, /BEFORE INSERT OR UPDATE ON "AmuxIdeaAnalysisChunk"/);
  assert.match(migration, /AmuxIdeaAnalysisChunk_completion_future_check/);
  assert.match(migration, /AmuxIdeaDraftUnit_insert_expired_check/);
  assert.match(migration, /BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaDraftUnit"/);
  assert.match(migration, /AmuxIdeaDraftUnit_no_delete_check/);
  assert.match(migration, /"state" = 'expired' AND "finalDecisionAt" IS NULL AND "bodyPurgeAfter" = "expiresAt"/);
  assert.match(migration, /"bodyPurgedAt" >= "bodyPurgeAfter"/);
  assert.match(migration, /AmuxIdeaDraftUnit_no_resurrection_check/);
  assert.match(migration, /AmuxIdeaAnalysisChunk_completion_immutable/);
});
