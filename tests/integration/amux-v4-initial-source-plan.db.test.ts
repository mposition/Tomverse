import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { commitIdeaSubmission } from "@/lib/amux/ideaSubmissionService";
import { createInitialIdeaOnlySourcePlan, InitialSourcePlanError } from "@/lib/amux/ideaInitialSourcePlanService";
import { commitInitialIdeaSourcePlan, readInitialIdeaSourcePlan } from "@/lib/amux/ideaInitialSourcePlanAccess";
import { commitIdeaOnlyTransferPreview, readIdeaOnlyTransferPreview,
  IdeaTransferPreviewError } from "@/lib/amux/ideaTransferPreviewService";
import { commitIdeaTransferConfirmation, readIdeaTransferConfirmation,
  IdeaTransferConfirmationError } from "@/lib/amux/ideaTransferConfirmationService";
import { ideaTransferBrowserDigest } from "@/lib/amux/ideaTransferBrowserCore";
import { AMUX_V4_IDEA_SYSTEM_ACTOR } from "@/lib/amux/ideaIdentityCore";
import { getAdminRole } from "@/lib/adminAuth";
import { AuditWriteRefusedError, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_V4_INITIAL_SOURCE_PLAN_SCOPE, isSystemAuditActor } from "@/lib/adminAuditSystemActors";
import { prisma } from "@/lib/prisma";

const runnerTestUrl = process.env.TEST_DATABASE_URL?.trim();
const standaloneTestUrl = process.env.AMUX_V4_INITIAL_PLAN_TEST_DATABASE_URL?.trim();
const testUrl = runnerTestUrl || standaloneTestUrl;
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" ||
    (runnerTestUrl && standaloneTestUrl && runnerTestUrl !== standaloneTestUrl) ||
    process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: AMUX v4 initial source-plan test requires one dedicated loopback test database");
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
  masterKeyId: "synthetic-master", masterKeyVersion: 1,
  masterKey: randomBytes(32), digestKeyId: "synthetic-digest", digestKey: randomBytes(32),
};
const browserNonce = randomBytes(32).toString("base64url");
process.env.AMUX_V4_CONTENT_MASTER_KEY_ID = keys.masterKeyId;
process.env.AMUX_V4_CONTENT_MASTER_KEY_VERSION = String(keys.masterKeyVersion);
process.env.AMUX_V4_CONTENT_MASTER_KEY_B64 = keys.masterKey.toString("base64");
process.env.AMUX_V4_CONTENT_DIGEST_KEY_ID = keys.digestKeyId;
process.env.AMUX_V4_CONTENT_DIGEST_KEY_B64 = keys.digestKey.toString("base64");

after(async () => { await prisma.$disconnect(); });

async function createIdea(input: { idea: string; repositories?: string[] }) {
  const ideaId = randomUUID();
  const inspected = inspectAmuxIdeaSubmission(JSON.stringify({
    version: 1, requestId: randomUUID(),
    input: { version: 1, idea: input.idea,
      repositories: input.repositories ?? [], pullRequests: [] },
  }));
  if (!inspected.ok) throw new Error(inspected.code);
  await prisma.$transaction((tx) => commitIdeaSubmission(tx, {
    session, request, inspected, ideaId, keys,
  }));
  return ideaId;
}

