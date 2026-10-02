import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { commitIdeaSubmission } from "@/lib/amux/ideaSubmissionService";
import { commitInitialIdeaSourcePlan } from "@/lib/amux/ideaInitialSourcePlanAccess";
import { commitIdeaOnlyTransferPreview } from "@/lib/amux/ideaTransferPreviewService";
import { commitIdeaTransferConfirmation } from "@/lib/amux/ideaTransferConfirmationService";
import { commitAmuxIdeaAnalysisBudgetReservation,
  AmuxIdeaAnalysisReservationError } from "@/lib/amux/ideaAnalysisBudgetReservationService";
import { commitAmuxIdeaAnalysisPriceApproval,
  AmuxIdeaAnalysisPriceApprovalError } from "@/lib/amux/ideaAnalysisPriceVersionWrite";
import { readApprovedAmuxIdeaAnalysisPriceVersion } from "@/lib/amux/ideaAnalysisPriceVersionRead";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";

const testUrl = process.env.TEST_DATABASE_URL?.trim();
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" ||
    process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: AMUX v4 budget DB test requires one dedicated loopback test database");
}

const actorUserId = `synthetic-amux-budget-owner-${randomUUID()}`;
const actorEmail = "amux-v4-budget-owner@example.test";
process.env.ADMIN_USER_IDS = actorUserId;
process.env.ADMIN_EMAILS = actorEmail;
process.env.ADMIN_OWNER_EMAILS = actorEmail;
process.env.ADMIN_AUDIT_INTEGRITY_KEY = `synthetic-audit-${randomUUID()}`;
const session = { user: { id: actorUserId, email: actorEmail,
  authenticatedAt: new Date().toISOString() },
expires: new Date(Date.now() + 60 * 60_000).toISOString() } as Session;
const request = new Request("https://tomverse.test/api/admin/amux/ideas/submissions",
  { method: "POST" });
const keys = { masterKeyId: "synthetic-master", masterKeyVersion: 1,
  masterKey: randomBytes(32), digestKeyId: "synthetic-digest", digestKey: randomBytes(32) };
const browserNonce = randomBytes(32).toString("base64url");
process.env.AMUX_V4_CONTENT_MASTER_KEY_ID = keys.masterKeyId;
process.env.AMUX_V4_CONTENT_MASTER_KEY_VERSION = String(keys.masterKeyVersion);
process.env.AMUX_V4_CONTENT_MASTER_KEY_B64 = keys.masterKey.toString("base64");
process.env.AMUX_V4_CONTENT_DIGEST_KEY_ID = keys.digestKeyId;
process.env.AMUX_V4_CONTENT_DIGEST_KEY_B64 = keys.digestKey.toString("base64");

after(async () => { await prisma.$disconnect(); });

async function confirmedPreviewId(modelId: string): Promise<string> {
  const ideaId = randomUUID();
  const inspected = inspectAmuxIdeaSubmission(JSON.stringify({
    version: 1, requestId: randomUUID(), input: { version: 1,
      idea: `SYNTHETIC_BUDGET_${randomUUID()}`, repositories: [], pullRequests: [] },
  }));
  if (!inspected.ok) throw new Error(inspected.code);
  await prisma.$transaction((tx) => commitIdeaSubmission(tx,
    { session, request, inspected, ideaId, keys }));
  await prisma.$transaction((tx) => commitInitialIdeaSourcePlan(tx,
    { session, request, ideaId, keys }));
  const choice = { previewId: randomUUID(), ideaId, provider: "openai" as const,
    modelId, reasoningEffort: "high" as const,
    approvalId: randomUUID(), approvalVersion: 1 };
  const prepared = await prisma.$transaction((tx) => commitIdeaOnlyTransferPreview(tx,
    { session, request, choice, keys, browserNonce }));
  await prisma.$transaction((tx) => commitIdeaTransferConfirmation(tx,
    { session, request, choice: { previewId: choice.previewId, ideaId,
      payloadDigest: prepared.payloadDigest,
      payloadDigestKeyId: prepared.payloadDigestKeyId }, browserNonce, keys }));
  return choice.previewId;
}

