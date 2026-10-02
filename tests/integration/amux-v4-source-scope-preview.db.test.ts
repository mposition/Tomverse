import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { commitIdeaSubmission } from "@/lib/amux/ideaSubmissionService";
import { AmuxSourceScopeApprovalError,
  commitAmuxSourceScopeApproval } from "@/lib/amux/ideaSourceScopeApprovalService";
import {
  AmuxSourceScopePreviewError,
  configureAmuxSourceScopeReadOnlyTransaction,
  previewAmuxSourceScopeInTransaction,
} from "@/lib/amux/ideaSourceScopePreviewService";
import { prisma } from "@/lib/prisma";

const runnerTestUrl = process.env.TEST_DATABASE_URL?.trim();
const standaloneTestUrl = process.env.AMUX_V4_SOURCE_SCOPE_TEST_DATABASE_URL?.trim();
const testUrl = runnerTestUrl || standaloneTestUrl;
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" ||
    (runnerTestUrl && standaloneTestUrl && runnerTestUrl !== standaloneTestUrl) ||
    process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: AMUX v4 source scope preview DB test requires one dedicated loopback test database shared with the DB integration runner");
}

const actorUserId = `synthetic-amux-owner-${randomUUID()}`;
const actorEmail = "amux-v4-synthetic-owner@example.test";
process.env.ADMIN_USER_IDS = actorUserId;
process.env.ADMIN_EMAILS = actorEmail;
process.env.ADMIN_OWNER_EMAILS = actorEmail;
process.env.ADMIN_AUDIT_INTEGRITY_KEY = `synthetic-audit-${randomUUID()}`;
const session = {
  user: { id: actorUserId, email: actorEmail, authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
} as Session;
const request = new Request("https://tomverse.test/api/admin/amux/ideas/submissions", { method: "POST" });
const keys = {
  masterKeyId: "synthetic-master",
  masterKeyVersion: 1,
  masterKey: randomBytes(32),
  digestKeyId: "synthetic-digest",
  digestKey: randomBytes(32),
};

after(async () => { await prisma.$disconnect(); });

test("source scope public transaction configuration is database read-only", async () => {
  await assert.rejects(prisma.$transaction(async (tx) => {
    await configureAmuxSourceScopeReadOnlyTransaction(tx);
    await tx.amuxIdeaSubmission.updateMany({
      where: { id: randomUUID() }, data: { state: "submitted" },
    });
  }), /read-only transaction/i);
});

test("source scope preview reads only owned audited idea and never approves transfer", async () => {
  const ideaId = randomUUID();
  const inspected = inspectAmuxIdeaSubmission(JSON.stringify({
    version: 1,
    requestId: randomUUID(),
    input: { version: 1, idea: "SYNTHETIC_SOURCE_SCOPE", repositories: ["mposition/Tomverse"], pullRequests: [] },
  }));
  if (!inspected.ok) throw new Error(inspected.code);
  const scopeJson = JSON.stringify({ version: 1, sources: [{
    kind: "repository_file", repository: "mposition/Tomverse", commitSha: "a".repeat(40),
    path: "lib/amux/ideaSourceScopeCore.ts",
  }] });
  await assert.rejects(prisma.$transaction(async (tx) => {
    await commitIdeaSubmission(tx, { session, request, inspected, ideaId, keys });
    const preview = await previewAmuxSourceScopeInTransaction(tx, actorUserId,
      { schemaVersion: 1, ideaId, scopeJson }, keys);
    assert.equal(preview.fileCount, 1);
    assert.equal(preview.collectionVerified, false);
    assert.equal(preview.transferAuthorized, false);
    assert.equal(JSON.parse(preview.canonicalScopeJson).sources[0].path, "lib/amux/ideaSourceScopeCore.ts");
    await assert.rejects(previewAmuxSourceScopeInTransaction(tx, "another-actor",
      { schemaVersion: 1, ideaId, scopeJson }, keys),
    (error: unknown) => error instanceof AmuxSourceScopePreviewError && error.code === "not_found");
    await assert.rejects(previewAmuxSourceScopeInTransaction(tx, actorUserId,
      { schemaVersion: 1, ideaId, scopeJson: scopeJson.replace("Tomverse", "other") }, keys),
    (error: unknown) => error instanceof AmuxSourceScopePreviewError && error.code === "scope_rejected");
    const stored = await tx.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: ideaId } });
    await tx.amuxIdeaSubmission.update({ where: { id: ideaId }, data: { rawDigest: "0".repeat(64) } });
    await assert.rejects(previewAmuxSourceScopeInTransaction(tx, actorUserId,
      { schemaVersion: 1, ideaId, scopeJson }, keys),
    (error: unknown) => error instanceof AmuxSourceScopePreviewError && error.code === "idea_unavailable");
    await tx.amuxIdeaSubmission.update({ where: { id: ideaId }, data: { rawDigest: stored.rawDigest } });
    const cancelledAt = new Date();
    await tx.amuxIdeaSubmission.update({ where: { id: ideaId }, data: {
      state: "cancelled", cancelledAt, rawPurgeAfter: cancelledAt,
    } });
    await assert.rejects(previewAmuxSourceScopeInTransaction(tx, actorUserId,
      { schemaVersion: 1, ideaId, scopeJson }, keys),
    (error: unknown) => error instanceof AmuxSourceScopePreviewError && error.code === "idea_unavailable");
    assert.equal(await tx.amuxIdeaSourceScopeApproval.count({ where: { ideaId } }), 0);
    assert.equal(await tx.amuxIdeaTransferPreview.count({ where: { ideaId } }), 0);
    throw new Error("synthetic rollback");
  }), /synthetic rollback/);
  assert.equal(await prisma.amuxIdeaSubmission.count({ where: { id: ideaId } }), 0);
});

