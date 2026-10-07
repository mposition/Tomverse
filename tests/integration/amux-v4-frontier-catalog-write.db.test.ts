import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import {
  listApprovedAmuxIdeaFrontierModels,
  readCurrentAmuxIdeaFrontierSelection,
} from "@/lib/amux/ideaFrontierCatalogRead";
import {
  commitFrontierCatalogDecision,
  FrontierCatalogWriteError,
} from "@/lib/amux/ideaFrontierCatalogWrite";
import { inspectFrontierCatalogWrite } from "@/lib/amux/ideaFrontierCatalogWriteCore";
import { prisma } from "@/lib/prisma";

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" ||
    process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: Frontier catalog write DB test requires a dedicated loopback test database");
}

const ownerId = `synthetic-amux-owner-${randomUUID()}`;
const ownerEmail = "amux-v4-frontier-synthetic@example.test";
const syntheticModelIds = new Set<string>();
process.env.ADMIN_USER_IDS = ownerId;
process.env.ADMIN_EMAILS = ownerEmail;
process.env.ADMIN_OWNER_EMAILS = ownerEmail;
process.env.ADMIN_AUDIT_INTEGRITY_KEY =
  "synthetic-amux-v4-frontier-catalog-audit-key-2026";
const session = {
  user: { id: ownerId, email: ownerEmail, authenticatedAt: new Date().toISOString() },
  expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
} as Session;
const request = new Request("https://tomverse.test/api/admin/amux/ideas/frontier-models", {
  method: "POST",
});

const decision = (value: object) => {
  const parsed = inspectFrontierCatalogWrite(JSON.stringify(value));
  if (!parsed.ok) throw new Error(`Synthetic Frontier request rejected: ${parsed.code}`);
  return parsed.request;
};

after(async () => {
  try {
    if (syntheticModelIds.size === 0) return;
    // This suite alone commits catalog rows to prove concurrency and read-side
    // visibility. Remove only its synthetic rows in the dedicated loopback test
    // database, so later shared fixtures may TRUNCATE AdminAuditLog CASCADE.
    // Production's trigger is unchanged; the DDL and cleanup roll back together.
    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'ALTER TABLE "AmuxIdeaFrontierModelApproval" DISABLE TRIGGER "AmuxIdeaFrontierModelApproval_guard"');
      await tx.amuxIdeaFrontierModelApproval.deleteMany({
        where: { modelId: { in: [...syntheticModelIds] } },
      });
      await tx.$executeRawUnsafe(
        'ALTER TABLE "AmuxIdeaFrontierModelApproval" ENABLE TRIGGER "AmuxIdeaFrontierModelApproval_guard"');
    }, { maxWait: 5_000, timeout: 15_000 });
  } finally {
    await prisma.$disconnect();
  }
});

