import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { Prisma } from "@prisma/client";

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
  assert.deepEqual(result, {
    MarketingReport: 1,
    AiVisibilityRun: 0,
    MarketingPost: 1,
    MarketingLlmCall: 0,
    MarketingPostContent: 0,
    MarketingPostHistory: 0,
  });

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
  assert.deepEqual(result, {
    MarketingReport: 0,
    AiVisibilityRun: 0,
    MarketingPost: 0,
    MarketingLlmCall: 0,
    MarketingPostContent: 0,
    MarketingPostHistory: 0,
  });
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

// ---------------------------------------------------------------------------
// S3h2: posts that are kept -- content after 24 months, history after 90 days
// ---------------------------------------------------------------------------

const ago = (days: number) => new Date(Date.now() - days * DAY);
const iso = (days: number) => ago(days).toISOString();

/** A post that reached a platform carries its own key as the request key. */
function dispatched() {
  const key = `post-${Math.random().toString(36).slice(2)}`;
  return { logicalKey: key, providerRequestKey: key };
}

const auditsFor = (action: string, ids: string[]) =>
  prisma.adminAuditLog.findMany({
    where: { action, targetId: { in: ids } },
    select: { targetId: true, metadata: true },
  });

test("content goes twenty-four months after publication; the row, its digest and its history stay", async () => {
  const row = await channel();
  const published = () => ({ status: "removed_by_platform", publishAttempt: 1, ...dispatched() });
  const due = await agedPost(row.id, 800, { ...published(), publishedAt: ago(770) });
  const recentlyPublished = await agedPost(row.id, 800, { ...published(), publishedAt: ago(300) });
  const held = await agedPost(row.id, 800, { ...published(), publishedAt: ago(770), legalHold: true });
  // Old enough for the trigger, but a failed post can still be re-queued
  // against its content, so retention leaves it.
  const failed = await agedPost(row.id, 800, {
    status: "failed",
    publishAttempt: 1,
    ...dispatched(),
    history: [
      { at: iso(800), type: "draft", envelopeDigest: DIGEST },
      { at: iso(790), type: "attempt", attempt: 1, outcome: "failed", errorCode: null },
    ],
  });

  const result = await runMarketingRetention(prisma);
  assert.equal(result.MarketingPostContent, 1);

  const after = await prisma.marketingPost.findUniqueOrThrow({ where: { id: due.id } });
  assert.equal(after.envelope, null);
  assert.ok(after.contentPurgedAt instanceof Date);
  assert.equal(after.envelopeDigest, due.envelopeDigest);
  assert.deepEqual(after.history, due.history);
  assert.equal(after.historyVersion, due.historyVersion);
  for (const kept of [recentlyPublished, held, failed]) {
    const still = await prisma.marketingPost.findUniqueOrThrow({ where: { id: kept.id } });
    assert.notEqual(still.envelope, null, kept.id);
    assert.equal(still.contentPurgedAt, null, kept.id);
  }

  const audits = await auditsFor(MARKETING_RETENTION_ACTIONS.contentPurged, [
    due.id,
    recentlyPublished.id,
    held.id,
    failed.id,
  ]);
  assert.deepEqual(audits.map((audit) => audit.targetId), [due.id]);
  assert.equal((audits[0].metadata as { systemActor?: string }).systemActor, "marketing-retention");

  const runs = await prisma.marketingReport.findMany({ where: { kind: "retention_run" } });
  assert.deepEqual(
    runs.map((run) => run.payload),
    [
      {
        startedAt: (runs[0].payload as { startedAt: string }).startedAt,
        table: "MarketingPost",
        purgedRowCount: 0,
        compactedRowCount: 1,
      },
    ],
  );

  // Done once: the next run finds nothing.
  assert.equal((await runMarketingRetention(prisma)).MarketingPostContent, 0);
});

test("attempt and webhook entries older than ninety days become a summary, and only those", async () => {
  const row = await channel();
  const draftEntry = { at: iso(200), type: "draft", envelopeDigest: DIGEST };
  const oldAttempt = { at: iso(150), type: "attempt", attempt: 1, outcome: "published", errorCode: null };
  const oldWebhook = { at: iso(140), type: "webhook_event", eventIdDigest: DIGEST, eventType: "post.published" };
  const youngWebhook = { at: iso(10), type: "webhook_event", eventIdDigest: DIGEST, eventType: "post.removed" };
  const history = [draftEntry, oldAttempt, oldWebhook, youngWebhook];
  const published = () => ({
    status: "removed_by_platform",
    publishAttempt: 1,
    publishedAt: ago(150),
    history,
    ...dispatched(),
  });

  const due = await agedPost(row.id, 200, published());
  const held = await agedPost(row.id, 200, { ...published(), legalHold: true });
  const failedOnly = await agedPost(row.id, 200, {
    status: "failed",
    publishAttempt: 1,
    ...dispatched(),
    history: [draftEntry, { ...oldAttempt, outcome: "failed" }],
  });

  const result = await runMarketingRetention(prisma);
  assert.equal(result.MarketingPostHistory, 1);

  const after = await prisma.marketingPost.findUniqueOrThrow({ where: { id: due.id } });
  assert.equal(after.historyVersion, due.historyVersion + 1);
  const entries = after.history as Array<Record<string, unknown>>;
  const at = entries.at(-1)?.at;
  assert.equal(typeof at, "string");
  assert.deepEqual(entries, [
    draftEntry,
    youngWebhook,
    { at, type: "retention_summary", summarises: "attempt", count: 1, firstAt: oldAttempt.at, lastAt: oldAttempt.at },
    { at, type: "retention_summary", summarises: "webhook_event", count: 1, firstAt: oldWebhook.at, lastAt: oldWebhook.at },
    { at, type: "retention_compaction", removedEntryCount: 2 },
  ]);
  // Content is a different rule and a different clock.
  assert.notEqual(after.envelope, null);

  for (const kept of [held, failedOnly]) {
    const still = await prisma.marketingPost.findUniqueOrThrow({ where: { id: kept.id } });
    assert.deepEqual(still.history, kept.history, kept.id);
    assert.equal(still.historyVersion, kept.historyVersion, kept.id);
  }

  const audits = await auditsFor(MARKETING_RETENTION_ACTIONS.historyCompacted, [
    due.id,
    held.id,
    failedOnly.id,
  ]);
  assert.deepEqual(audits.map((audit) => audit.targetId), [due.id]);
  assert.equal((audits[0].metadata as { removedEntryCount?: number }).removedEntryCount, 2);

  // The summaries stay, the young entry is still young: nothing more to do.
  assert.equal((await runMarketingRetention(prisma)).MarketingPostHistory, 0);
});

test("outside retention the same content purge is refused by the database", async () => {
  const row = await channel();
  const due = await agedPost(row.id, 800, {
    status: "removed_by_platform",
    publishAttempt: 1,
    publishedAt: ago(770),
    ...dispatched(),
  });
  await assert.rejects(
    prisma.marketingPost.update({
      where: { id: due.id },
      data: { envelope: Prisma.DbNull, contentPurgedAt: new Date() },
    }),
    /only purged by retention/,
  );
});
