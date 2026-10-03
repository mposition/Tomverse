import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { AMUX_V4_COLLECTION_RESULT_ACTION, AMUX_V4_COLLECTION_RESULT_SCOPE,
  AMUX_V4_IDEA_SYSTEM_ACTOR } from "@/lib/adminAuditSystemActors";
import { commitAmuxCollectionClaim } from "@/lib/amux/ideaCollectionClaimService";
import { commitAmuxIdeaCollectionRequest } from "@/lib/amux/ideaCollectionRequestService";
import { collectionResultEnabled } from "@/lib/amux/ideaCollectionResultCore";
import { AmuxCollectionResultError, commitAmuxCollectionResult,
  readAmuxCollectionResultOutcome } from "@/lib/amux/ideaCollectionResultService";
import { openAmuxContent, verifyAmuxContentDigest } from "@/lib/amux/ideaCrypto";
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
  throw new Error("REFUSE: collection result test requires a dedicated loopback test database");
}

const actorUserId = `synthetic-amux-owner-${randomUUID()}`;
const actorEmail = "amux-v4-result-synthetic@example.test";
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

async function fixture() {
  const ideaId = randomUUID();
  const scopeApprovalId = randomUUID();
  const frontierApprovalId = randomUUID();
  const requestId = randomUUID();
  const previewId = randomUUID();
  const modelId = `synthetic-frontier-${randomUUID()}`;
  const submitted = inspectAmuxIdeaSubmission(JSON.stringify({ version: 1,
    requestId: randomUUID(), input: { version: 1,
      idea: "SYNTHETIC_RESULT_IDEA", repositories: ["mposition/Tomverse"],
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
  const identity = { schemaVersion: 1 as const,
    collectionRequestId: created.id, requestId, previewId,
    requestDigest: created.requestDigest, leaseId: claim.leaseId,
    leaseGeneration: 1 as const };
  return { created, claim, identity };
}

const excerpt = "export const x=1;\n";
const source = { sourceIndex: 0 as const, repositoryId: 123,
  refName: "refs/heads/develop", refObjectSha: "a".repeat(40),
  refCommitSha: "a".repeat(40), commitSha: "a".repeat(40),
  path: "lib/amux/ideaSourceScopeCore.ts", blobSha: "b".repeat(40),
  fileSha256: "c".repeat(64), startByte: 0,
  endByte: Buffer.byteLength(excerpt, "utf8"), excerptText: excerpt };

test("collection result remains code-disabled", () => {
  assert.equal(collectionResultEnabled("enabled"), false);
});

test("one leased result is encrypted and audited; replay is refused", async () => {
  const item = await fixture();
  const body = { ...item.identity, outcome: "preview_candidate" as const, source };
  const result = await prisma.$transaction((tx) =>
    commitAmuxCollectionResult(tx, body, keys),
  { maxWait: 3_000, timeout: 12_000 });
  assert.equal(result.state, "preview_ready");
  assert.match(result.resultDigest!, /^[a-f0-9]{64}$/);
  const row = await prisma.amuxIdeaCollectionRequest.findUniqueOrThrow({
    where: { id: item.created.id },
  });
  assert.equal(row.state, "preview_ready");
  assert.equal(row.leaseId, null);
  assert.ok(row.resultCiphertext);
  assert.ok(row.resultCiphertext.length <= 32_768);
  assert.ok(row.resultPurgeAfter!.getTime() <= item.created.expiresAt.getTime() + 86_400_000);
  const plain = openAmuxContent({ ciphertext: Buffer.from(row.resultCiphertext),
    keyId: row.resultKeyId!, keyVersion: row.resultKeyVersion! },
  "collection_result", row.id, keys);
  assert.equal(verifyAmuxContentDigest(plain, "collection_result", row.id,
    row.resultDigest!, row.resultDigestKeyId!, keys), true);
  const parsed = JSON.parse(plain.toString("utf8"));
  assert.equal(parsed.provenance, "collector_attested");
  assert.equal(parsed.model.modelId, row.modelId);
  assert.match(parsed.prompt, /SYNTHETIC_RESULT_IDEA/);
  plain.fill(0);
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({
    where: { id: row.transitionAuditLogId! },
  });
  assert.equal(audit.action, AMUX_V4_COLLECTION_RESULT_ACTION);
  assert.equal((audit.metadata as Record<string, unknown>).systemActor,
    AMUX_V4_IDEA_SYSTEM_ACTOR);
  assert.equal((audit.metadata as Record<string, unknown>).actorScope,
    AMUX_V4_COLLECTION_RESULT_SCOPE);
  assert.doesNotMatch(JSON.stringify(audit.metadata),
    /SYNTHETIC_RESULT_IDEA|ideaSourceScopeCore\.ts|export const x/);
  assert.equal((await readAmuxCollectionResultOutcome(body)).status, "preview_ready");
  const originalMetadata = JSON.stringify(audit.metadata);
  if (!originalMetadata) throw new Error("missing synthetic result audit metadata");
  const writeSyntheticMetadata = async (metadata: string) => {
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
  try {
    await writeSyntheticMetadata(JSON.stringify({
      ...(audit.metadata as Record<string, unknown>), resultDigestKeyId: "wrong-key",
    }));
    assert.equal((await readAmuxCollectionResultOutcome(body)).status, "partial");
  } finally {
    await writeSyntheticMetadata(originalMetadata);
  }
  assert.equal((await readAmuxCollectionResultOutcome(body)).status, "preview_ready");
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxCollectionResult(tx, body, keys)),
  (error: unknown) => error instanceof AmuxCollectionResultError &&
    error.code === "not_ready");
});

test("collector hold stores no content; wrong lease cannot settle", async () => {
  const item = await fixture();
  const hold = { ...item.identity, outcome: "hold" as const,
    reason: "source_unverified" as const };
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxCollectionResult(tx, { ...hold, leaseId: randomUUID() }, keys)),
  (error: unknown) => error instanceof AmuxCollectionResultError &&
    error.code === "not_ready");
  const before = await prisma.amuxIdeaCollectionRequest.findUniqueOrThrow({
    where: { id: item.created.id },
  });
  assert.equal(before.state, "claimed");
  const result = await prisma.$transaction((tx) =>
    commitAmuxCollectionResult(tx, hold, keys));
  assert.equal(result.state, "hold");
  const row = await prisma.amuxIdeaCollectionRequest.findUniqueOrThrow({
    where: { id: item.created.id },
  });
  assert.equal(row.resultCiphertext, null);
  assert.equal(row.resultDigest, null);
  assert.equal((await readAmuxCollectionResultOutcome(hold)).status, "hold");
});

test("scope revocation after claim blocks result without changing the row", async () => {
  const item = await fixture();
  await prisma.amuxIdeaSourceScopeApproval.update({
    where: { id: (await prisma.amuxIdeaCollectionRequest.findUniqueOrThrow({
      where: { id: item.created.id } })).sourceScopeApprovalId },
    data: { status: "revoked", revokedAt: new Date() },
  });
  const body = { ...item.identity, outcome: "preview_candidate" as const, source };
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxCollectionResult(tx, body, keys)),
  (error: unknown) => error instanceof AmuxCollectionResultError &&
    error.code === "not_ready");
  const row = await prisma.amuxIdeaCollectionRequest.findUniqueOrThrow({
    where: { id: item.created.id },
  });
  assert.equal(row.state, "claimed");
  assert.equal(row.resultCiphertext, null);
});

