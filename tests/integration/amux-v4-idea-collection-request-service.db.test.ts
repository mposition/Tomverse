import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { commitIdeaSubmission } from "@/lib/amux/ideaSubmissionService";
import { inspectFrontierCatalogWrite } from "@/lib/amux/ideaFrontierCatalogWriteCore";
import { commitFrontierCatalogDecision } from "@/lib/amux/ideaFrontierCatalogWrite";
import { commitAmuxIdeaCollectionRequest, AmuxCollectionRequestError,
  collectionRequestReadPermitted, collectionRequestWritePermitted,
  readAmuxIdeaCollectionRequest } from
  "@/lib/amux/ideaCollectionRequestService";
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
  throw new Error("REFUSE: collection request service test requires a dedicated loopback test database");
}

const actorUserId = `synthetic-amux-owner-${randomUUID()}`;
const actorEmail = "amux-v4-collection-synthetic@example.test";
const otherActorUserId = `synthetic-amux-owner-${randomUUID()}`;
const otherActorEmail = "amux-v4-collection-other@example.test";
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

after(async () => { await prisma.$disconnect(); });

test("collection request latches remain closed even with enabled env values", () => {
  assert.equal(collectionRequestWritePermitted("enabled"), false);
  assert.equal(collectionRequestReadPermitted("enabled"), false);
});

test("owner request binds one approved file and Frontier choice without collecting content", async () => {
  const ideaId = randomUUID();
  const scopeApprovalId = randomUUID();
  const frontierApprovalId = randomUUID();
  const requestId = randomUUID();
  const previewId = randomUUID();
  const modelId = `synthetic-frontier-${randomUUID()}`;
  const submitted = inspectAmuxIdeaSubmission(JSON.stringify({ version: 1,
    requestId: randomUUID(), input: { version: 1,
      idea: "SYNTHETIC_COLLECTION_REQUEST", repositories: ["mposition/Tomverse"],
      pullRequests: [] } }));
  if (!submitted.ok) throw new Error(submitted.code);
  const scopeJson = JSON.stringify({ version: 1, sources: [{ kind: "repository_file",
    repository: "mposition/Tomverse", commitSha: "a".repeat(40),
    path: "lib/amux/ideaSourceScopeCore.ts" }] });
  const frontierDecision = inspectFrontierCatalogWrite(JSON.stringify({
    schemaVersion: 1, action: "approve", approvalId: frontierApprovalId,
    provider: "openai", modelId, allowedEfforts: ["high"],
    expectedPreviousVersion: 0, ownerConfirmedFrontierEligibility: true,
  }));
  if (!frontierDecision.ok) throw new Error(frontierDecision.code);
  await assert.rejects(prisma.$transaction(async (tx) => {
    await commitIdeaSubmission(tx, { session, request, inspected: submitted, ideaId, keys });
    const preview = await previewAmuxSourceScopeInTransaction(tx, actorUserId,
      { schemaVersion: 1, ideaId, scopeJson }, keys);
    await commitAmuxSourceScopeApproval(tx, { session, request, choice: {
      schemaVersion: 1, approvalId: scopeApprovalId, ideaId,
      ideaDigest: preview.ideaDigest, canonicalScopeJson: preview.canonicalScopeJson,
      scopeDigest: preview.scopeDigest, scopeDigestKeyId: preview.scopeDigestKeyId,
    }, keys });
    const frontier = await commitFrontierCatalogDecision(tx, { session, request,
      decision: frontierDecision.request });
    assert.equal(frontier.version, 1);
    const choice = { schemaVersion: 1 as const, requestId, previewId, ideaId,
      scopeApprovalId, frontierApprovalId, frontierVersion: 1,
      provider: "openai" as const, modelId, reasoningEffort: "high" as const,
      sourceIndex: 0 as const, attempt: 1 as const, sourceByteLimit: 8_192 as const };
    for (const invalid of [
      { ...choice, requestId: "not-a-uuid" },
      { ...choice, attempt: 2 },
      { ...choice, sourceByteLimit: 16 },
    ]) {
      await assert.rejects(commitAmuxIdeaCollectionRequest(tx, { session, request,
        choice: invalid as typeof choice, keys }),
      (error: unknown) => error instanceof AmuxCollectionRequestError && error.code === "not_ready");
    }
    await assert.rejects(commitAmuxIdeaCollectionRequest(tx, { session, request,
      choice: { ...choice, reasoningEffort: "ultra" }, keys }),
    (error: unknown) => error instanceof AmuxCollectionRequestError && error.code === "not_ready");
    assert.equal(await tx.amuxIdeaCollectionRequest.count({ where: { requestId } }), 0);
    const created = await commitAmuxIdeaCollectionRequest(tx, { session, request,
      choice, keys });
    assert.equal(created.state, "pending");
    const row = await tx.amuxIdeaCollectionRequest.findUniqueOrThrow({ where: { requestId } });
    assert.equal(row.id, created.id);
    assert.equal(row.attempt, 1);
    assert.equal(row.sourceByteLimit, 8_192);
    assert.equal(row.sourceKind, "repository_file");
    assert.equal(row.resultCiphertext, null);
    assert.equal(row.previewId, previewId);
    assert.equal(row.requestDigest, created.requestDigest);
    const audit = await tx.adminAuditLog.findUniqueOrThrow({
      where: { id: row.creationAuditLogId },
    });
    assert.equal(audit.action, "amux.v4.collection.requested");
    assert.equal((audit.metadata as Record<string, unknown>).requestDigest,
      created.requestDigest);
    assert.doesNotMatch(JSON.stringify(audit.metadata), /SYNTHETIC_COLLECTION_REQUEST|ideaSourceScopeCore\.ts/);
    await assert.rejects(commitAmuxIdeaCollectionRequest(tx, { session, request,
      choice, keys }),
    (error: unknown) => error instanceof AmuxCollectionRequestError && error.code === "request_exists");
    for (const conflict of [
      { ...choice, requestId: randomUUID() },
      { ...choice, requestId: randomUUID(), previewId: randomUUID() },
    ]) {
      await assert.rejects(commitAmuxIdeaCollectionRequest(tx, { session, request,
        choice: conflict, keys }),
      (error: unknown) => error instanceof AmuxCollectionRequestError &&
        error.code === "request_exists");
    }
    assert.equal(await tx.amuxIdeaCollectionRequest.count({ where: { ideaId } }), 1);
    throw new Error("synthetic rollback");
  }, { maxWait: 5_000, timeout: 15_000 }), /synthetic rollback/);
  assert.equal(await prisma.amuxIdeaCollectionRequest.count({ where: { requestId } }), 0);
});