const namespace = "agent/amux-intake";
const monthStart = new Date(Date.UTC(new Date().getUTCFullYear(),
  new Date().getUTCMonth(), 1));
const runner = { tokenCapsEnforceable: true, billableToolsDisabled: true };
const modelId = () => `gpt-frontier-synthetic-${randomUUID()}`;

async function approvedPriceVersionId(provider: "openai" | "anthropic",
  selectedModelId: string, expiresInMs = 24 * 60 * 60_000): Promise<string> {
  const id = randomUUID();
  const verifiedAt = new Date(Date.now() - 24 * 60 * 60_000);
  const expiresAt = new Date(Date.now() + expiresInMs);
  const evidenceDigest = randomBytes(32).toString("hex");
  const approval = { id, provider, modelId: selectedModelId,
    mode: "subscription_cli" as const, expectedPreviousVersion: 0,
    inputTokensCap: 1_000, outputTokensCap: 2_000,
    inputMicroUsdPerMillion: 1_000_000,
    outputMicroUsdPerMillion: 2_000_000, evidenceDigest,
    ownerConfirmedWorstTier: true as const, verifiedAt, expiresAt };
  const result = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisPriceApproval(tx, { session, request, approval }));
  assert.equal(result.priceVersionId, id);
  assert.equal(result.version, 1);
  return id;
}

test("price evidence needs an owner and current version before it can authorize a hold", async () => {
  const selectedModelId = modelId();
  const id = await approvedPriceVersionId("openai", selectedModelId);
  const row = await prisma.amuxIdeaAnalysisPriceVersion.findUniqueOrThrow({
    where: { id },
  });
  const attempted = { id: randomUUID(), provider: "openai" as const,
    modelId: selectedModelId, mode: "subscription_cli" as const,
    expectedPreviousVersion: 0, inputTokensCap: 1_000,
    outputTokensCap: 2_000, inputMicroUsdPerMillion: 1_000_000,
    outputMicroUsdPerMillion: 2_000_000,
    evidenceDigest: randomBytes(32).toString("hex"),
    ownerConfirmedWorstTier: true as const,
    verifiedAt: new Date(Date.now() - 1_000),
    expiresAt: new Date(Date.now() + 60_000) };
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisPriceApproval(tx, { session, request,
      approval: attempted })), (error: unknown) =>
    error instanceof AmuxIdeaAnalysisPriceApprovalError &&
    error.code === "price_revision_changed");
  const notOwner = { ...session, user: { ...session.user,
    id: `other-${randomUUID()}`, email: "other@example.test" } } as Session;
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisPriceApproval(tx, { session: notOwner, request,
      approval: { ...attempted, modelId: modelId() } })), (error: unknown) =>
    error instanceof AmuxIdeaAnalysisPriceApprovalError &&
    error.code === "forbidden");
  assert.equal(await prisma.amuxIdeaAnalysisPriceVersion.count({
    where: { provider: "openai", modelId: selectedModelId,
      mode: "subscription_cli" },
  }), 1);
  assert.equal(row.status, "approved");
  assert.ok(Math.abs(row.approvedAt.getTime() - Date.now()) < 60_000);
  assert.ok(Math.abs(row.expiresAt.getTime() - Date.now() - 24 * 60 * 60_000) < 60_000);
  const expired = await prisma.$transaction((tx) =>
    readApprovedAmuxIdeaAnalysisPriceVersion(tx, {
      priceVersionId: id, provider: "openai", modelId: selectedModelId,
      now: new Date(row.expiresAt.getTime() + 1),
    }));
  assert.deepEqual(expired, { decision: "hold", reason: "price_unverified" });
});

