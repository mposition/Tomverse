import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { AMUX_V4_COLLECTION_CLAIM_ACTION, AMUX_V4_COLLECTION_CLAIM_SCOPE,
  AMUX_V4_COLLECTION_CLAIM_TARGET, AMUX_V4_IDEA_SYSTEM_ACTOR } from
  "@/lib/adminAuditSystemActors";
import { collectionClaimEnabled, AMUX_V4_COLLECTION_LEASE_MS } from
  "@/lib/amux/ideaCollectionClaimCore";
import { AmuxCollectionClaimError, commitAmuxCollectionClaim,
  readAmuxCollectionClaimOutcome } from "@/lib/amux/ideaCollectionClaimService";
import { commitAmuxIdeaCollectionRequest } from "@/lib/amux/ideaCollectionRequestService";
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
  throw new Error("REFUSE: collection claim test requires a dedicated loopback test database");
}

const actorUserId = `synthetic-amux-owner-${randomUUID()}`;
const actorEmail = "amux-v4-claim-synthetic@example.test";
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

async function createPendingClaimFixture() {
  const ideaId = randomUUID();
  const scopeApprovalId = randomUUID();
  const frontierApprovalId = randomUUID();
  const requestId = randomUUID();
  const previewId = randomUUID();
  const modelId = `synthetic-frontier-${randomUUID()}`;
  const submitted = inspectAmuxIdeaSubmission(JSON.stringify({ version: 1,
    requestId: randomUUID(), input: { version: 1,
      idea: "SYNTHETIC_CLAIM_IDEA", repositories: ["mposition/Tomverse"],
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
  return { created, ideaId, scopeApprovalId, frontierApprovalId, modelId };
}

test("collection claim remains code-disabled", () => {
  assert.equal(collectionClaimEnabled("enabled"), false);
});

test("one current owner-approved file is claimed once with canonical system audit", async () => {
  const { created } = await createPendingClaimFixture();
  assert.equal((await readAmuxCollectionClaimOutcome(created.id)).status, "pending");
  const claimed = await prisma.$transaction((tx) =>
    commitAmuxCollectionClaim(tx, created.id, keys),
  { maxWait: 3_000, timeout: 12_000 });
  assert.equal(claimed.collectionRequestId, created.id);
  assert.equal(claimed.requestDigest, created.requestDigest);
  assert.equal(claimed.idea, "SYNTHETIC_CLAIM_IDEA");
  assert.equal(claimed.source.kind, "repository_file");
  assert.equal(claimed.source.repository, "mposition/Tomverse");
  assert.equal(claimed.source.commitSha, "a".repeat(40));
  assert.equal(claimed.sourceByteLimit, 8_192);
  assert.equal(claimed.leaseGeneration, 1);
  assert.equal(claimed.collectionVerified, false);
  assert.equal(claimed.transferAuthorized, false);
  assert.ok(claimed.leaseExpiresAt.getTime() <= Date.now() + AMUX_V4_COLLECTION_LEASE_MS);
  assert.doesNotMatch(JSON.stringify(claimed), /ciphertext|GitHub token/i);
  const stored = await prisma.amuxIdeaCollectionRequest.findUniqueOrThrow({
    where: { id: created.id },
  });
  assert.equal(stored.state, "claimed");
  assert.equal(stored.leaseGeneration, 1);
  assert.equal(stored.leaseId, claimed.leaseId);
  assert.equal(stored.leaseExpiresAt?.getTime(), claimed.leaseExpiresAt.getTime());
  assert.equal(stored.resultCiphertext, null);
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({
    where: { id: stored.transitionAuditLogId! },
  });
  assert.equal(audit.action, AMUX_V4_COLLECTION_CLAIM_ACTION);
  assert.equal(audit.targetType, AMUX_V4_COLLECTION_CLAIM_TARGET);
  assert.equal(audit.targetId, created.id);
  assert.equal(audit.actorUserId, null);
  assert.equal((audit.metadata as Record<string, unknown>).systemActor,
    AMUX_V4_IDEA_SYSTEM_ACTOR);
  assert.equal((audit.metadata as Record<string, unknown>).actorScope,
    AMUX_V4_COLLECTION_CLAIM_SCOPE);
  assert.doesNotMatch(JSON.stringify(audit.metadata), /SYNTHETIC_CLAIM_IDEA|ideaSourceScopeCore\.ts/);
  assert.equal((await readAmuxCollectionClaimOutcome(created.id)).status, "claimed");
  const originalMetadata = JSON.stringify(audit.metadata);
  if (!originalMetadata) throw new Error("missing synthetic claim audit metadata");
  const writeSyntheticClaimMetadata = async (metadata: string) => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "AdminAuditLog" DISABLE TRIGGER "admin_audit_log_is_append_only"');
      await tx.$executeRaw`
        UPDATE "AdminAuditLog" SET "metadata" = ${metadata}::jsonb
        WHERE "id" = ${audit.id}
      `;
      await tx.$executeRawUnsafe(
        'ALTER TABLE "AdminAuditLog" ENABLE TRIGGER "admin_audit_log_is_append_only"');
    });
  };
  for (const mismatch of [
    { requestId: randomUUID() },
    { requestDigest: "0".repeat(64) },
    { previewId: randomUUID() },
    { sourceIndex: 1 },
    { sourceByteLimit: 8_191 },
  ]) {
    try {
      await writeSyntheticClaimMetadata(JSON.stringify({
        ...(audit.metadata as Record<string, unknown>), ...mismatch,
      }));
      assert.equal((await readAmuxCollectionClaimOutcome(created.id)).status,
        "partial");
    } finally {
      await writeSyntheticClaimMetadata(originalMetadata);
    }
  }
  assert.equal((await readAmuxCollectionClaimOutcome(created.id)).status, "claimed");
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxCollectionClaim(tx, created.id, keys)),
  (error: unknown) => error instanceof AmuxCollectionClaimError && error.code === "not_ready");
  assert.equal((await readAmuxCollectionClaimOutcome(randomUUID())).status, "absent");
});