test("owner approval atomically binds a current idea and scope to its audit", async () => {
  const ideaId = randomUUID();
  const approvalId = randomUUID();
  const inspected = inspectAmuxIdeaSubmission(JSON.stringify({
    version: 1, requestId: randomUUID(),
    input: { version: 1, idea: "SYNTHETIC_SCOPE_APPROVAL",
      repositories: ["mposition/Tomverse"], pullRequests: [] },
  }));
  if (!inspected.ok) throw new Error(inspected.code);
  const scopeJson = JSON.stringify({ version: 1, sources: [{
    kind: "repository_file", repository: "mposition/Tomverse",
    commitSha: "a".repeat(40), path: "lib/amux/ideaSourceScopeCore.ts",
  }] });
  await assert.rejects(prisma.$transaction(async (tx) => {
    await commitIdeaSubmission(tx, { session, request, inspected, ideaId, keys });
    const preview = await previewAmuxSourceScopeInTransaction(tx, actorUserId,
      { schemaVersion: 1, ideaId, scopeJson }, keys);
    const choice = { schemaVersion: 1 as const, approvalId, ideaId,
      ideaDigest: preview.ideaDigest,
      canonicalScopeJson: preview.canonicalScopeJson,
      scopeDigest: preview.scopeDigest,
      scopeDigestKeyId: preview.scopeDigestKeyId };
    await assert.rejects(commitAmuxSourceScopeApproval(tx, {
      session, request, choice: { ...choice, scopeDigest: "0".repeat(64) }, keys,
    }), (error: unknown) => error instanceof AmuxSourceScopeApprovalError &&
      error.code === "preview_changed");
    assert.equal(await tx.amuxIdeaSourceScopeApproval.count({ where: { ideaId } }), 0);
    const result = await commitAmuxSourceScopeApproval(tx,
      { session, request, choice, keys });
    assert.equal(result.ideaDigest, preview.ideaDigest);
    assert.equal(result.previewScopeDigest, preview.scopeDigest);
    const row = await tx.amuxIdeaSourceScopeApproval.findUniqueOrThrow({
      where: { id: approvalId },
    });
    assert.equal(row.status, "approved");
    assert.equal(row.authorizationAuditLogId, result.auditId);
    assert.equal(row.scopeDigest, result.scopeDigest);
    const audit = await tx.adminAuditLog.findUniqueOrThrow({
      where: { id: result.auditId },
    });
    assert.equal(audit.action, "amux.v4.source_scope.approved");
    assert.equal((audit.metadata as Record<string, unknown>).previewScopeDigest,
      preview.scopeDigest);
    assert.doesNotMatch(JSON.stringify(audit.metadata), /ideaSourceScopeCore\.ts/);
    assert.equal(await tx.amuxIdeaTransferPreview.count({ where: { ideaId } }), 0);
    await assert.rejects(commitAmuxSourceScopeApproval(tx,
      { session, request, choice, keys }),
    (error: unknown) => error instanceof AmuxSourceScopeApprovalError &&
      error.code === "approval_exists");
    throw new Error("synthetic rollback");
  }), /synthetic rollback/);
  assert.equal(await prisma.amuxIdeaSourceScopeApproval.count({ where: { id: approvalId } }), 0);
});