test("confirmed preview reserves one agent-only budget hold and one system audit atomically", async () => {
  const selectedModelId = modelId();
  const previewId = await confirmedPreviewId(selectedModelId);
  const priceVersionId = await approvedPriceVersionId("openai", selectedModelId);
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000) },
    update: { spentMicroUsd: BigInt(0), reservedMicroUsd: BigInt(0) },
  });
  const holdId = randomUUID();
  const result = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisBudgetReservation(tx,
      { holdId, previewId, priceVersionId, runner, keys }));
  assert.equal(result.reservedMicroUsd, "5000");
  const created = await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId },
  });
  assert.equal(created.previewId, previewId);
  assert.equal(created.priceVersionId, priceVersionId);
  await assert.rejects(prisma.amuxIdeaAnalysisPriceVersion.update({
    where: { id: priceVersionId },
    data: { inputMicroUsdPerMillion: 1 },
  }), /price version may only be revoked once/);
  assert.equal(created.settledMicroUsd, null);
  assert.equal((await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  })).reservedMicroUsd, BigInt(5_000));
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetWindow.update({
    where: { namespace_monthStart: { namespace, monthStart } },
    data: { spentMicroUsd: BigInt(49_995_001) },
  }), /AmuxIdeaAnalysisBudgetWindow_total_check/);
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({
    where: { id: result.auditId },
  });
  assert.equal(audit.action, "AMUX_V4_ANALYSIS_BUDGET_RESERVED");
  assert.equal(audit.targetId, holdId);
  assert.equal((audit.metadata as Record<string, unknown>).modelCallStarted, false);
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisBudgetReservation(tx,
      { holdId: randomUUID(), previewId, priceVersionId, runner, keys })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisReservationError &&
    error.code === "already_reserved");
  assert.equal(await prisma.adminAuditLog.count({ where: {
    action: "AMUX_V4_ANALYSIS_BUDGET_RESERVED", targetType: "AmuxIdeaAnalysisBudgetHold",
    metadata: { path: ["previewId"], equals: previewId },
  } }), 1);
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetHold.create({
    data: { ...created, id: randomUUID() },
  }), (error: unknown) => error !== null && typeof error === "object" &&
    "code" in error && error.code === "P2002");
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetHold.update({
    where: { id: holdId }, data: { status: "released", settledMicroUsd: BigInt(0) },
  }), /AmuxIdeaAnalysisBudgetHold_lifecycle_check/);
  const stillReserved = await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId },
  });
  assert.equal(stillReserved.status, "reserved");
  assert.equal(stillReserved.settledMicroUsd, null);
  // Exercise unknown-state constraints without leaving a global halt behind
  // that would make the next isolated test run fail admission.
  for (const forbiddenStatus of ["owner_consumed", "released"] as const) {
    await assert.rejects(prisma.$transaction(async (tx) => {
      const dispatchedAt = new Date();
      await tx.amuxIdeaAnalysisBudgetHold.update({ where: { id: holdId },
        data: { status: "outcome_unknown", dispatchedAt } });
      await tx.amuxIdeaAnalysisBudgetHold.update({
        where: { id: holdId }, data: { status: forbiddenStatus,
        closedAt: dispatchedAt, settledMicroUsd: BigInt(0) },
      });
    }), /AmuxIdeaAnalysisBudgetHold_lifecycle_check/);
  }
  assert.equal((await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId },
  })).status, "reserved");
});

test("a price expiring in one minute still reserves under the DB UTC clock", async () => {
  const selectedModelId = modelId();
  const previewId = await confirmedPreviewId(selectedModelId);
  const priceVersionId = await approvedPriceVersionId("openai", selectedModelId, 60_000);
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000) },
    update: {},
  });
  const result = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisBudgetReservation(tx, {
      holdId: randomUUID(), previewId, priceVersionId, runner, keys,
    }));
  assert.equal(result.reservedMicroUsd, "5000");
});

test("a price for another provider cannot reserve the confirmed model payload", async () => {
  const selectedModelId = modelId();
  const previewId = await confirmedPreviewId(selectedModelId);
  const priceVersionId = await approvedPriceVersionId("anthropic", selectedModelId);
  const holdId = randomUUID();
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisBudgetReservation(tx,
      { holdId, previewId, priceVersionId, runner, keys })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisReservationError &&
    error.code === "budget_hold" && error.reason === "price_unverified");
  assert.equal(await prisma.amuxIdeaAnalysisBudgetHold.count({
    where: { id: holdId },
  }), 0);
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: "AMUX_V4_ANALYSIS_BUDGET_RESERVED", targetId: holdId },
  }), 0);
});

