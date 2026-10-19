import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { Session } from "next-auth";

import { commitAmuxIntakeRegistration } from "@/lib/amux/intakeRegistration";
import { amuxIntakeDraftDigest, parseAmuxIntakeDraft } from
  "@/lib/amux/intakeCore";
import { planAmuxIntakeRegistration } from
  "@/lib/amux/intakeRegistrationCore";
import { boardPromotionExecutionBriefDigest } from "@/lib/amux/boardPromotionCore";
import { buildAmuxDeliveryPrompt } from "@/lib/amux/deliveryPrompt";
import {
  chatUnifiedOptimizerAmuxCandidateBrief,
  chatUnifiedOptimizerAmuxCandidateRequestId,
  classifyChatUnifiedOptimizerAmuxCandidateAttempt,
  recordChatUnifiedOptimizerAmuxCandidate,
} from "@/lib/chatUnifiedOptimizerAmuxCandidateStore";
import { CHAT_UNIFIED_OPTIMIZER_PUBLIC_SET_PATH } from
  "@/lib/chatUnifiedOptimizerCandidateGeneration";
import type { createChatUnifiedOptimizerPublicCollector } from
  "@/lib/chatUnifiedOptimizerPublicCollector";
import { CHAT_UNIFIED_ROUTER_REFINER_TASK_GUIDANCE } from
  "@/lib/chatUnifiedRouterRefinerPrompt";

const rawUrl = process.env.TEST_DATABASE_URL?.trim();