test("operator-idea-only initial plan is bound to the owned submission and system audit", async () => {
  const text = `SYNTHETIC_PLAN_${randomUUID()}`;
  const ideaId = await createIdea({ idea: text });
  const beforeCards = await prisma.amuxWorkItem.count();
  const result = await prisma.$transaction((tx) =>
    commitInitialIdeaSourcePlan(tx, { session, request, ideaId, keys }));
  const row = await prisma.amuxIdeaSourcePlanRevision.findUniqueOrThrow({
    where: { id: result.revisionId },
  });
  const idea = await prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: ideaId } });
  const chunk = await prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
  });
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: result.auditId } });
  assert.equal(isSystemAuditActor(AMUX_V4_IDEA_SYSTEM_ACTOR), true);
  assert.equal(row.ideaId, ideaId);
  assert.equal(row.actorUserId, actorUserId);
  assert.equal(row.revisionNumber, 1);
  assert.equal(row.startChunkIndex, 0);
  assert.equal(row.sourceUnitCount, 1);
  assert.equal(row.unitDigests.length, 1);
  assert.equal(row.manifestDigest, result.manifestDigest);
  assert.equal(row.state, "active");
  assert.ok(row.activatedAt);
  assert.equal(idea.currentSourcePlanRevisionId, result.revisionId);
  assert.equal(chunk.actorUserId, actorUserId);
  assert.equal(chunk.state, "pending");
  assert.equal(chunk.attempt, 0);
  assert.equal(chunk.leaseGeneration, 0);
  assert.equal(chunk.sourcePlanRevisionId, result.revisionId);
  assert.equal(chunk.planStartChunkIndex, 0);
  assert.equal(chunk.revisionChunkIndex, 0);
  assert.equal(audit.action, "AMUX_V4_INITIAL_SOURCE_PLAN_CREATED");
  assert.equal(audit.actorUserId, null);
  assert.equal((audit.metadata as Record<string, unknown>).systemActor, AMUX_V4_IDEA_SYSTEM_ACTOR);
  assert.equal((audit.metadata as Record<string, unknown>).actorScope, AMUX_V4_INITIAL_SOURCE_PLAN_SCOPE);
  assert.equal(Object.hasOwn(audit.metadata as Record<string, unknown>, "actorUserId"), false);
  assert.ok(audit.entryHash);
  assert.equal(JSON.stringify(audit.metadata).includes(text), false);
  const ownerAudit = await prisma.adminAuditLog.findUniqueOrThrow({
    where: { id: result.ownerAuditId },
  });
  assert.equal(ownerAudit.actorUserId, actorUserId);
  assert.equal(ownerAudit.action, "amux.v4.initial_source_plan.requested");
  assert.equal(ownerAudit.targetId, ideaId);
  assert.equal((ownerAudit.metadata as Record<string, unknown>).systemAuditId, result.auditId);
  assert.ok(ownerAudit.entryHash);
  assert.equal(await prisma.amuxWorkItem.count(), beforeCards);
  assert.deepEqual(await readInitialIdeaSourcePlan(session, ideaId),
    { ideaId, status: "committed", revisionId: result.revisionId });
  await assert.rejects(prisma.$transaction((tx) =>
    createInitialIdeaOnlySourcePlan(tx, { ideaId, actorUserId, keys })),
  (error: unknown) => error instanceof InitialSourcePlanError && error.code === "not_ready");
  assert.equal(await prisma.amuxIdeaSourcePlanRevision.count({ where: { ideaId } }), 1);
  assert.equal(await prisma.amuxIdeaAnalysisChunk.count({ where: { ideaId } }), 1);
});

test("idea-only transfer preview stores encrypted input and refuses a missing external key", async () => {
  const text = `SYNTHETIC_PREVIEW_${randomUUID()}`;
  const ideaId = await createIdea({ idea: text });
  const plan = await prisma.$transaction((tx) => commitInitialIdeaSourcePlan(tx,
    { session, request, ideaId, keys }));
  const choice = { previewId: randomUUID(), ideaId, provider: "openai" as const,
    modelId: "gpt-frontier-synthetic", reasoningEffort: "high" as const,
    approvalId: randomUUID(), approvalVersion: 1 };
  const result = await prisma.$transaction((tx) => commitIdeaOnlyTransferPreview(tx,
    { session, request, choice, keys, browserNonce }));
  assert.equal(result.previewId, choice.previewId);
  assert.match(result.payload.prompt, /SYNTHETIC_PREVIEW_/);
  assert.equal(result.payload.selection.modelId, choice.modelId);
  assert.equal(result.payload.ideaId, ideaId);
  assert.match(result.payloadDigest, /^[a-f0-9]{64}$/);
  const row = await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: choice.previewId },
  });
  const chunk = await prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
  });
  assert.equal(row.state, "prepared");
  assert.equal(row.sourcePlanRevisionId, plan.revisionId);
  assert.equal(row.sourceScopeApprovalId, null);
  assert.equal(row.modelId, choice.modelId);
  assert.equal(Buffer.from(row.payloadCiphertext!).includes(Buffer.from(text)), false);
  assert.equal(chunk.currentPreviewId, choice.previewId);
  assert.equal(chunk.state, "awaiting_preview");
  assert.equal(chunk.attempt, 1);
  // This older synthetic writer supplies an in-memory key, not an external
  // unit key. The production read path must not silently fall back to it.
  assert.deepEqual(await readIdeaOnlyTransferPreview(session, choice.previewId),
    { state: "unavailable", transferAuthorized: false });
  const audit = await prisma.adminAuditLog.findFirstOrThrow({
    where: { action: "amux.v4.transfer_preview.prepared",
      targetType: "AmuxIdeaTransferPreview", targetId: choice.previewId },
  });
  assert.equal(audit.actorUserId, actorUserId);
  assert.equal((audit.metadata as Record<string, unknown>).browserBindingDigest,
    ideaTransferBrowserDigest({ previewId: choice.previewId, nonce: browserNonce,
      authenticatedAt: session.user.authenticatedAt, key: keys }));
  assert.equal(JSON.stringify(audit.metadata).includes(text), false);
  await prisma.amuxIdeaTransferPreview.update({
    where: { id: choice.previewId }, data: { expiresAt: new Date("2020-01-01T00:00:00Z") },
  });
  assert.deepEqual(await readIdeaOnlyTransferPreview(session, choice.previewId),
    { state: "expired", transferAuthorized: false });
  assert.deepEqual(await readIdeaTransferConfirmation(session, choice.previewId),
    { state: "expired", modelCallStarted: false });
  await assert.rejects(prisma.$transaction((tx) => commitIdeaOnlyTransferPreview(tx,
    { session, request, choice, keys, browserNonce })),
  (error: unknown) => error instanceof IdeaTransferPreviewError && error.code === "not_ready");
  assert.equal(await prisma.amuxIdeaTransferPreview.count({ where: { ideaId } }), 1);
});