test("new holds cannot bypass the server-owned price version", async () => {
  const selectedModelId = modelId();
  const previewId = await confirmedPreviewId(selectedModelId);
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetHold.create({ data: {
    id: randomUUID(), previewId, namespace, monthStart,
    mode: "subscription_cli", provider: "openai", modelId: selectedModelId,
    pricingVersion: "caller-supplied", inputTokensCap: 1_000,
    outputTokensCap: 2_000, inputMicroUsdPerMillion: 1_000_000,
    outputMicroUsdPerMillion: 2_000_000,
    reservedMicroUsd: BigInt(5_000), status: "reserved",
  } }), /AmuxIdeaAnalysisBudgetHold_new_price_required_check/);
});

test("revoked price evidence cannot authorize another reservation", async () => {
  const selectedModelId = modelId();
  const previewId = await confirmedPreviewId(selectedModelId);
  const priceVersionId = await approvedPriceVersionId("openai", selectedModelId);
  await prisma.$transaction(async (tx) => {
    const revokedAt = new Date();
    const revocationAuditLogId = await writeAdminAuditLog({ tx, session, request,
      action: "amux.v4.analysis_price.revoked",
      targetType: "AmuxIdeaAnalysisPriceVersion", targetId: priceVersionId,
      summary: "Synthetic owner revocation of one analysis price version.",
      metadata: { revokedAt: revokedAt.toISOString(), modelCallStarted: false },
    });
    await tx.amuxIdeaAnalysisPriceVersion.update({
      where: { id: priceVersionId },
      data: { status: "revoked", revokedAt, revocationAuditLogId },
    });
  });
  const holdId = randomUUID();
  await assert.rejects(prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisBudgetReservation(tx,
      { holdId, previewId, priceVersionId, runner, keys })),
  (error: unknown) => error instanceof AmuxIdeaAnalysisReservationError &&
    error.code === "budget_hold" && error.reason === "price_unverified");
  assert.equal(await prisma.amuxIdeaAnalysisBudgetHold.count({
    where: { id: holdId },
  }), 0);
});

test("two confirmed previews cannot reserve the last monthly allowance twice", async () => {
  const selectedModelId = modelId();
  const priceVersionId = await approvedPriceVersionId("openai", selectedModelId);
  const previews = await Promise.all([
    confirmedPreviewId(selectedModelId), confirmedPreviewId(selectedModelId),
  ]);
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000),
      spentMicroUsd: BigInt(49_995_000) },
    update: { spentMicroUsd: BigInt(49_995_000), reservedMicroUsd: BigInt(0) },
  });
  const holds = previews.map(() => randomUUID());
  const results = await Promise.allSettled(previews.map((previewId, index) =>
    prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
      { holdId: holds[index]!, previewId, priceVersionId, runner, keys }))));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert(rejected?.status === "rejected" &&
    rejected.reason instanceof AmuxIdeaAnalysisReservationError &&
    rejected.reason.code === "budget_hold" &&
    rejected.reason.reason === "monthly_cap_exceeded");
  assert.equal((await prisma.amuxIdeaAnalysisBudgetWindow.findUniqueOrThrow({
    where: { namespace_monthStart: { namespace, monthStart } },
  })).reservedMicroUsd, BigInt(5_000));
  assert.equal(await prisma.amuxIdeaAnalysisBudgetHold.count({
    where: { id: { in: holds } },
  }), 1);
  assert.equal(await prisma.adminAuditLog.count({
    where: { action: "AMUX_V4_ANALYSIS_BUDGET_RESERVED", targetId: { in: holds } },
  }), 1);
});

test("budget window rejects another namespace or a larger monthly cap", async () => {
  const invalidMonth = new Date("2026-11-01T00:00:00.000Z");
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetWindow.create({
    data: { namespace: "user-credit", monthStart: invalidMonth,
      limitMicroUsd: BigInt(50_000_000) },
  }), /AmuxIdeaAnalysisBudgetWindow_namespace_check/);
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetWindow.create({
    data: { namespace, monthStart: invalidMonth,
      limitMicroUsd: BigInt(50_000_001) },
  }), /AmuxIdeaAnalysisBudgetWindow_amount_check/);
});