test("expired lease cannot report success or hold even with an old claim ID", async () => {
  const item = await fixture();
  const body = { ...item.identity, outcome: "preview_candidate" as const, source };
  await assert.rejects(prisma.$transaction(async (tx) => {
    // Synthetic clock boundary: preserve the DB CHECK and disable only the
    // immutable lease trigger inside a transaction rolled back below.
    const row = await tx.amuxIdeaCollectionRequest.findUniqueOrThrow({
      where: { id: item.created.id }, select: { createdAt: true },
    });
    await tx.$executeRawUnsafe(
      'ALTER TABLE "AmuxIdeaCollectionRequest" DISABLE TRIGGER "AmuxIdeaCollectionRequest_guard"');
    await tx.amuxIdeaCollectionRequest.update({ where: { id: item.created.id },
      data: { leaseExpiresAt: new Date(row.createdAt.getTime() + 1) } });
    await tx.$executeRawUnsafe(
      'ALTER TABLE "AmuxIdeaCollectionRequest" ENABLE TRIGGER "AmuxIdeaCollectionRequest_guard"');
    await assert.rejects(commitAmuxCollectionResult(tx, body, keys),
    (error: unknown) => error instanceof AmuxCollectionResultError &&
      error.code === "not_ready");
    await assert.rejects(commitAmuxCollectionResult(tx, { ...item.identity,
      outcome: "hold", reason: "collector_timeout" }, keys),
    (error: unknown) => error instanceof AmuxCollectionResultError &&
      error.code === "not_ready");
    throw new Error("synthetic rollback");
  }), /synthetic rollback/);
  const row = await prisma.amuxIdeaCollectionRequest.findUniqueOrThrow({
    where: { id: item.created.id },
  });
  assert.equal(row.state, "claimed");
  assert.equal(row.resultCiphertext, null);
});
