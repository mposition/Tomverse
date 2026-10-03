import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { AMUX_V4_COLLECTION_RESULT_PURGE_ACTION,
  AMUX_V4_COLLECTION_RESULT_PURGE_SCOPE,
  AMUX_V4_IDEA_SYSTEM_ACTOR } from "@/lib/adminAuditSystemActors";
import { commitAmuxCollectionClaim } from "@/lib/amux/ideaCollectionClaimService";
import { commitAmuxIdeaCollectionRequest } from "@/lib/amux/ideaCollectionRequestService";
import { commitAmuxCollectionResult } from "@/lib/amux/ideaCollectionResultService";
import { commitAmuxCollectionResultPurge,
  readAmuxCollectionResultPurgeOutcome } from
  "@/lib/amux/ideaCollectionResultPurgeService";
import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { commitIdeaSubmission } from "@/lib/amux/ideaSubmissionService";
import { inspectFrontierCatalogWrite } from "@/lib/amux/ideaFrontierCatalogWriteCore";
import { commitFrontierCatalogDecision } from "@/lib/amux/ideaFrontierCatalogWrite";
import { commitAmuxSourceScopeApproval } from "@/lib/amux/ideaSourceScopeApprovalService";
import { previewAmuxSourceScopeInTransaction } from
  "@/lib/amux/ideaSourceScopePreviewService";
import { prisma } from "@/lib/prisma";

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" || process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: collection purge test requires a dedicated loopback test database");
}

const actorUserId = `synthetic-amux-owner-${randomUUID()}`;
const actorEmail = "amux-v4-purge-synthetic@example.test";
process.env.ADMIN_USER_IDS = actorUserId;
process.env.ADMIN_EMAILS = actorEmail;
process.env.ADMIN_OWNER_EMAILS = actorEmail;
process.env.ADMIN_AUDIT_INTEGRITY_KEY = `synthetic-audit-${randomUUID()}`;
const session = { user: { id: actorUserId, email: actorEmail,
  authenticatedAt: new Date().toISOString() },
expires: new Date(Date.now() + 60 * 60_000).toISOString() } as Session;
const request = new Request("https://tomverse.test/api/admin/amux/ideas/collection-requests",
  { method: "POST" });
const keys = { masterKeyId: "synthetic-master", masterKeyVersion: 1,
  masterKey: randomBytes(32), digestKeyId: "synthetic-digest", digestKey: randomBytes(32) };
after(async () => { await prisma.$disconnect(); });