test("transfer preview row, chunk pointer and human audit roll back together", async () => {
  const ideaId = await createIdea({ idea: `SYNTHETIC_PREVIEW_ROLLBACK_${randomUUID()}` });
  await prisma.$transaction((tx) => commitInitialIdeaSourcePlan(tx,
    { session, request, ideaId, keys }));
  const choice = { previewId: randomUUID(), ideaId, provider: "anthropic" as const,
    modelId: "claude-frontier-synthetic", reasoningEffort: "high" as const,
    approvalId: randomUUID(), approvalVersion: 1 };
  await assert.rejects(prisma.$transaction(async (tx) => {
    await commitIdeaOnlyTransferPreview(tx, { session, request, choice, keys, browserNonce });
    throw new Error("synthetic preview rollback");
  }), /synthetic preview rollback/);
  const chunk = await prisma.amuxIdeaAnalysisChunk.findUniqueOrThrow({
    where: { ideaId_chunkIndex: { ideaId, chunkIndex: 0 } },
  });
  assert.equal(chunk.state, "pending");
  assert.equal(chunk.currentPreviewId, null);
  assert.equal(await prisma.amuxIdeaTransferPreview.count({ where: { ideaId } }), 0);
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: "amux.v4.transfer_preview.prepared", targetId: choice.previewId },
  }), 0);
});

test("owner confirmation binds the reviewed digest and browser receipt without a model call", async () => {
  const ideaId = await createIdea({ idea: `SYNTHETIC_CONFIRM_${randomUUID()}` });
  await prisma.$transaction((tx) => commitInitialIdeaSourcePlan(tx,
    { session, request, ideaId, keys }));
  const choice = { previewId: randomUUID(), ideaId, provider: "openai" as const,
    modelId: "gpt-frontier-synthetic", reasoningEffort: "high" as const,
    approvalId: randomUUID(), approvalVersion: 1 };
  const prepared = await prisma.$transaction((tx) => commitIdeaOnlyTransferPreview(tx,
    { session, request, choice, keys, browserNonce }));
  const confirmation = { previewId: choice.previewId, ideaId,
    payloadDigest: prepared.payloadDigest,
    payloadDigestKeyId: prepared.payloadDigestKeyId };
  const beforeCards = await prisma.amuxWorkItem.count();
  for (const invalid of [
    { choice: { ...confirmation, payloadDigest: "a".repeat(64) }, nonce: browserNonce,
      error: "digest_changed" },
    { choice: confirmation, nonce: randomBytes(32).toString("base64url"),
      error: "browser_mismatch" },
  ]) {
    await assert.rejects(prisma.$transaction((tx) => commitIdeaTransferConfirmation(tx,
      { session, request, choice: invalid.choice, browserNonce: invalid.nonce, keys })),
    (error: unknown) => error instanceof IdeaTransferConfirmationError &&
      error.code === invalid.error);
  }
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: "amux.v4.transfer_preview.confirmed", targetId: choice.previewId },
  }), 0);
  const result = await prisma.$transaction((tx) => commitIdeaTransferConfirmation(tx,
    { session, request, choice: confirmation, browserNonce, keys }));
  const row = await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: choice.previewId },
  });
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: result.auditId } });
  assert.equal(row.state, "confirmed");
  assert.equal(row.confirmedByUserId, actorUserId);
  assert.equal(row.confirmationAuditLogId, result.auditId);
  assert.equal(row.confirmExpiresAt?.getTime(), prepared.expiresAt.getTime());
  assert.equal(audit.actorUserId, actorUserId);
  assert.equal(audit.action, "amux.v4.transfer_preview.confirmed");
  assert.equal((audit.metadata as Record<string, unknown>).payloadDigest, prepared.payloadDigest);
  assert.equal((audit.metadata as Record<string, unknown>).modelCallStarted, false);
  assert.deepEqual(await readIdeaTransferConfirmation(session, choice.previewId), {
    state: "confirmed", previewId: choice.previewId,
    ideaId, payloadDigest: prepared.payloadDigest,
    payloadDigestKeyId: prepared.payloadDigestKeyId,
    confirmExpiresAt: row.confirmExpiresAt, modelCallStarted: false,
  });
  await assert.rejects(prisma.$transaction((tx) => commitIdeaTransferConfirmation(tx,
    { session, request, choice: confirmation, browserNonce, keys })),
  (error: unknown) => error instanceof IdeaTransferConfirmationError && error.code === "not_ready");
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: "amux.v4.transfer_preview.confirmed", targetId: choice.previewId },
  }), 1);
  assert.equal(await prisma.amuxWorkItem.count(), beforeCards);
});

