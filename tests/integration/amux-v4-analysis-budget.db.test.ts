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

async function confirmedPreviewId(): Promise<string> {
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
    modelId: "gpt-frontier-synthetic", reasoningEffort: "high" as const,
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
const pricing = () => ({ mode: "subscription_cli" as const,
  provider: "openai" as const, modelId: "gpt-frontier-synthetic",
  pricingVersion: "synthetic-price-v1",
  pricingVerifiedAt: new Date(Date.now() - 24 * 60 * 60_000).toISOString(),
  pricingExpiresAt: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
  worstTierVerified: true, tokenCapsEnforceable: true,
  billableToolsDisabled: true, inputTokensCap: 1_000,
  outputTokensCap: 2_000, inputMicroUsdPerMillion: 1_000_000,
  outputMicroUsdPerMillion: 2_000_000 });

test("confirmed preview reserves one agent-only budget hold and one system audit atomically", async () => {
  const previewId = await confirmedPreviewId();
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000) },
    update: { spentMicroUsd: BigInt(0), reservedMicroUsd: BigInt(0) },
  });
  const holdId = randomUUID();
  const result = await prisma.$transaction((tx) =>
    commitAmuxIdeaAnalysisBudgetReservation(tx,
      { holdId, previewId, pricing: pricing() }));
  assert.equal(result.reservedMicroUsd, "5000");
  const created = await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId },
  });
  assert.equal(created.previewId, previewId);
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
      { holdId: randomUUID(), previewId, pricing: pricing() })),
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

test("two confirmed previews cannot reserve the last monthly allowance twice", async () => {
  const previews = await Promise.all([confirmedPreviewId(), confirmedPreviewId()]);
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000),
      spentMicroUsd: BigInt(49_995_000) },
    update: { spentMicroUsd: BigInt(49_995_000), reservedMicroUsd: BigInt(0) },
  });
  const holds = previews.map(() => randomUUID());
  const results = await Promise.allSettled(previews.map((previewId, index) =>
    prisma.$transaction((tx) => commitAmuxIdeaAnalysisBudgetReservation(tx,
      { holdId: holds[index]!, previewId, pricing: pricing() }))));
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