test("a disposable AMUX test card records an exact public candidate and readback", {
  skip: !rawUrl,
}, async t => {
  if (!rawUrl) return;
  const url = new URL(rawUrl);
  assert.match(decodeURIComponent(url.pathname), /(?:^|[_-])test(?:[_-]|$)/);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname));
  const previousDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = rawUrl;
  const previousAuthSecret = process.env.NEXTAUTH_SECRET;
  process.env.NEXTAUTH_SECRET ||=
    "chat-unified-optimizer-amux-test-card-synthetic-key";
  const { prisma } = await import("@/lib/prisma");
  const sourceBytes = Buffer.from(readFileSync(new URL(
    "../fixtures/chat-unified-optimizer/public-development-v1.json",
    import.meta.url)));
  const sourcePin = {
    repositoryId: 654,
    commitSha: "c".repeat(40),
    blobSha: createHash("sha1").update(
      `blob ${sourceBytes.length}\0`).update(sourceBytes).digest("hex"),
    sha256: createHash("sha256").update(sourceBytes).digest("hex"),
  };
  const previousPin = process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_PUBLIC_PIN;
  const previousSecret = process.env.TOMVERSE_AMUX_SYNC_SECRET;
  const previousV4TaskId =
    process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_V4_TASK_ID;
  const previousTestTaskId =
    process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_TEST_TASK_ID;
  const attemptId = randomUUID();
  process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_PUBLIC_PIN =
    JSON.stringify(sourcePin);
  process.env.TOMVERSE_AMUX_SYNC_SECRET = "amux-test-card-local-secret-only-000000000000";
  delete process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_V4_TASK_ID;
  t.after(async () => {
    try {
      const cycle = await prisma.chatUnifiedOptimizerCycle.findUnique({
        where: { registrationRequestId:
          chatUnifiedOptimizerAmuxCandidateRequestId(attemptId,
            "registration") },
        select: { id: true, state: true },
      });
      if (cycle) {
        assert.equal(cycle.state, "active");
        const { closeChatUnifiedOptimizerQueuedJobs } = await import(
          "@/lib/chatUnifiedOptimizerLedgerStore");
        const closed = await closeChatUnifiedOptimizerQueuedJobs({
          requestId: randomUUID(), cycleId: cycle.id,
          reason: "cancelled_before_dispatch",
        });
        assert.equal(closed.outcome, "closed");
        assert.equal(closed.cycleState, "failed");
      }
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousAuthSecret === undefined) delete process.env.NEXTAUTH_SECRET;
      else process.env.NEXTAUTH_SECRET = previousAuthSecret;
      if (previousPin === undefined)
        delete process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_PUBLIC_PIN;
      else process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_PUBLIC_PIN = previousPin;
      if (previousSecret === undefined)
        delete process.env.TOMVERSE_AMUX_SYNC_SECRET;
      else process.env.TOMVERSE_AMUX_SYNC_SECRET = previousSecret;
      if (previousV4TaskId === undefined)
        delete process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_V4_TASK_ID;
      else process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_V4_TASK_ID =
        previousV4TaskId;
      if (previousTestTaskId === undefined)
        delete process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_TEST_TASK_ID;
      else process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_TEST_TASK_ID =
        previousTestTaskId;
      await prisma.$disconnect();
    }
  });

  const brief = chatUnifiedOptimizerAmuxCandidateBrief(sourcePin);
  const digest = boardPromotionExecutionBriefDigest(brief);
  const intakeDraft = { canonicalizationVersion: "amux-json-v1" as const,
    policyVersion: 1 as const, explicitRegistration: true as const,
    sourceTaskId: `u21-test-${randomUUID()}`, workItem: null,
    proposal: { title: "Disposable U21 public candidate test card",
      scope: "One isolated public candidate author test card",
      completion: "A public candidate receipt is recorded",
      priority: "p3" as const } };
  const parsedDraft = parseAmuxIntakeDraft(JSON.stringify(intakeDraft));
  assert.equal(parsedDraft.ok, true);
  if (!parsedDraft.ok) return;
  const planned = planAmuxIntakeRegistration(JSON.stringify({ ...intakeDraft,
    confirmationDigest: amuxIntakeDraftDigest(parsedDraft.draft) }),
  "u21-synthetic-intake-secret-only-000000000000");
  assert.equal(planned.ok, true);
  if (!planned.ok) return;
  const session = { user: { id: `u21-${randomUUID()}`,
    email: "u21@example.test" }, expires: new Date(Date.now() + 60_000)
    .toISOString() } as Session;
  const intake = await prisma.$transaction(tx =>
    commitAmuxIntakeRegistration(tx, { session,
      request: new Request("https://tomverse.test/api/admin/amux/intake"),
      plan: planned.plan, approvalId: randomUUID() }));
  assert.equal(intake.created, true);
  const backlog = await prisma.amuxWorkItem.findUniqueOrThrow({
    where: { id: intake.cardId } });
  assert.equal(backlog.status, "backlog");
  assert.equal(backlog.sourceSystem, "codex-conversation");
  assert.match(backlog.sourceKey ?? "", /^[A-F0-9]{64}$/);
  // The disposable DB supplies the explicit owner promotion/assignment fact;
  // the production board-promotion approval remains a separate gate.
  const card = await prisma.amuxWorkItem.update({ where: { id: intake.cardId },
    data: { status: "doing", owner: "codex-impl", kind: "code", revision: 1,
      executionBrief: brief, executionBriefDigest: digest } });
  process.env.TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_TEST_TASK_ID = card.id;
  const instanceId = randomUUID();
  const startedAt = new Date(Date.now() - 1_000);
  const acknowledgedAt = new Date();
  await prisma.amuxExecutionAttempt.create({ data: {
    id: attemptId, taskId: card.id, worker: "codex-impl",
    workerInstanceId: instanceId, workerGeneration: 1,
    taskRevision: 1, attemptNumber: 1, heartbeatAt: acknowledgedAt,
    startedAt, leaseExpiresAt: new Date(Date.now() + 300_000),
  } });
  await prisma.amuxWorkDelivery.create({ data: {
    attemptId, taskId: card.id, worker: "codex-impl",
    workerInstanceId: instanceId, workerGeneration: 1,
    taskRevision: 1, status: "acknowledged", receiptId: randomUUID(),
    leasedAt: startedAt, acknowledgedAt,
    prompt: buildAmuxDeliveryPrompt({ taskId: card.id,
      title: card.title, description: card.description,
      kind: card.kind, priority: card.priority,
      worker: "codex-impl", attemptId, attemptNumber: 1,
      taskRevision: 1, executionBrief: brief,
      executionBriefDigest: digest, previousAttempt: null }),
  } });
  assert.deepEqual(
    await classifyChatUnifiedOptimizerAmuxCandidateAttempt(attemptId),
    { target: true, eligible: true });

  const trees = ["d", "e", "f", "a"].map(value => value.repeat(40));
  const segments = CHAT_UNIFIED_OPTIMIZER_PUBLIC_SET_PATH.split("/");
  const collector = (() => ({
    async readRepository() {
      return { id: sourcePin.repositoryId, fullName: "mposition/Tomverse",
        private: false, authenticated: false };
    },
    fileAdapter: {
      async readCommit() {
        return { repositoryId: sourcePin.repositoryId,
          sha: sourcePin.commitSha, treeSha: trees[0]! };
      },
      async readTree(sha: string) {
        const index = trees.indexOf(sha);
        const last = index === segments.length - 1;
        return { repositoryId: sourcePin.repositoryId, sha, truncated: false,
          entries: [{ path: segments[index]!,
            type: last ? "blob" as const : "tree" as const,
            mode: last ? "100644" : "040000",
            sha: last ? sourcePin.blobSha : trees[index + 1]!,
            size: last ? sourceBytes.length : null }] };
      },
      async readBlob() {
        return { repositoryId: sourcePin.repositoryId,
          sha: sourcePin.blobSha, size: sourceBytes.length,
          bytes: sourceBytes };
      },
    },
  })) as typeof createChatUnifiedOptimizerPublicCollector;
  const resultText = JSON.stringify({
    taskGuidance: CHAT_UNIFIED_ROUTER_REFINER_TASK_GUIDANCE,
    publicExampleRefs: ["public:synthetic-format"],
  });
  const resultSha256 = createHash("sha256").update(resultText).digest("hex");
  const input = { attemptId, worker: "codex-impl" as const,
    instanceId, generation: 1, taskRevision: 1, sourcePin,
    resultText, resultSha256 };
  const recorded = await recordChatUnifiedOptimizerAmuxCandidate(input,
    { collector });
  assert.equal(recorded.outcome, "recorded");
  assert.equal(recorded.completion, "write");
  assert.equal(recorded.proposalValidationReceipt.authorshipVerified, false);
  const readbackRoute = await import(
    "@/app/api/internal/chat-optimization/amux-candidate/route");
  const readback = await readbackRoute.GET(new Request(
    `https://tomverse.test/api/internal/chat-optimization/amux-candidate?attemptId=${attemptId}`,
    { headers: { Authorization:
      `Bearer ${process.env.TOMVERSE_AMUX_SYNC_SECRET}` } }));
  assert.equal(readback.status, 200);
  const body = await readback.json();
  assert.equal(body.status, "recorded");
  assert.equal(body.attemptId, attemptId);
  assert.equal(body.resultSha256, resultSha256);
  assert.equal(body.candidateDigest,
    recorded.proposalValidationReceipt.candidateDigest);
  assert.equal(body.authorshipVerified, false);
  assert.equal(JSON.stringify(body).includes("taskGuidance"), false);

  const replay = await recordChatUnifiedOptimizerAmuxCandidate(input,
    { collector });
  assert.equal(replay.outcome, "recorded");
  assert.equal(replay.completion, "replay");
  const duplicate = await prisma.chatUnifiedOptimizerCycle.count({
    where: { id: recorded.cycleId },
  });
  assert.equal(duplicate, 1);
});
