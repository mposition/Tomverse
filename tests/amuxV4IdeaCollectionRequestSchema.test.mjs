import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const schema = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
const migration = readFileSync(join(process.cwd(),
  "prisma/migrations/20261003180000_amux_v4_idea_collection_request/migration.sql"), "utf8");

test("dark collection request binds one source, approved model identity and audit", () => {
  const model = schema.match(/model AmuxIdeaCollectionRequest \{[\s\S]*?\n\}/)?.[0];
  assert.ok(model);
  for (const field of ["requestId", "ideaId", "actorUserId", "sourceScopeApprovalId",
    "frontierApprovalId", "frontierVersion", "provider", "modelId", "reasoningEffort",
    "sourceIndex", "previewId", "attempt", "requestDigest", "requestDigestKeyId",
    "leaseGeneration", "resultCiphertext", "resultDigest", "resultPurgeAfter",
    "creationAuditLogId", "transitionAuditLogId"]) {
    assert.match(model, new RegExp(`\\b${field}\\b`));
  }
  assert.match(model, /fields: \[ideaId, actorUserId\], references: \[id, actorUserId\]/);
  assert.match(model, /fields: \[sourceScopeApprovalId, ideaId\], references: \[id, ideaId\]/);
  assert.match(model, /fields: \[frontierApprovalId, provider, modelId, frontierVersion\]/);
  assert.doesNotMatch(model, /\b(?:rawIdea|sourceBody|githubToken|creditAccountId)\b/);
  assert.match(migration, /"sourceKind" = 'repository_file' AND "sourceByteLimit" = 8192/);
  assert.match(migration, /"sourceIndex" BETWEEN 0 AND 63/);
  assert.match(migration, /"expiresAt" \+ INTERVAL '24 hours'/);
  assert.match(migration, /amux_collection_late_result_refused/);
  assert.match(migration, /amux_collection_initial_result_required/);
  assert.match(migration, /amux_collection_same_state_lease_refused/);
  assert.match(migration, /amux_collection_same_state_audit_refused/);
  assert.match(migration, /amux_collection_purge_audit_refused/);
  assert.match(migration, /amux_collection_identity_immutable/);
  assert.doesNotMatch(migration, /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?"(?:Conversation|CreditLot|AdminAuditLog)"/i);
});