test("confirmation audit and state change roll back together", async () => {
  const ideaId = await createIdea({ idea: `SYNTHETIC_CONFIRM_ROLLBACK_${randomUUID()}` });
  await prisma.$transaction((tx) => commitInitialIdeaSourcePlan(tx,
    { session, request, ideaId, keys }));
  const choice = { previewId: randomUUID(), ideaId, provider: "anthropic" as const,
    modelId: "claude-frontier-synthetic", reasoningEffort: "high" as const,
    approvalId: randomUUID(), approvalVersion: 1 };
  const prepared = await prisma.$transaction((tx) => commitIdeaOnlyTransferPreview(tx,
    { session, request, choice, keys, browserNonce }));
  await assert.rejects(prisma.$transaction(async (tx) => {
    await commitIdeaTransferConfirmation(tx, { session, request,
      choice: { previewId: choice.previewId, ideaId,
        payloadDigest: prepared.payloadDigest,
        payloadDigestKeyId: prepared.payloadDigestKeyId }, browserNonce, keys });
    throw new Error("synthetic confirmation rollback");
  }), /synthetic confirmation rollback/);
  const row = await prisma.amuxIdeaTransferPreview.findUniqueOrThrow({
    where: { id: choice.previewId },
  });
  assert.equal(row.state, "prepared");
  assert.equal(row.confirmationAuditLogId, null);
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: "amux.v4.transfer_preview.confirmed", targetId: choice.previewId },
  }), 0);
});

test("read-back reports absence and never discloses another owner's plan", async () => {
  const ideaId = await createIdea({ idea: "SYNTHETIC_READBACK_PLAN" });
  assert.deepEqual(await readInitialIdeaSourcePlan(session, ideaId),
    { ideaId, status: "absent" });
  const otherSession = { ...session, user: { ...session.user,
    id: `other-${actorUserId}` } } as Session;
  assert.equal(getAdminRole(otherSession), "owner");
  await assert.rejects(readInitialIdeaSourcePlan(otherSession, ideaId),
    (error: unknown) => error instanceof Error && error.message === "not_found");
});

test("read-back refuses a plan lacking its initiating human audit", async () => {
  const ideaId = await createIdea({ idea: "SYNTHETIC_UNTRACED_PLAN" });
  await prisma.$transaction((tx) => createInitialIdeaOnlySourcePlan(tx,
    { ideaId, actorUserId, keys }));
  assert.deepEqual(await readInitialIdeaSourcePlan(session, ideaId),
    { ideaId, status: "partial" });
});

