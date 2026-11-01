import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  MARKETING_GRADUATE_ACTION,
  MarketingStoreRefusedError,
  createMarketingChannel,
  graduateMarketingChannel,
  runMarketingTransaction,
} from "@/lib/marketingStore";
import { marketingGraduationSnapshotSchema } from "@/lib/marketingAutomationSchema";
import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";

const DIGEST = "d".repeat(64);
const DAY = 24 * 60 * 60 * 1000;

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

const operator = {
  user: { id: "operator-1", email: "owner@example.test" },
  expires: new Date(Date.now() + DAY).toISOString(),
} as unknown as Session;

beforeEach(async () => {
  process.env.ADMIN_AUDIT_INTEGRITY_KEY ??= "graduation-db-test-integrity-key-0123456789";
  await resetTestFixture(
    prisma,
    `TRUNCATE TABLE "MarketingPost", "MarketingChannel", "MarketingReport", "AiVisibilityRun", "MarketingLlmCall" RESTART IDENTITY CASCADE`,
  );
});

after(async () => {
  await prisma.$disconnect();
});

async function approvalChannel(channel = "linkedin") {
  const row = await createMarketingChannel(prisma, {
    channel,
    provider: "zernio",
    externalAccountRef: `zernio-${Math.random().toString(36).slice(2)}`,
    defaultLocale: "en",
    allowedLocales: ["en"],
    scopesDigest: DIGEST,
    policyVersion: 1,
  } as Parameters<typeof createMarketingChannel>[1]);
  return prisma.marketingChannel.update({ where: { id: row.id }, data: { status: "approval_mode" } });
}

/** A post a person approved and the platform published `publishedDaysAgo` days ago. */
async function approvedPost(channelId: string, publishedDaysAgo: number, history: Array<Record<string, string | number | boolean | null>> = []) {
  const key = `post-${Math.random().toString(36).slice(2)}`;
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "MarketingPost" DISABLE TRIGGER "marketing_post_starts_as_one_draft"`,
  );
  try {
    return await prisma.marketingPost.create({
      data: {
        channelId,
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
        approvedAt: new Date(Date.now() - (publishedDaysAgo + 1) * DAY),
        publishedAt: new Date(Date.now() - publishedDaysAgo * DAY),
        externalPostId: `ext-${key}`,
        externalUrl: "https://www.linkedin.com/feed/update/1",
        history: [{ at: new Date().toISOString(), type: "draft", envelopeDigest: DIGEST }, ...history],
        historyVersion: 0,
      },
    });
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "MarketingPost" ENABLE TRIGGER "marketing_post_starts_as_one_draft"`,
    );
  }
}

/** The operator's confirmation entry and the graduation, in one transaction as the route does it. */
const graduate = (
  channelId: string,
  options: { epoch?: number; healthy?: boolean; auditLogId?: string } = {},
) =>
  runMarketingTransaction(prisma, async (tx) => {
    const auditLogId =
      options.auditLogId ??
      (await writeAdminAuditLog({
        session: operator,
        action: MARKETING_GRADUATE_ACTION,
        targetType: "MarketingChannel",
        targetId: channelId,
        summary: "Graduated a brand account to autonomous publishing.",
        metadata: { graduationEpoch: options.epoch ?? 0, actorHadMarketingWrite: true },
        tx,
      }));
    return graduateMarketingChannel(tx, {
      id: channelId,
      auditLogId,
      expectedGraduationEpoch: options.epoch ?? 0,
      commentsMonitorHealthy: options.healthy ?? true,
    });
  });

test("an account that meets every condition graduates: the database accepts the move and keeps the snapshot", async () => {
  const row = await approvalChannel();
  await approvedPost(row.id, 8);
  await approvedPost(row.id, 3);
  await approvedPost(row.id, 2);

  const result = await graduate(row.id);
  assert.equal(result.graduated, true);

  const after = await prisma.marketingChannel.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(after.status, "autonomous_mode");
  assert.ok(after.graduatedAt);
  const snapshot = marketingGraduationSnapshotSchema.parse(after.graduationSnapshot);
  assert.equal(snapshot.approvedPostCount, 3);
  assert.equal(snapshot.graduationEpoch, 0);
  assert.equal(snapshot.operatorEditRate, 0);
  const audits = await prisma.adminAuditLog.findMany({
    where: { action: MARKETING_GRADUATE_ACTION, targetId: row.id },
  });
  assert.equal(audits.length, 1);
  assert.equal(snapshot.approvalAuditLogId, audits[0].id);
});