async function readyResult() {
  const ideaId = randomUUID();
  const scopeApprovalId = randomUUID();
  const frontierApprovalId = randomUUID();
  const requestId = randomUUID();
  const previewId = randomUUID();
  const modelId = `synthetic-frontier-${randomUUID()}`;
  const submitted = inspectAmuxIdeaSubmission(JSON.stringify({ version: 1,
    requestId: randomUUID(), input: { version: 1,
      idea: "SYNTHETIC_PURGE_IDEA", repositories: ["mposition/Tomverse"],
      pullRequests: [] } }));
  if (!submitted.ok) throw new Error(submitted.code);
  const scopeJson = JSON.stringify({ version: 1, sources: [{ kind: "repository_file",
    repository: "mposition/Tomverse", commitSha: "a".repeat(40),
    path: "lib/amux/ideaSourceScopeCore.ts" }] });
  const decision = inspectFrontierCatalogWrite(JSON.stringify({ schemaVersion: 1,
    action: "approve", approvalId: frontierApprovalId, provider: "openai",
    modelId, allowedEfforts: ["high"], expectedPreviousVersion: 0,
    ownerConfirmedFrontierEligibility: true }));
  if (!decision.ok) throw new Error(decision.code);
  const created = await prisma.$transaction(async (tx) => {
    await commitIdeaSubmission(tx, { session, request, inspected: submitted, ideaId, keys });
    const preview = await previewAmuxSourceScopeInTransaction(tx, actorUserId,
      { schemaVersion: 1, ideaId, scopeJson }, keys);
    await commitAmuxSourceScopeApproval(tx, { session, request, choice: {
      schemaVersion: 1, approvalId: scopeApprovalId, ideaId,
      ideaDigest: preview.ideaDigest, canonicalScopeJson: preview.canonicalScopeJson,
      scopeDigest: preview.scopeDigest, scopeDigestKeyId: preview.scopeDigestKeyId,
    }, keys });
    await commitFrontierCatalogDecision(tx, { session, request,
      decision: decision.request });
    return commitAmuxIdeaCollectionRequest(tx, { session, request, choice: {
      schemaVersion: 1, requestId, previewId, ideaId, scopeApprovalId,
      frontierApprovalId, frontierVersion: 1, provider: "openai", modelId,
      reasoningEffort: "high", sourceIndex: 0, attempt: 1,
      sourceByteLimit: 8_192,
    }, keys });
  }, { maxWait: 5_000, timeout: 15_000 });
  const claim = await prisma.$transaction((tx) =>
    commitAmuxCollectionClaim(tx, created.id, keys),
  { maxWait: 3_000, timeout: 12_000 });
  const excerpt = "export const x=1;\n";
  const result = await prisma.$transaction((tx) => commitAmuxCollectionResult(tx, {
    schemaVersion: 1, collectionRequestId: created.id, requestId, previewId,
    requestDigest: created.requestDigest, leaseId: claim.leaseId,
    leaseGeneration: 1, outcome: "preview_candidate", source: {
      sourceIndex: 0, repositoryId: 123, refName: "refs/heads/develop",
      refObjectSha: "a".repeat(40), refCommitSha: "a".repeat(40),
      commitSha: "a".repeat(40), path: "lib/amux/ideaSourceScopeCore.ts",
      blobSha: "b".repeat(40), fileSha256: "c".repeat(64), startByte: 0,
      endByte: Buffer.byteLength(excerpt, "utf8"), excerptText: excerpt,
    },
  }, keys), { maxWait: 3_000, timeout: 12_000 });
  assert.equal(result.state, "preview_ready");
  return created.id;
}

test("collection result purge is due-only, audited, irreversible and content-free", async () => {
  const id = await readyResult();
  assert.equal(await prisma.$transaction((tx) =>
    commitAmuxCollectionResultPurge(tx, id)), "skipped");
  const before = await prisma.amuxIdeaCollectionRequest.findUniqueOrThrow({ where: { id } });
  assert.ok(before.resultCiphertext);
  assert.equal(before.resultPurgedAt, null);
  // Synthetic clock advancement by shortening only this result's purge deadline.
  await prisma.amuxIdeaCollectionRequest.update({ where: { id },
    data: { resultPurgeAfter: before.createdAt } });
  assert.equal(await prisma.$transaction((tx) =>
    commitAmuxCollectionResultPurge(tx, id)), "purged");
  const afterPurge = await prisma.amuxIdeaCollectionRequest.findUniqueOrThrow({ where: { id } });
  assert.equal(afterPurge.resultCiphertext, null);
  assert.equal(afterPurge.resultKeyId, null);
  assert.equal(afterPurge.resultKeyVersion, null);
  assert.ok(afterPurge.resultPurgedAt);
  assert.equal(afterPurge.resultDigest, before.resultDigest);
  assert.equal(afterPurge.resultDigestKeyId, before.resultDigestKeyId);
  assert.equal(await readAmuxCollectionResultPurgeOutcome(id), "purged");
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({
    where: { id: afterPurge.transitionAuditLogId! },
  });
  assert.equal(audit.action, AMUX_V4_COLLECTION_RESULT_PURGE_ACTION);
  const metadata = audit.metadata as Record<string, unknown>;
  assert.equal(metadata.systemActor, AMUX_V4_IDEA_SYSTEM_ACTOR);
  assert.equal(metadata.actorScope, AMUX_V4_COLLECTION_RESULT_PURGE_SCOPE);
  assert.equal(metadata.previousAuditLogId, before.transitionAuditLogId);
  assert.doesNotMatch(JSON.stringify(metadata), /SYNTHETIC_PURGE_IDEA|export const x/);
  assert.equal(await prisma.$transaction((tx) =>
    commitAmuxCollectionResultPurge(tx, id)), "skipped");
  assert.equal((await prisma.adminAuditLog.count({ where: {
    action: AMUX_V4_COLLECTION_RESULT_PURGE_ACTION, targetId: id } })), 1);
});