test("owner Frontier approval, revocation and reapproval are atomically audited", async () => {
  const modelId = `synthetic-frontier-${randomUUID()}`;
  syntheticModelIds.add(modelId);
  const firstId = randomUUID();
  const secondId = randomUUID();
  const beforeCards = await prisma.amuxWorkItem.count();
  const approve = decision({ schemaVersion: 1, action: "approve",
    approvalId: firstId, provider: "openai", modelId,
    allowedEfforts: ["xhigh", "high"], expectedPreviousVersion: 0,
    ownerConfirmedFrontierEligibility: true });
  const first = await prisma.$transaction((tx) =>
    commitFrontierCatalogDecision(tx, { session, request, decision: approve }));
  assert.equal(first.version, 1);
  await assert.rejects(prisma.$transaction((tx) =>
    commitFrontierCatalogDecision(tx, { session, request, decision: approve })),
  (error: unknown) => error instanceof FrontierCatalogWriteError &&
    error.code === "request_already_seen");
  const stored = await prisma.amuxIdeaFrontierModelApproval.findUniqueOrThrow({
    where: { id: firstId },
  });
  const approvalAudit = await prisma.adminAuditLog.findUniqueOrThrow({
    where: { id: first.auditId },
  });
  assert.equal(stored.approvedAt.getTime(), approvalAudit.createdAt.getTime());
  assert.deepEqual(stored.allowedEfforts, ["high", "xhigh"]);
  assert.deepEqual(await readCurrentAmuxIdeaFrontierSelection({
    provider: "openai", modelId, reasoningEffort: "xhigh",
  }), { decision: "selection_current", approvalId: firstId, approvalVersion: 1 });
  const listed = await listApprovedAmuxIdeaFrontierModels();
  assert.equal(listed.decision, "catalog_current");
  if (listed.decision === "catalog_current") {
    assert.deepEqual(listed.models.filter((model) => model.modelId === modelId), [{
      approvalId: firstId, approvalVersion: 1, provider: "openai", modelId,
      allowedEfforts: ["high", "xhigh"],
    }]);
  }

  const staleId = randomUUID();
  await assert.rejects(prisma.$transaction((tx) =>
    commitFrontierCatalogDecision(tx, { session, request,
      decision: decision({ schemaVersion: 1, action: "approve",
        approvalId: staleId, provider: "openai", modelId,
        allowedEfforts: ["high"], expectedPreviousVersion: 0,
        ownerConfirmedFrontierEligibility: true }),
    })),
  (error: unknown) => error instanceof FrontierCatalogWriteError &&
    error.code === "catalog_revision_changed");
  assert.equal(await prisma.adminAuditLog.count({
    where: { targetType: "AmuxIdeaFrontierModelApproval", targetId: staleId },
  }), 0);
  assert.equal(await prisma.amuxIdeaFrontierModelApproval.count({
    where: { id: staleId },
  }), 0);

  const revoke = decision({ schemaVersion: 1, action: "revoke",
    approvalId: firstId, expectedVersion: 1, ownerConfirmedRevocation: true });
  const revoked = await prisma.$transaction((tx) =>
    commitFrontierCatalogDecision(tx, { session, request, decision: revoke }));
  assert.equal(revoked.status, "revoked");
  await assert.rejects(prisma.$transaction((tx) =>
    commitFrontierCatalogDecision(tx, { session, request, decision: revoke })),
  (error: unknown) => error instanceof FrontierCatalogWriteError &&
    error.code === "catalog_revision_changed");
  const revokedRow = await prisma.amuxIdeaFrontierModelApproval.findUniqueOrThrow({
    where: { id: firstId },
  });
  const revokeAudit = await prisma.adminAuditLog.findUniqueOrThrow({
    where: { id: revoked.auditId },
  });
  assert.equal(revokedRow.revokedAt?.getTime(), revokeAudit.createdAt.getTime());
  assert.deepEqual(await readCurrentAmuxIdeaFrontierSelection({
    provider: "openai", modelId, reasoningEffort: "xhigh",
  }), { decision: "reject", reason: "model_not_approved" });
  const afterRevocation = await listApprovedAmuxIdeaFrontierModels();
  assert.equal(afterRevocation.decision, "catalog_current");
  if (afterRevocation.decision === "catalog_current") {
    assert.equal(afterRevocation.models.some((model) => model.modelId === modelId), false);
  }

  const reapprove = decision({ schemaVersion: 1, action: "approve",
    approvalId: secondId, provider: "openai", modelId,
    allowedEfforts: ["high"], expectedPreviousVersion: 1,
    ownerConfirmedFrontierEligibility: true });
  const second = await prisma.$transaction((tx) =>
    commitFrontierCatalogDecision(tx, { session, request, decision: reapprove }));
  assert.equal(second.version, 2);
  assert.deepEqual(await readCurrentAmuxIdeaFrontierSelection({
    provider: "openai", modelId, reasoningEffort: "high",
  }), { decision: "selection_current", approvalId: secondId, approvalVersion: 2 });
  const relisted = await listApprovedAmuxIdeaFrontierModels();
  assert.equal(relisted.decision, "catalog_current");
  if (relisted.decision === "catalog_current") {
    assert.deepEqual(relisted.models.filter((model) => model.modelId === modelId), [{
      approvalId: secondId, approvalVersion: 2, provider: "openai", modelId,
      allowedEfforts: ["high"],
    }]);
  }
  assert.equal(await prisma.amuxWorkItem.count(), beforeCards);
});

test("parallel approval for one model records exactly one version and audit", async () => {
  const modelId = `synthetic-frontier-${randomUUID()}`;
  syntheticModelIds.add(modelId);
  const approvalIds = [randomUUID(), randomUUID()];
  const attempts = approvalIds.map((approvalId) => {
    const approve = decision({ schemaVersion: 1, action: "approve",
      approvalId, provider: "openai", modelId,
      allowedEfforts: ["high"], expectedPreviousVersion: 0,
      ownerConfirmedFrontierEligibility: true });
    return prisma.$transaction((tx) =>
      commitFrontierCatalogDecision(tx, { session, request, decision: approve }),
    { maxWait: 5_000, timeout: 15_000 });
  });
  const settled = await Promise.allSettled(attempts);
  const fulfilled = settled.filter((result) => result.status === "fulfilled");
  const rejected = settled.filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0]?.status === "rejected" &&
    rejected[0].reason instanceof FrontierCatalogWriteError &&
    rejected[0].reason.code === "catalog_revision_changed");
  assert.equal(await prisma.amuxIdeaFrontierModelApproval.count({
    where: { id: { in: approvalIds } },
  }), 1);
  assert.equal(await prisma.adminAuditLog.count({
    where: { targetType: "AmuxIdeaFrontierModelApproval",
      targetId: { in: approvalIds } },
  }), 1);
});

test("an aborted owner decision leaves neither catalog row nor canonical audit", async () => {
  const approvalId = randomUUID();
  const modelId = `synthetic-frontier-${randomUUID()}`;
  syntheticModelIds.add(modelId);
  const approve = decision({ schemaVersion: 1, action: "approve",
    approvalId, provider: "anthropic", modelId,
    allowedEfforts: ["high"], expectedPreviousVersion: 0,
    ownerConfirmedFrontierEligibility: true });
  await assert.rejects(prisma.$transaction(async (tx) => {
    await commitFrontierCatalogDecision(tx, { session, request, decision: approve });
    throw new Error("synthetic rollback");
  }));
  assert.equal(await prisma.amuxIdeaFrontierModelApproval.count({
    where: { id: approvalId },
  }), 0);
  assert.equal(await prisma.adminAuditLog.count({
    where: { targetType: "AmuxIdeaFrontierModelApproval", targetId: approvalId },
  }), 0);
});