async function assertUnclaimed(collectionRequestId: string,
  expectedCode: AmuxCollectionClaimError["code"] = "not_ready") {
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxCollectionClaim(tx, collectionRequestId, keys)),
  (error: unknown) => error instanceof AmuxCollectionClaimError &&
    error.code === expectedCode);
  const row = await prisma.amuxIdeaCollectionRequest.findUniqueOrThrow({
    where: { id: collectionRequestId },
  });
  assert.equal(row.state, "pending");
  assert.equal(row.leaseId, null);
  assert.equal(row.transitionAuditLogId, null);
}

test("revoked, expired and near-expiry source scopes cannot be claimed", async () => {
  const revoked = await createPendingClaimFixture();
  await prisma.amuxIdeaSourceScopeApproval.update({
    where: { id: revoked.scopeApprovalId },
    data: { status: "revoked", revokedAt: new Date() },
  });
  await assertUnclaimed(revoked.created.id);

  const expired = await createPendingClaimFixture();
  const expiredScope = await prisma.amuxIdeaSourceScopeApproval.findUniqueOrThrow({
    where: { id: expired.scopeApprovalId }, select: { approvedAt: true },
  });
  await prisma.amuxIdeaSourceScopeApproval.update({
    where: { id: expired.scopeApprovalId },
    data: { expiresAt: new Date(expiredScope.approvedAt.getTime() + 1) },
  });
  await assertUnclaimed(expired.created.id);

  const nearExpiry = await createPendingClaimFixture();
  const nearDeadline = new Date(Date.now() + 5_000);
  await prisma.amuxIdeaSourceScopeApproval.update({
    where: { id: nearExpiry.scopeApprovalId },
    data: { expiresAt: nearDeadline },
  });
  assert.ok(nearDeadline.getTime() > Date.now(), "synthetic near-expiry source is still live");
  await assertUnclaimed(nearExpiry.created.id);
});

test("a newer Frontier version invalidates an older request", async () => {
  const fixture = await createPendingClaimFixture();
  const revoke = inspectFrontierCatalogWrite(JSON.stringify({
    schemaVersion: 1, action: "revoke", approvalId: fixture.frontierApprovalId,
    expectedVersion: 1, ownerConfirmedRevocation: true,
  }));
  if (!revoke.ok) throw new Error(revoke.code);
  await prisma.$transaction((tx) => commitFrontierCatalogDecision(tx,
    { session, request, decision: revoke.request }));
  const nextApprovalId = randomUUID();
  const approve = inspectFrontierCatalogWrite(JSON.stringify({
    schemaVersion: 1, action: "approve", approvalId: nextApprovalId,
    provider: "openai", modelId: fixture.modelId,
    allowedEfforts: ["high"], expectedPreviousVersion: 1,
    ownerConfirmedFrontierEligibility: true,
  }));
  if (!approve.ok) throw new Error(approve.code);
  const next = await prisma.$transaction((tx) => commitFrontierCatalogDecision(tx,
    { session, request, decision: approve.request }));
  assert.equal(next.version, 2);
  await assertUnclaimed(fixture.created.id);
});

test("tampered request digest or encrypted idea never receives a lease", async () => {
  const digestFixture = await createPendingClaimFixture();
  await assert.rejects(prisma.$transaction(async (tx) => {
    // Synthetic corruption only: the normal DB trigger forbids this identity
    // edit. Roll back the whole transaction after checking the read guard.
    await tx.$executeRawUnsafe(
      'ALTER TABLE "AmuxIdeaCollectionRequest" DISABLE TRIGGER "AmuxIdeaCollectionRequest_guard"');
    await tx.amuxIdeaCollectionRequest.update({
      where: { id: digestFixture.created.id },
      data: { requestDigest: "0".repeat(64) },
    });
    await tx.$executeRawUnsafe(
      'ALTER TABLE "AmuxIdeaCollectionRequest" ENABLE TRIGGER "AmuxIdeaCollectionRequest_guard"');
    await assert.rejects(commitAmuxCollectionClaim(tx, digestFixture.created.id, keys),
    (error: unknown) => error instanceof AmuxCollectionClaimError &&
      error.code === "integrity_unavailable");
    throw new Error("synthetic rollback");
  }), /synthetic rollback/);
  assert.equal((await readAmuxCollectionClaimOutcome(digestFixture.created.id)).status,
    "pending");

  const ciphertextFixture = await createPendingClaimFixture();
  await assert.rejects(prisma.$transaction(async (tx) => {
    await tx.amuxIdeaSubmission.update({ where: { id: ciphertextFixture.ideaId },
      data: { rawCiphertext: randomBytes(128) } });
    await assert.rejects(commitAmuxCollectionClaim(tx, ciphertextFixture.created.id, keys),
    (error: unknown) => error instanceof AmuxCollectionClaimError &&
      error.code === "integrity_unavailable");
    throw new Error("synthetic rollback");
  }), /synthetic rollback/);
  assert.equal((await readAmuxCollectionClaimOutcome(ciphertextFixture.created.id)).status,
    "pending");
});
