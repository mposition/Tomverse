import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  MARKETING_COMMENT_ALERT_ACK_ACTION,
  MarketingStoreRefusedError,
  createMarketingChannel,
  evaluateMarketingAutoPause,
  insertMarketingReport,
  listMarketingPostsForCommentMonitor,
  listOpenMarketingCommentAlerts,
  recordMarketingCommentAlert,
  requireOpenMarketingCommentAlert,
  runMarketingTransaction,
} from "@/lib/marketingStore";
import {
  commentsMonitorEnabled,
  MARKETING_COMMENTS_MONITOR_ENV,
  MARKETING_COMMENTS_MONITOR_LAST_RUN_KEY,
} from "@/lib/marketingCommentsMonitorHealth";
import { marketingCommentsMonitorOperations } from "@/lib/marketingCommentsMonitorOperations";
import { answerMarketingCommentsMonitorRequest, marketingCommentBodyId } from "@/lib/marketingCommentsMonitorRequest";
import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";

beforeEach(async () => {
  await resetTestFixture(
    prisma,
    `TRUNCATE TABLE "MarketingPost", "MarketingChannel", "MarketingReport", "AiVisibilityRun", "MarketingLlmCall" RESTART IDENTITY CASCADE`,
  );
});

after(async () => {
  await prisma.$disconnect();
});

const alertFor = (postId: string, at = new Date()) =>
  insertMarketingReport(prisma, {
    kind: "comment_alerts",
    periodStart: at,
    periodEnd: at,
    sourceVersion: "comment-monitor-1",
    payload: {
      postId,
      alertCount: 2,
      riskCodes: ["legal_threat"],
      firstDetectedAt: at.toISOString(),
      externalUrlHost: "www.linkedin.com",
    },
  });

test("stored alert reports are listed as open, and one post's alert is found by its post id", async () => {
  await alertFor("post-a");
  await alertFor("post-b");
  const open = await listOpenMarketingCommentAlerts(prisma);
  assert.deepEqual(open.map((alert) => alert.postId).sort(), ["post-a", "post-b"]);

  await requireOpenMarketingCommentAlert(prisma, "post-a", "no-such-audit-entry");
  await assert.rejects(
    requireOpenMarketingCommentAlert(prisma, "post-c", "no-such-audit-entry"),
    (error) => error instanceof MarketingStoreRefusedError,
  );
});

// ---------------------------------------------------------------------------
// Against a real post, account and audit chain
// ---------------------------------------------------------------------------

const DIGEST = "e".repeat(64);
const DAY = 24 * 60 * 60 * 1000;
const operator = {
  user: { id: "operator-1", email: "owner@example.test" },
  expires: new Date(Date.now() + DAY).toISOString(),
} as unknown as Session;
const envelope = {
  channel: "linkedin",
  accountSlug: "linkedin-1",
  locale: "en",
  renderedText: "Three models, three answers, side by side.",
  claimIds: [],
  assets: [],
  finalUrl: null,
  scheduledAt: null,
  disclosureFlags: ["advertising"],
};