test("the v4 actor cannot write a different action or target", async () => {
  const before = await prisma.adminAuditLog.count();
  for (const [action, targetType] of [
    ["AMUX_V4_CARD_REGISTERED", "AmuxIdeaSourcePlanRevision"],
    ["AMUX_V4_INITIAL_SOURCE_PLAN_CREATED", "AmuxWorkItem"],
  ]) {
    await assert.rejects(prisma.$transaction((tx) => writeSystemAuditLog({
      tx, systemActor: AMUX_V4_IDEA_SYSTEM_ACTOR, action, targetType,
      targetId: randomUUID(), summary: "synthetic refused action",
    })), (error: unknown) => error instanceof AuditWriteRefusedError);
  }
  assert.equal(await prisma.adminAuditLog.count(), before);
});

test("two initial-plan writers serialize to one revision and one creation audit", async () => {
  const ideaId = await createIdea({ idea: "SYNTHETIC_CONCURRENT_PLAN" });
  const attempts = await Promise.allSettled([1, 2].map(() =>
    prisma.$transaction((tx) => createInitialIdeaOnlySourcePlan(tx,
      { ideaId, actorUserId, keys }))));
  const successes = attempts.filter((attempt) => attempt.status === "fulfilled");
  const failures = attempts.filter((attempt) => attempt.status === "rejected");
  assert.equal(successes.length, 1);
  assert.equal(failures.length, 1);
  const success = successes[0] as PromiseFulfilledResult<{
    revisionId: string; manifestDigest: string; auditId: string;
  }>;
  const failure = failures[0] as PromiseRejectedResult;
  assert.ok(failure.reason instanceof InitialSourcePlanError);
  assert.equal(failure.reason.code, "not_ready");
  assert.equal(await prisma.amuxIdeaSourcePlanRevision.count({ where: { ideaId } }), 1);
  assert.equal(await prisma.amuxIdeaAnalysisChunk.count({ where: { ideaId } }), 1);
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: "AMUX_V4_INITIAL_SOURCE_PLAN_CREATED",
      targetId: success.value.revisionId },
  }), 1);
});

test("unreviewed GitHub scope and mismatched owner cannot create an initial plan", async () => {
  const ideaId = await createIdea({ idea: "SYNTHETIC_GITHUB_SCOPE", repositories: ["mposition/Tomverse"] });
  const beforePlanAudits = await prisma.adminAuditLog.count({
    where: { action: "AMUX_V4_INITIAL_SOURCE_PLAN_CREATED" },
  });
  await assert.rejects(prisma.$transaction((tx) =>
    createInitialIdeaOnlySourcePlan(tx, { ideaId, actorUserId: `other-${actorUserId}`, keys })),
  (error: unknown) => error instanceof InitialSourcePlanError && error.code === "not_found");
  await assert.rejects(prisma.$transaction((tx) =>
    createInitialIdeaOnlySourcePlan(tx, { ideaId, actorUserId, keys })),
  (error: unknown) => error instanceof InitialSourcePlanError && error.code === "external_scope_required");
  assert.equal(await prisma.amuxIdeaSourcePlanRevision.count({ where: { ideaId } }), 0);
  assert.equal(await prisma.amuxIdeaAnalysisChunk.count({ where: { ideaId } }), 0);
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: "AMUX_V4_INITIAL_SOURCE_PLAN_CREATED" },
  }), beforePlanAudits);
});

test("source-plan row, idea pointer and canonical audit roll back together", async () => {
  const ideaId = await createIdea({ idea: "SYNTHETIC_ROLLBACK_PLAN" });
  let revisionId = "";
  let ownerAuditId = "";
  await assert.rejects(prisma.$transaction(async (tx) => {
    const result = await commitInitialIdeaSourcePlan(tx, { session, request, ideaId, keys });
    revisionId = result.revisionId;
    ownerAuditId = result.ownerAuditId;
    throw new Error("synthetic rollback");
  }), (error: unknown) => error instanceof Error && error.message === "synthetic rollback");
  assert.ok(revisionId, "the source plan must have been created before rollback");
  assert.ok(ownerAuditId, "the owner audit must have been created before rollback");
  const idea = await prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: ideaId } });
  assert.equal(idea.currentSourcePlanRevisionId, null);
  assert.equal(await prisma.amuxIdeaSourcePlanRevision.count({ where: { ideaId } }), 0);
  assert.equal(await prisma.amuxIdeaAnalysisChunk.count({ where: { ideaId } }), 0);
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: "AMUX_V4_INITIAL_SOURCE_PLAN_CREATED", targetId: revisionId },
  }), 0);
  assert.equal(await prisma.adminAuditLog.count({
    where: { id: ownerAuditId, action: "amux.v4.initial_source_plan.requested", targetId: ideaId },
  }), 0);
});
