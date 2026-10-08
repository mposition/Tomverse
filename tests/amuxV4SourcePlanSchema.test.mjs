import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const migration = readFileSync(new URL(
  "../prisma/migrations/20261002100000_amux_v4_source_plan_revision/migration.sql",
  import.meta.url,
), "utf8");
const schema = readFileSync(new URL("../prisma/schema.prisma", import.meta.url), "utf8");

test("source-plan revisions keep ordered keyed digests without source text", () => {
  assert.match(migration, /CREATE TABLE "AmuxIdeaSourcePlanRevision"/);
  assert.match(migration, /"unitDigests" TEXT\[\] NOT NULL/);
  assert.match(migration, /amux_v4_keyed_digest_array_valid\("unitDigests"\)/);
  assert.match(migration, /cardinality\("unitDigests"\) = "sourceUnitCount"/);
  assert.match(migration, /array_ndims\("unitDigests"\) = 1/);
  assert.match(migration, /"manifestDigest" ~ '\^\[a-f0-9\]\{64\}\$'/);
  assert.doesNotMatch(schema.match(/model AmuxIdeaSourcePlanRevision \{[\s\S]*?\n\}/)?.[0] ?? "",
    /rawCiphertext|sourceText|repositoryPath|githubUrl|excerptText/);
});

test("one idea has a current plan pointer and one immutable ordered revision chain", () => {
  assert.match(migration, /"AmuxIdeaSourcePlanRevision_ideaId_revisionNumber_key"/);
  assert.match(migration, /"AmuxIdeaSourcePlanRevision_predecessorId_key"/);
  assert.match(migration, /"predecessorId" <> "id"/);
  assert.match(migration, /"AmuxIdeaSourcePlanRevision_ideaId_startChunkIndex_key"/);
  assert.match(migration, /"AmuxIdeaSourcePlanRevision_one_active_per_idea"/);
  assert.match(migration, /"AmuxIdeaSourcePlanRevision_creationAuditLogId_key"/);
  assert.match(migration, /AmuxIdeaSourcePlanRevision_predecessor_order_check/);
  assert.match(migration, /'awaiting_owner', 'superseded', 'complete', 'cancelled'/);
  assert.match(migration, /"AmuxIdeaSubmission_currentSourcePlanRevisionId_id_fkey"/);
  assert.match(migration, /AmuxIdeaSourcePlanRevision_identity_immutable_check/);
  assert.match(migration, /AmuxIdeaSourcePlanRevision_transition_check/);
  assert.match(schema, /currentSourcePlanRevisionId String\?/);
});

test("plan-bound previews and chunks cannot name a different idea or plan", () => {
  assert.match(migration,
    /FOREIGN KEY \("sourcePlanRevisionId", "ideaId", "planStartChunkIndex"\)[\s\S]*?REFERENCES "AmuxIdeaSourcePlanRevision"\("id", "ideaId", "startChunkIndex"\)/);
  assert.match(migration,
    /FOREIGN KEY \("ideaId", "chunkIndex", "sourcePlanRevisionId"\)[\s\S]*?REFERENCES "AmuxIdeaAnalysisChunk"\("ideaId", "chunkIndex", "sourcePlanRevisionId"\)/);
  assert.match(migration, /"chunkIndex" = "planStartChunkIndex" \+ "revisionChunkIndex"/);
  assert.match(migration, /AmuxIdeaAnalysisChunk_plan_chunk_key/);
  assert.match(migration, /AmuxIdeaTransferPreview_plan_unit_check/);
  assert.match(migration, /AmuxIdeaAnalysisChunk_current_preview_plan_fkey/);
  assert.match(migration, /AmuxIdeaAnalysisChunk_plan_immutable_check/);
  assert.match(migration, /AmuxIdeaAnalysisChunk_cursor_immutable_check/);
});

test("output continuation metadata is stored separately from model prose", () => {
  assert.match(migration, /"coverageStatus" TEXT/);
  assert.match(migration, /AmuxIdeaAnalysisChunk_cursor_check" CHECK \(COALESCE\(/);
  assert.match(migration, /"continuationKind" TEXT/);
  assert.match(migration, /"outputPartIndex" INTEGER/);
  assert.match(migration, /"outputPending" BOOLEAN/);
  assert.match(migration, /"remainingStartOrdinal" = "coveredEndOrdinal"/);
  assert.match(migration, /"remainingStartOrdinal" = "coveredEndOrdinal" \+ 1/);
  assert.match(migration, /"continuationKind" IS NULL OR "continuationKind" = 'input'/);
  assert.doesNotMatch(migration, /\bINSERT\s+INTO\b|\bUPDATE\s+"AmuxWorkItem"\b|\bALTER\s+TABLE\s+"Conversation"\b/i);
});
