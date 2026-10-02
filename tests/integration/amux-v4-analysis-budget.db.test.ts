import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Session } from "next-auth";

import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { commitIdeaSubmission } from "@/lib/amux/ideaSubmissionService";
import { commitInitialIdeaSourcePlan } from "@/lib/amux/ideaInitialSourcePlanAccess";
import { commitIdeaOnlyTransferPreview } from "@/lib/amux/ideaTransferPreviewService";
import { commitIdeaTransferConfirmation } from "@/lib/amux/ideaTransferConfirmationService";
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
const monthStart = new Date("2026-10-01T00:00:00.000Z");

test("analysis budget migration accepts one exact confirmed preview hold", async () => {
  const previewId = await confirmedPreviewId();
  await prisma.amuxIdeaAnalysisBudgetWindow.upsert({
    where: { namespace_monthStart: { namespace, monthStart } },
    create: { namespace, monthStart, limitMicroUsd: BigInt(50_000_000) },
    update: {},
  });
  const holdId = randomUUID();
  const created = await prisma.amuxIdeaAnalysisBudgetHold.create({ data: {
    id: holdId, previewId, namespace, monthStart, mode: "subscription_cli",
    provider: "openai", modelId: "gpt-frontier-synthetic",
    pricingVersion: "synthetic-price-v1", inputTokensCap: 1_000,
    outputTokensCap: 2_000, inputMicroUsdPerMillion: 1_000_000,
    outputMicroUsdPerMillion: 2_000_000, reservedMicroUsd: BigInt(5_000),
    status: "reserved",
  } });
  assert.equal(created.previewId, previewId);
  assert.equal(created.settledMicroUsd, null);
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
  const dispatchedAt = new Date();
  await prisma.amuxIdeaAnalysisBudgetHold.update({ where: { id: holdId },
    data: { status: "outcome_unknown", dispatchedAt } });
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetHold.update({
    where: { id: holdId }, data: { status: "owner_consumed",
      closedAt: dispatchedAt, settledMicroUsd: BigInt(0) },
  }), /AmuxIdeaAnalysisBudgetHold_lifecycle_check/);
  await assert.rejects(prisma.amuxIdeaAnalysisBudgetHold.update({
    where: { id: holdId }, data: { status: "released",
      closedAt: dispatchedAt, settledMicroUsd: BigInt(0) },
  }), /AmuxIdeaAnalysisBudgetHold_lifecycle_check/);
  assert.equal((await prisma.amuxIdeaAnalysisBudgetHold.findUniqueOrThrow({
    where: { id: holdId },
  })).status, "outcome_unknown");
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