test("exact-ID readback distinguishes committed, partial, absent and another owner", async () => {
  const ideaId = randomUUID();
  const scopeApprovalId = randomUUID();
  const frontierApprovalId = randomUUID();
  const requestId = randomUUID();
  const previewId = randomUUID();
  const modelId = `synthetic-frontier-${randomUUID()}`;
  const submitted = inspectAmuxIdeaSubmission(JSON.stringify({ version: 1,
    requestId: randomUUID(), input: { version: 1,
      idea: "SYNTHETIC_READBACK", repositories: ["mposition/Tomverse"],
      pullRequests: [] } }));
  if (!submitted.ok) throw new Error(submitted.code);
  const scopeJson = JSON.stringify({ version: 1, sources: [{ kind: "repository_file",
    repository: "mposition/Tomverse", commitSha: "b".repeat(40),
    path: "lib/amux/ideaSourceScopeCore.ts" }] });
  const frontierDecision = inspectFrontierCatalogWrite(JSON.stringify({
    schemaVersion: 1, action: "approve", approvalId: frontierApprovalId,
    provider: "openai", modelId, allowedEfforts: ["high"],
    expectedPreviousVersion: 0, ownerConfirmedFrontierEligibility: true,
  }));
  if (!frontierDecision.ok) throw new Error(frontierDecision.code);
  const created = await prisma.$transaction(async (tx) => {
    await commitIdeaSubmission(tx, { session, request, inspected: submitted, ideaId, keys });
    const preview = await previewAmuxSourceScopeInTransaction(tx, actorUserId,
      { schemaVersion: 1, ideaId, scopeJson }, keys);
    await commitAmuxSourceScopeApproval(tx, { session, request, choice: {
      schemaVersion: 1, approvalId: scopeApprovalId, ideaId,
      ideaDigest: preview.ideaDigest, canonicalScopeJson: preview.canonicalScopeJson,
      scopeDigest: preview.scopeDigest, scopeDigestKeyId: preview.scopeDigestKeyId,
    }, keys });
    const frontier = await commitFrontierCatalogDecision(tx, { session, request,
      decision: frontierDecision.request });
    assert.equal(frontier.version, 1);
    return commitAmuxIdeaCollectionRequest(tx, { session, request, choice: {
      schemaVersion: 1, requestId, previewId, ideaId, scopeApprovalId,
      frontierApprovalId, frontierVersion: 1, provider: "openai", modelId,
      reasoningEffort: "high", sourceIndex: 0, attempt: 1,
      sourceByteLimit: 8_192,
    }, keys });
  }, { maxWait: 5_000, timeout: 15_000 });
  const committed = await readAmuxIdeaCollectionRequest(session, requestId);
  assert.equal(committed.status, "committed");
  if (committed.status !== "committed") throw new Error("expected committed readback");
  assert.equal(committed.id, created.id);
  assert.equal(committed.previewId, previewId);
  assert.equal(committed.requestDigest, created.requestDigest);
  assert.equal(committed.collectionVerified, false);
  assert.equal(committed.transferAuthorized, false);
  const absentRequestId = randomUUID();
  assert.deepEqual(await readAmuxIdeaCollectionRequest(session, absentRequestId),
    { requestId: absentRequestId, status: "absent" });
  assert.deepEqual(await readAmuxIdeaCollectionRequest(otherSession, requestId),
    { requestId, status: "absent" });

  const row = await prisma.amuxIdeaCollectionRequest.findUniqueOrThrow({
    where: { requestId }, select: { creationAuditLogId: true },
  });
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({
    where: { id: row.creationAuditLogId }, select: { metadata: true },
  });
  const original = JSON.stringify(audit.metadata);
  if (!original) throw new Error("missing synthetic audit metadata");
  const changed = JSON.stringify({ ...(audit.metadata as Record<string, unknown>),
    requestDigest: "0".repeat(64) });
  const writeSyntheticAuditMetadata = async (metadata: string) => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "AdminAuditLog" DISABLE TRIGGER "admin_audit_log_is_append_only"');
      await tx.$executeRaw`
        UPDATE "AdminAuditLog" SET "metadata" = ${metadata}::jsonb
        WHERE "id" = ${row.creationAuditLogId}
      `;
      await tx.$executeRawUnsafe(
        'ALTER TABLE "AdminAuditLog" ENABLE TRIGGER "admin_audit_log_is_append_only"');
    });
  };
  try {
    await writeSyntheticAuditMetadata(changed);
    assert.deepEqual(await readAmuxIdeaCollectionRequest(session, requestId),
      { requestId, status: "partial", id: created.id });
  } finally {
    await writeSyntheticAuditMetadata(original);
  }
  assert.equal((await readAmuxIdeaCollectionRequest(session, requestId)).status,
    "committed");
});
