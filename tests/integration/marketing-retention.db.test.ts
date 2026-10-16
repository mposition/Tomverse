import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { runMarketingRetention } from "@/lib/marketingRetention";
import {
  MARKETING_RETENTION_ACTIONS,
  createMarketingChannel,
  insertMarketingReport,
} from "@/lib/marketingStore";
import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";

const DIGEST = "b".repeat(64);
const DAY = 24 * 60 * 60 * 1000;

const reset = () =>
  resetTestFixture(
    prisma,
    `TRUNCATE TABLE "MarketingPost", "MarketingChannel", "MarketingReport", "AiVisibilityRun" RESTART IDENTITY CASCADE`,
  );

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

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

async function channel() {
  return createMarketingChannel(prisma, {
    channel: "linkedin",
    provider: "zernio",
    externalAccountRef: `zernio-${Math.random().toString(36).slice(2)}`,
    defaultLocale: "en",
    allowedLocales: ["en"],
    scopesDigest: DIGEST,
    policyVersion: 1,
  } as Parameters<typeof createMarketingChannel>[1]);
}

/** A post row dated into the past, with the one-draft trigger off for the insert. */
async function agedPost(channelId: string, ageDays: number, overrides: Record<string, unknown> = {}) {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "MarketingPost" DISABLE TRIGGER "marketing_post_starts_as_one_draft"`,
  );
  try {
    return await prisma.marketingPost.create({
      data: {
        channelId,
        locale: "en",
        kind: "social",
        logicalKey: `post-${Math.random().toString(36).slice(2)}`,
        envelope,
        envelopeDigest: DIGEST,
        rendererVersion: "r1",
        claimIds: [],
        assetIds: [],
        claimRegistryVersion: 1,
        assetRegistryVersion: 1,
        factSnapshot: { priceRows: [], catalogue: null, modelRegistryRows: [], evidenceDigests: [] },
        factsDigest: DIGEST,
        guardDecision: "reject",
        guardCodes: [],
        guardRuleIds: [],
        status: "guard_rejected",
        mode: "approval",
        history: [{ at: new Date().toISOString(), type: "draft", envelopeDigest: DIGEST }],
        historyVersion: 0,
        createdAt: new Date(Date.now() - ageDays * DAY),
        ...overrides,
      },
    });
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "MarketingPost" ENABLE TRIGGER "marketing_post_starts_as_one_draft"`,
    );
  }
}

/** A webhook shadow report written as if 100 days ago (its retention is 90). */
async function agedShadowReport() {
  await prisma.$executeRawUnsafe(
    `ALTER TABLE "MarketingReport" DISABLE TRIGGER "marketing_report_sets_its_retention"`,
  );
  try {
    const createdAt = new Date(Date.now() - 100 * DAY);
    return await prisma.marketingReport.create({
      data: {
        kind: "webhook_shadow",
        periodStart: createdAt,
        periodEnd: createdAt,
        payload: {
          eventIdDigest: DIGEST,
          eventType: "post.published",
          channelId: "chn_1",
          derivedStatus: "published",
          statusQueryMatch: true,
        },
        sourceVersion: "test",
        createdAt,
        retentionUntil: new Date(createdAt.getTime() + 90 * DAY),
      },
    });
  } finally {
    await prisma.$executeRawUnsafe(
      `ALTER TABLE "MarketingReport" ENABLE TRIGGER "marketing_report_sets_its_retention"`,
    );
  }
}

const purgeAudits = (ids: string[]) =>
  prisma.adminAuditLog.findMany({
    where: { action: MARKETING_RETENTION_ACTIONS.rowPurged, targetId: { in: ids } },
    select: { targetType: true, targetId: true, metadata: true },
  });

test("expired reports and old rejected drafts go, each with its audit row, and the run is recorded", async () => {
  const row = await channel();
  const expired = await agedShadowReport();
  const fresh = await insertMarketingReport(prisma, {
    kind: "brief",
    periodStart: new Date(),
    periodEnd: new Date(),
    payload: { topicIds: [], claimIds: [], sourceDigests: [] },
    sourceVersion: "test",
  });
  const oldDraft = await agedPost(row.id, 100);
  const youngDraft = await agedPost(row.id, 30);
  const held = await agedPost(row.id, 100, { legalHold: true });
  const notDraft = await agedPost(row.id, 100, { status: "drafted", guardDecision: "approval_required" });

  const result = await runMarketingRetention(prisma);
  assert.deepEqual(result, { MarketingReport: 1, AiVisibilityRun: 0, MarketingPost: 1 });

  assert.equal(await prisma.marketingReport.count({ where: { id: expired.id } }), 0);
  assert.equal(await prisma.marketingReport.count({ where: { id: fresh.id } }), 1);
  assert.equal(await prisma.marketingPost.count({ where: { id: oldDraft.id } }), 0);
  for (const kept of [youngDraft, held, notDraft]) {
    assert.equal(await prisma.marketingPost.count({ where: { id: kept.id } }), 1, kept.status);
  }

  const audits = await purgeAudits([expired.id, oldDraft.id]);
  assert.deepEqual(
    audits.map((audit) => [audit.targetType, audit.targetId]).sort(),
    [
      ["MarketingPost", oldDraft.id],
      ["MarketingReport", expired.id],
    ].sort(),
  );
  for (const audit of audits) {
    assert.equal((audit.metadata as { systemActor?: string }).systemActor, "marketing-retention");
  }

  const runs = await prisma.marketingReport.findMany({ where: { kind: "retention_run" } });
  assert.deepEqual(
    runs.map((run) => {
      const payload = run.payload as { table: string; purgedRowCount: number };
      return [payload.table, payload.purgedRowCount];
    }).sort(),
    [
      ["MarketingPost", 1],
      ["MarketingReport", 1],
    ],
  );
});

test("a run with nothing due writes nothing", async () => {
  await channel();
  const result = await runMarketingRetention(prisma);
  assert.deepEqual(result, { MarketingReport: 0, AiVisibilityRun: 0, MarketingPost: 0 });
  assert.equal(await prisma.marketingReport.count({ where: { kind: "retention_run" } }), 0);
});

test("outside retention the same deletes are refused by the database", async () => {
  const row = await channel();
  const oldDraft = await agedPost(row.id, 100);
  await assert.rejects(
    prisma.marketingPost.delete({ where: { id: oldDraft.id } }),
    /only deleted by retention/,
  );
});
