import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(
  new URL("../prisma/migrations/20261001102300_amux_v4_draft_units/migration.sql", import.meta.url),
  "utf8",
);
const localRefMigration = readFileSync(
  new URL("../prisma/migrations/20261001102400_amux_v4_draft_local_ref/migration.sql", import.meta.url),
  "utf8",
);
const originExpiryMigration = readFileSync(
  new URL("../prisma/migrations/20261003150000_amux_v4_draft_origin_expiry/migration.sql", import.meta.url),
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

test("v4 draft local references are idea-unique, kind- and chunk-bound, and immutable", () => {
  assert.match(schema, /model AmuxIdeaDraftUnit \{[^}]*?localRef\s+String\?/);
  assert.match(schema, /@@unique\(\[ideaId, localRef\]\)/);
  assert.match(localRefMigration, /ADD COLUMN "localRef" TEXT/);
  assert.match(localRefMigration, /AmuxIdeaDraftUnit_local_ref_shape_check/);
  assert.match(localRefMigration, /length\("localRef"\) <= 128/);
  assert.match(localRefMigration, /\[0-9\]\{0,3\}/);
  assert.match(localRefMigration, /split_part\("localRef", ':', 1\) = 'c' \|\| "chunkIndex"::text/);
  assert.match(localRefMigration, /split_part\(split_part\("localRef", ':', 2\), '-', 1\) = "unitKind"/);
  assert.match(localRefMigration, /UNIQUE INDEX "AmuxIdeaDraftUnit_ideaId_localRef_key"/);
  assert.match(localRefMigration, /AmuxIdeaDraftUnit_local_ref_required_check/);
  assert.match(localRefMigration, /AmuxIdeaDraftUnit_local_ref_immutable_check/);
});

test("later analysis pages inherit the first page's absolute 30-day decision deadline", () => {
  assert.match(originExpiryMigration, /CREATE OR REPLACE FUNCTION amux_v4_draft_unit_guard\(\)/);
  assert.match(originExpiryMigration, /first_chunk\."chunkIndex" = 0/);
  assert.match(originExpiryMigration, /NEW\."expiresAt" := first_completed_at \+ INTERVAL '30 days'/);
  assert.match(originExpiryMigration, /db_now >= first_completed_at \+ INTERVAL '30 days'/);
  assert.match(originExpiryMigration, /AmuxIdeaDraftUnit_origin_expiry_precheck/);
  assert.doesNotMatch(originExpiryMigration,
    /NEW\."expiresAt" := completed_at \+ INTERVAL '30 days'/);
});