test("a refused graduation changes nothing: unmet conditions are answered, not thrown", async () => {
  const row = await approvalChannel();
  await approvedPost(row.id, 8);
  await approvedPost(row.id, 3);
  // Two approvals, and a monitor that is not running.
  const result = await graduate(row.id, { healthy: false });
  assert.deepEqual(result, {
    graduated: false,
    unmet: ["approvals_below_minimum", "comments_monitor_unhealthy"],
  });
  assert.equal((await prisma.marketingChannel.findUniqueOrThrow({ where: { id: row.id } })).status, "approval_mode");
});

test("seven days are counted from the first success: three approvals published two days ago are not enough", async () => {
  const row = await approvalChannel();
  await approvedPost(row.id, 2);
  await approvedPost(row.id, 2);
  await approvedPost(row.id, 1);
  const result = await graduate(row.id);
  assert.deepEqual(result, { graduated: false, unmet: ["first_success_too_recent"] });
});

test("edits count against the account: two edited approvals in three are more than a third", async () => {
  const row = await approvalChannel();
  const edit = [{ at: new Date().toISOString(), type: "edit_revision", envelopeDigest: DIGEST, previousEnvelopeDigest: DIGEST, byAuditLogId: "audit-edit" }];
  await approvedPost(row.id, 8, edit);
  await approvedPost(row.id, 3, edit);
  await approvedPost(row.id, 2);
  const result = await graduate(row.id);
  assert.deepEqual(result, { graduated: false, unmet: ["edit_rate_above_limit"] });
});

test("Instagram never graduates", async () => {
  const row = await approvalChannel("instagram");
  await approvedPost(row.id, 8);
  await approvedPost(row.id, 3);
  await approvedPost(row.id, 2);
  const result = await graduate(row.id);
  assert.equal(result.graduated, false);
  assert.ok(!result.graduated && result.unmet.includes("channel_never_graduates"));
  assert.equal((await prisma.marketingChannel.findUniqueOrThrow({ where: { id: row.id } })).status, "approval_mode");
});

test("a page read in an earlier approval period is refused, and a confirmation that is not evidence is refused", async () => {
  const row = await approvalChannel();
  await approvedPost(row.id, 8);
  await approvedPost(row.id, 3);
  await approvedPost(row.id, 2);

  await assert.rejects(
    graduate(row.id, { epoch: 5 }),
    (error) => error instanceof MarketingStoreRefusedError && error.code === "channel_changed_under_us",
  );
  await assert.rejects(
    graduate(row.id, { auditLogId: "no-such-entry" }),
    (error) => error instanceof MarketingStoreRefusedError && error.code === "audit_evidence_entry_missing",
  );
  assert.equal((await prisma.marketingChannel.findUniqueOrThrow({ where: { id: row.id } })).status, "approval_mode");
});

test("a graduated account stays graduated across a pause and resumes into approval mode with the graduation cleared", async () => {
  const row = await approvalChannel();
  await approvedPost(row.id, 8);
  await approvedPost(row.id, 3);
  await approvedPost(row.id, 2);
  await graduate(row.id);
  await prisma.marketingChannel.update({ where: { id: row.id }, data: { status: "paused", pauseReasonCode: "incident_review" } });
  const paused = await prisma.marketingChannel.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(paused.pausedFromMode, "autonomous_mode");
  // Back to approval mode: the trigger clears the graduation, so it has to be earned again.
  await prisma.marketingChannel.update({ where: { id: row.id }, data: { status: "approval_mode", pauseReasonCode: null } });
  const back = await prisma.marketingChannel.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(back.graduatedAt, null);
  assert.equal(back.graduationSnapshot, null);
});
