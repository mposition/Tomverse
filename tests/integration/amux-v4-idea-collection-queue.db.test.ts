import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { commitIdeaSubmission } from "@/lib/amux/ideaSubmissionService";
import { inspectFrontierCatalogWrite } from "@/lib/amux/ideaFrontierCatalogWriteCore";
import { commitFrontierCatalogDecision } from "@/lib/amux/ideaFrontierCatalogWrite";
import { commitAmuxIdeaCollectionRequest } from "@/lib/amux/ideaCollectionRequestService";
import { listAmuxV4CollectionCandidatesInTransaction } from
  "@/lib/amux/ideaCollectionQueueService";
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
  throw new Error("REFUSE: collection queue test requires a dedicated loopback test database");
}

const actorUserId = `synthetic-amux-owner-${randomUUID()}`;
const actorEmail = "amux-v4-collection-queue@example.test";
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

test("collection queue pages 33 pending requests exactly once and excludes expired or revoked scopes",
  { timeout: 180_000 }, async () => {
    const frontierApprovalId = randomUUID();
    const modelId = `synthetic-frontier-${randomUUID()}`;
    const frontierDecision = inspectFrontierCatalogWrite(JSON.stringify({
      schemaVersion: 1, action: "approve", approvalId: frontierApprovalId,
      provider: "openai", modelId, allowedEfforts: ["high"],
      expectedPreviousVersion: 0, ownerConfirmedFrontierEligibility: true,
    }));
    if (!frontierDecision.ok) throw new Error(frontierDecision.code);
    const sourceJson = JSON.stringify({ version: 1, sources: [{ kind: "repository_file",
      repository: "mposition/Tomverse", commitSha: "a".repeat(40),
      path: "lib/amux/ideaSourceScopeCore.ts" }] });
    await assert.rejects(prisma.$transaction(async (tx) => {
      await commitFrontierCatalogDecision(tx, { session, request,
        decision: frontierDecision.request });
      const staged: Array<{ id: string; scopeId: string }> = [];
      // Two unrelated eligible requests must not shift the assertions for
      // this test's 33-page span when suites share one routing-lane database.
      for (let index = 0; index < 37; index += 1) {
        const ideaId = randomUUID();
        const scopeId = randomUUID();
        const submission = inspectAmuxIdeaSubmission(JSON.stringify({ version: 1,
          requestId: randomUUID(), input: { version: 1,
            idea: `SYNTHETIC_QUEUE_${index}`, repositories: ["mposition/Tomverse"],
            pullRequests: [] } }));
        if (!submission.ok) throw new Error(submission.code);
        await commitIdeaSubmission(tx, { session, request, inspected: submission,
          ideaId, keys });
        const preview = await previewAmuxSourceScopeInTransaction(tx, actorUserId,
          { schemaVersion: 1, ideaId, scopeJson: sourceJson }, keys);
        await commitAmuxSourceScopeApproval(tx, { session, request, choice: {
          schemaVersion: 1, approvalId: scopeId, ideaId,
          ideaDigest: preview.ideaDigest, canonicalScopeJson: preview.canonicalScopeJson,
          scopeDigest: preview.scopeDigest, scopeDigestKeyId: preview.scopeDigestKeyId,
        }, keys });
        const result = await commitAmuxIdeaCollectionRequest(tx, { session, request,
          choice: { schemaVersion: 1, requestId: randomUUID(),
            previewId: randomUUID(), ideaId, scopeApprovalId: scopeId,
            frontierApprovalId, frontierVersion: 1,
            provider: "openai", modelId, reasoningEffort: "high",
            sourceIndex: 0, attempt: 1, sourceByteLimit: 8_192 }, keys });
        staged.push({ id: result.id, scopeId });
      }
      const other = staged.slice(0, 2);
      const created = staged.slice(2);
      const now = new Date();
      await tx.amuxIdeaSourceScopeApproval.update({ where: { id: created[33].scopeId },
        data: { approvedAt: new Date(now.getTime() - 30 * 60_000),
          expiresAt: new Date(now.getTime() - 15 * 60_000) } });
      await tx.amuxIdeaSourceScopeApproval.update({ where: { id: created[34].scopeId },
        data: { status: "revoked", revokedAt: now } });
      const expectedRows = await tx.amuxIdeaCollectionRequest.findMany({
        where: { id: { in: created.slice(0, 33).map((row) => row.id) } },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      const expected = expectedRows.map((row) => row.id);
      assert.equal(expected.length, 33);
      const { parseCollectionQueueCursor } = await import("@/lib/amux/ideaCollectionQueueCore");
      const all: Awaited<ReturnType<typeof listAmuxV4CollectionCandidatesInTransaction>>["candidates"] = [];
      let cursor: ReturnType<typeof parseCollectionQueueCursor> = null;
      let pages = 0;
      while (true) {
        assert.ok(pages < 10, "unexpectedly large synthetic collection queue");
        const page = await listAmuxV4CollectionCandidatesInTransaction(tx, cursor);
        pages += 1;
        all.push(...page.candidates);
        if (!page.hasMore) {
          assert.equal(page.nextCursor, null);
          break;
        }
        assert.equal(page.candidates.length, 32);
        assert.ok(page.nextCursor);
        cursor = parseCollectionQueueCursor(page.nextCursor);
        assert.ok(cursor);
      }
      assert.ok(pages >= 2);
      assert.deepEqual(all.filter((candidate) => expected.includes(candidate.collectionRequestId))
        .map((candidate) => candidate.collectionRequestId), expected);
      assert.equal(new Set(all.map((candidate) => candidate.collectionRequestId)).size, all.length);
      assert.ok(other.every((row) => all.some((candidate) => candidate.collectionRequestId === row.id)));
      assert.ok(all.every((candidate) => Number.isFinite(Date.parse(candidate.expiresAt))));
      assert.equal(all.some((candidate) => candidate.collectionRequestId === created[33].id), false);
      assert.equal(all.some((candidate) => candidate.collectionRequestId === created[34].id), false);
      throw new Error("synthetic rollback");
    }, { maxWait: 5_000, timeout: 120_000 }), /synthetic rollback/);
  });
