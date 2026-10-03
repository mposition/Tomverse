import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { commitAmuxCollectionClaim } from "@/lib/amux/ideaCollectionClaimService";
import { commitAmuxIdeaCollectionRequest } from "@/lib/amux/ideaCollectionRequestService";
import { commitAmuxCollectionResult } from "@/lib/amux/ideaCollectionResultService";
import { AmuxCollectionPreviewError, readAmuxCollectionPreview } from
  "@/lib/amux/ideaCollectionPreviewService";
import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { commitIdeaSubmission } from "@/lib/amux/ideaSubmissionService";
import { inspectFrontierCatalogWrite } from "@/lib/amux/ideaFrontierCatalogWriteCore";
import { commitFrontierCatalogDecision } from "@/lib/amux/ideaFrontierCatalogWrite";
import { commitAmuxSourceScopeApproval } from "@/lib/amux/ideaSourceScopeApprovalService";
import { previewAmuxSourceScopeInTransaction } from "@/lib/amux/ideaSourceScopePreviewService";
import { prisma } from "@/lib/prisma";

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" || process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: collection preview test requires a dedicated loopback test database");
}

const actorUserId = `synthetic-amux-owner-${randomUUID()}`;
const actorEmail = "amux-v4-preview-synthetic@example.test";
const otherActorUserId = `synthetic-amux-owner-${randomUUID()}`;
const otherActorEmail = "amux-v4-preview-other@example.test";
process.env.ADMIN_USER_IDS = `${actorUserId},${otherActorUserId}`;
process.env.ADMIN_EMAILS = `${actorEmail},${otherActorEmail}`;
process.env.ADMIN_OWNER_EMAILS = `${actorEmail},${otherActorEmail}`;
process.env.ADMIN_AUDIT_INTEGRITY_KEY = `synthetic-audit-${randomUUID()}`;
const session = { user: { id: actorUserId, email: actorEmail,
  authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 60 * 60_000).toISOString() } as Session;
const otherSession = { user: { id: otherActorUserId, email: otherActorEmail,
  authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 60 * 60_000).toISOString() } as Session;
const request = new Request("https://tomverse.test/api/admin/amux/ideas/collection-requests",
  { method: "POST" });
const keys = { masterKeyId: "synthetic-master", masterKeyVersion: 1,
  masterKey: randomBytes(32), digestKeyId: "synthetic-digest", digestKey: randomBytes(32) };
process.env.AMUX_V4_CONTENT_MASTER_KEY_ID = keys.masterKeyId;
process.env.AMUX_V4_CONTENT_MASTER_KEY_VERSION = String(keys.masterKeyVersion);
process.env.AMUX_V4_CONTENT_MASTER_KEY_B64 = keys.masterKey.toString("base64");
process.env.AMUX_V4_CONTENT_DIGEST_KEY_ID = keys.digestKeyId;
process.env.AMUX_V4_CONTENT_DIGEST_KEY_B64 = keys.digestKey.toString("base64");

after(async () => { await prisma.$disconnect(); });

test("owner can inspect only the exact retained, audited preview without transfer approval", async () => {
  const ideaId = randomUUID();
  const scopeApprovalId = randomUUID();
  const frontierApprovalId = randomUUID();
  const requestId = randomUUID();
  const previewId = randomUUID();
  const modelId = `synthetic-frontier-${randomUUID()}`;
  const submitted = inspectAmuxIdeaSubmission(JSON.stringify({ version: 1,
    requestId: randomUUID(), input: { version: 1,
      idea: "SYNTHETIC_PREVIEW_IDEA", repositories: ["mposition/Tomverse"],
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
  await prisma.$transaction((tx) => commitAmuxCollectionResult(tx, {
    schemaVersion: 1, collectionRequestId: created.id, requestId, previewId,
    requestDigest: created.requestDigest, leaseId: claim.leaseId,
    leaseGeneration: 1, outcome: "preview_candidate", source: {
      sourceIndex: 0, repositoryId: 123, refName: "refs/heads/develop",
      refObjectSha: "a".repeat(40), refCommitSha: "a".repeat(40),
      commitSha: "a".repeat(40), path: "lib/amux/ideaSourceScopeCore.ts",
      blobSha: "b".repeat(40), fileSha256: "c".repeat(64),
      startByte: 0, endByte: Buffer.byteLength(excerpt, "utf8"), excerptText: excerpt,
    },
  }, keys), { maxWait: 3_000, timeout: 12_000 });
  const found = await readAmuxCollectionPreview(session, requestId);
  assert.equal(found.requestId, requestId);
  assert.equal(found.previewId, previewId);
  assert.equal(found.model.modelId, modelId);
  assert.equal(found.source.repository, "mposition/Tomverse");
  assert.equal(found.source.path, "lib/amux/ideaSourceScopeCore.ts");
  assert.equal("excerptText" in found.source, false);
  assert.match(found.prompt, /SYNTHETIC_PREVIEW_IDEA/);
  assert.match(found.prompt, /export const x=1/);
  assert.match(found.resultDigest, /^[a-f0-9]{64}$/);
  assert.equal(found.collectionVerified, false);
  assert.equal(found.transferAuthorized, false);
  await assert.rejects(readAmuxCollectionPreview(otherSession, requestId),
    (error: unknown) => error instanceof AmuxCollectionPreviewError &&
      error.code === "not_found");
  await assert.rejects(readAmuxCollectionPreview(session, randomUUID()),
    (error: unknown) => error instanceof AmuxCollectionPreviewError &&
      error.code === "not_found");
});