async function publishedPost(publishedDaysAgo = 0) {
  process.env.ADMIN_AUDIT_INTEGRITY_KEY ??= "comment-alerts-db-test-integrity-key-0123456789";
  const channel = await createMarketingChannel(prisma, {
    channel: "linkedin",
    provider: "zernio",
    externalAccountRef: `zernio-${Math.random().toString(36).slice(2)}`,
    defaultLocale: "en",
    allowedLocales: ["en"],
    scopesDigest: DIGEST,
    policyVersion: 1,
  } as Parameters<typeof createMarketingChannel>[1]);
  await prisma.marketingChannel.update({ where: { id: channel.id }, data: { status: "approval_mode" } });
  const key = `post-${Math.random().toString(36).slice(2)}`;
  await prisma.$executeRawUnsafe(`ALTER TABLE "MarketingPost" DISABLE TRIGGER "marketing_post_starts_as_one_draft"`);
  try {
    const post = await prisma.marketingPost.create({
      data: {
        channelId: channel.id,
        locale: "en",
        kind: "social",
        logicalKey: key,
        providerRequestKey: key,
        publishAttempt: 1,
        envelope,
        envelopeDigest: DIGEST,
        rendererVersion: "r1",
        claimIds: [],
        assetIds: [],
        claimRegistryVersion: 1,
        assetRegistryVersion: 1,
        factSnapshot: { priceRows: [], catalogue: null, modelRegistryRows: [], evidenceDigests: [] },
        factsDigest: DIGEST,
        guardDecision: "approval_required",
        guardCodes: [],
        guardRuleIds: [],
        status: "published",
        mode: "approval",
        approvalAuditLogId: `audit-${key}`,
        approvedDigest: DIGEST,
        approvedAt: new Date(),
        publishedAt: new Date(Date.now() - publishedDaysAgo * DAY),
        externalPostId: `ext-${key}`,
        externalUrl: "https://www.linkedin.com/feed/update/1",
        history: [{ at: new Date().toISOString(), type: "draft", envelopeDigest: DIGEST }],
        historyVersion: 0,
      },
    });
    return { post, channel };
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "MarketingPost" ENABLE TRIGGER "marketing_post_starts_as_one_draft"`);
  }
}

const record = (postId: string, answeredAtSeen: Date | null = null) =>
  runMarketingTransaction(prisma, (tx) =>
    recordMarketingCommentAlert(tx, {
      postId,
      alertCount: 2,
      riskCodes: ["legal_threat"],
      detectedAt: new Date(),
      answeredAtSeen,
      flaggedNewestAt: null,
    }),
  );

const acknowledge = (postId: string) =>
  runMarketingTransaction(prisma, (tx) =>
    writeAdminAuditLog({
      session: operator,
      action: MARKETING_COMMENT_ALERT_ACK_ACTION,
      targetType: "MarketingPost",
      targetId: postId,
      summary: "Marked a comment alert as handled.",
      metadata: { actorHadMarketingWrite: true },
      tx,
    }),
  );

test("an alert is recorded once, answered by the operator's entry, and can be raised again after the answer", async () => {
  const { post } = await publishedPost();
  assert.deepEqual(await record(post.id), { recorded: true });
  assert.deepEqual(await record(post.id), { recorded: false, reason: "already_open" });
  assert.equal((await listOpenMarketingCommentAlerts(prisma)).length, 1);

  await acknowledge(post.id);
  assert.deepEqual(await listOpenMarketingCommentAlerts(prisma), []);

  // The monitor judged these comments against no answer; one exists now.
  assert.deepEqual(await record(post.id, null), { recorded: false, reason: "answer_changed" });
  const answered = await prisma.adminAuditLog.findFirstOrThrow({
    where: { action: MARKETING_COMMENT_ALERT_ACK_ACTION, targetId: post.id },
  });
  assert.deepEqual(await record(post.id, answered.createdAt), { recorded: true });
  assert.equal((await listOpenMarketingCommentAlerts(prisma)).length, 1);
});

test("the stored alert carries counts and a host and nothing else", async () => {
  const { post } = await publishedPost();
  await record(post.id);
  const report = await prisma.marketingReport.findFirstOrThrow({ where: { kind: "comment_alerts" } });
  const payload = report.payload as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ["alertCount", "externalUrlHost", "firstDetectedAt", "postId", "riskCodes"]);
  assert.equal(payload.externalUrlHost, "www.linkedin.com");
  const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { action: "marketing_comment_alert.recorded" } });
  assert.equal(JSON.stringify(audit.metadata).includes("linkedin.com"), false);
});

test("an alert unanswered for a day stops the account; one answered meanwhile does not", async () => {
  const { post, channel } = await publishedPost();
  await record(post.id);
  const [alert] = await listOpenMarketingCommentAlerts(prisma);
  const stopFor = (firstDetectedAt: Date) =>
    runMarketingTransaction(prisma, (tx) =>
      evaluateMarketingAutoPause(tx, {
        channelId: channel.id,
        forcedReason: "unhandled_comment_alert",
        forcedAlerts: [{ postId: post.id, firstDetectedAt }],
        forcedOverdueBefore: new Date(firstDetectedAt.getTime() + 1_000),
      }),
    );

  // Answered between the list and the stop: the stop sees it under its lock.
  await acknowledge(post.id);
  assert.deepEqual(await stopFor(alert.firstDetectedAt), { paused: false });
  assert.equal((await prisma.marketingChannel.findUniqueOrThrow({ where: { id: channel.id } })).status, "approval_mode");

  // A new alert after the answer, unanswered and overdue: the account stops.
  const answered = await prisma.adminAuditLog.findFirstOrThrow({
    where: { action: MARKETING_COMMENT_ALERT_ACK_ACTION, targetId: post.id },
  });
  await record(post.id, answered.createdAt);
  const [renewed] = await listOpenMarketingCommentAlerts(prisma);
  const result = await stopFor(renewed.firstDetectedAt);
  assert.equal(result.paused && result.reasonCode, "unhandled_comment_alert");
  const stopped = await prisma.marketingChannel.findUniqueOrThrow({ where: { id: channel.id } });
  assert.equal(stopped.status, "paused");
  assert.equal(stopped.pauseReasonCode, "unhandled_comment_alert");
  assert.equal(stopped.pausedFromMode, "approval_mode");
});

test("the monitor reads live posts of connected accounts, paused ones included, and no others", async () => {
  const { post, channel } = await publishedPost();
  const listed = () => listMarketingPostsForCommentMonitor(prisma, { now: new Date(), limit: 10 });
  assert.deepEqual((await listed()).map((entry) => entry.id), [post.id]);

  await prisma.marketingChannel.update({ where: { id: channel.id }, data: { status: "paused", pauseReasonCode: "incident_review" } });
  assert.deepEqual((await listed()).map((entry) => entry.id), [post.id]);

  await prisma.marketingChannel.update({ where: { id: channel.id }, data: { status: "disconnected" } });
  assert.deepEqual(await listed(), []);

  // A post older than two weeks is no longer read (another account, so the first stays disconnected).
  await publishedPost(20);
  assert.deepEqual(await listed(), [], "older than two weeks");
});

test("the two steps against the real store: collect writes nothing, judge records the alert and the run as begun at the read", async () => {
  await prisma.appSetting.deleteMany({ where: { key: MARKETING_COMMENTS_MONITOR_LAST_RUN_KEY } });
  try {
    const { post } = await publishedPost();
    const readAt = new Date(Date.now() - 60_000);
    const written = new Date(readAt.getTime() - 60_000);
    const comments = [
      { text: "Love this", createdAt: written },
      { text: "My lawyer will be in touch", createdAt: written },
    ];
    let now = readAt;
    const deps = {
      env: { [MARKETING_COMMENTS_MONITOR_ENV]: "true" },
      enabled: commentsMonitorEnabled,
      now: () => now,
      fetchComments: async (target: { externalPostId: string }) =>
        target.externalPostId === post.externalPostId
          ? { kind: "ok" as const, comments, truncated: false }
          : { kind: "ok" as const, comments: [], truncated: false },
      operations: marketingCommentsMonitorOperations(prisma),
    };

    const collected = await answerMarketingCommentsMonitorRequest({ action: "collect" }, deps);
    const items = (collected.body as { items: Array<{ id: string; body: string }> }).items;
    assert.deepEqual(items.map((item) => item.body), comments.map((comment) => comment.text));
    assert.equal(await prisma.marketingReport.count({ where: { kind: "comment_alerts" } }), 0);
    assert.equal(await prisma.appSetting.count({ where: { key: MARKETING_COMMENTS_MONITOR_LAST_RUN_KEY } }), 0);

    now = new Date();
    const judged = await answerMarketingCommentsMonitorRequest(
      {
        action: "judge",
        readAt: readAt.toISOString(),
        verdicts: [
          { id: marketingCommentBodyId("Love this"), codes: [] },
          { id: marketingCommentBodyId("My lawyer will be in touch"), codes: ["legal_threat"] },
        ],
      },
      deps,
    );
    const result = (judged.body as { result: { complete: boolean; alertsRecorded: number } }).result;
    assert.deepEqual({ complete: result.complete, alertsRecorded: result.alertsRecorded }, { complete: true, alertsRecorded: 1 });
    const [alert] = await listOpenMarketingCommentAlerts(prisma);
    assert.equal(alert?.postId, post.id);
    const lastRun = await prisma.appSetting.findUniqueOrThrow({ where: { key: MARKETING_COMMENTS_MONITOR_LAST_RUN_KEY } });
    assert.equal(lastRun.value, readAt.toISOString());
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: MARKETING_COMMENTS_MONITOR_LAST_RUN_KEY } });
  }
});
