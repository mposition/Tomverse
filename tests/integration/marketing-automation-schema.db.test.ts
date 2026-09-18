import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { Prisma } from "@prisma/client";

import {
  MARKETING_CHANNEL_CAPS,
  marketingReportRetentionUntil,
} from "@/lib/marketingAutomationSchema";
import {
  createMarketingChannel,
  createMarketingPost,
  insertAiVisibilityRun,
  insertMarketingReport,
} from "@/lib/marketingStore";
import { prisma } from "@/lib/prisma";

// The marketing tables' invariants against a real database.
//
// Contract: docs/policy/marketing-automation.md, migration
// 20260918120000_marketing_automation_tables. The unit suite
// (tests/marketingAutomationSchema.test.mjs) pins the lists and the schemas,
// which is the half that can be read from source. This is the other half: the
// triggers and CHECK constraints refuse writes that never go near the store
// module, because an insert that reached the table another way is exactly the
// case they exist for. Every write below is a direct Prisma call for that
// reason.
//
// The retention setting is a transaction-local GUC, so each test that needs it
// opens its own transaction and sets it there; a test that forgets sees the
// refusal, which is the default.

const reset = () =>
  prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "MarketingPost", "MarketingChannel", "MarketingReport", "AiVisibilityRun" RESTART IDENTITY CASCADE`,
  );

const DIGEST = "b".repeat(64);
const OTHER_DIGEST = "c".repeat(64);

const envelope = (overrides: Record<string, unknown> = {}) => ({
  channel: "linkedin",
  accountSlug: "linkedin-1",
  locale: "en",
  renderedText: "Three models, three answers, side by side.",
  claimIds: [],
  assets: [],
  finalUrl: null,
  scheduledAt: null,
  disclosureFlags: ["advertising"],
  ...overrides,
});

const factSnapshot = {
  priceRows: [],
  catalogue: null,
  modelRegistryRows: [],
  evidenceDigests: [],
};

const historyEntry = (type: string, extra: Record<string, unknown> = {}) => ({
  at: new Date().toISOString(),
  type,
  ...extra,
});

async function channel(overrides: Record<string, unknown> = {}) {
  return createMarketingChannel(prisma, {
    channel: "linkedin",
    provider: "zernio",
    externalAccountRef: "zernio-account-1",
    defaultLocale: "en",
    allowedLocales: ["en"],
    scopesDigest: DIGEST,
    policyVersion: 1,
    ...overrides,
  } as Parameters<typeof createMarketingChannel>[1]);
}

/** A post row written straight to the table, so a test can choose every column. */
async function post(channelId: string, overrides: Record<string, unknown> = {}) {
  return prisma.marketingPost.create({
    data: {
      channelId,
      locale: "en",
      kind: "social",
      logicalKey: `post-${Math.random().toString(36).slice(2)}`,
      envelope: envelope(),
      envelopeDigest: DIGEST,
      rendererVersion: "r1",
      claimRegistryVersion: 1,
      assetRegistryVersion: 1,
      factSnapshot,
      guardDecision: "approval_required",
      status: "drafted",
      mode: "approval",
      history: [historyEntry("draft", { envelopeDigest: DIGEST })],
      historyVersion: 0,
      ...overrides,
    },
  });
}

const refused = async (operation: Promise<unknown>, expected: RegExp) => {
  await assert.rejects(operation, (error: Error) => {
    assert.match(error.message, expected);
    return true;
  });
};

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

// ---------------------------------------------------------------------------
// O15: the two channels whose posts the API cannot retract
// ---------------------------------------------------------------------------

test("an Instagram account cannot hold an autonomous status", async () => {
  const row = await channel({ channel: "instagram", allowedLocales: ["en"] });
  await prisma.marketingChannel.update({
    where: { id: row.id },
    data: { status: "approval_mode", approvalStartedAt: new Date() },
  });

  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: {
        status: "autonomous_mode",
        graduatedAt: new Date(),
        graduationSnapshot: { graduationEpoch: 0 },
      },
    }),
    /no_autonomy_channels|autonomous/i,
  );
});

test("a post cannot be autonomous on a channel the API cannot retract", async () => {
  const instagram = await channel({ channel: "instagram" });
  await refused(
    post(instagram.id, {
      mode: "autonomous",
      guardDecision: "autonomous_eligible",
      templateId: "template.a",
      templateDigest: DIGEST,
    }),
    /cannot be autonomous on instagram/,
  );
});

test("a post cannot be moved to autonomous mode on such a channel either", async () => {
  const tiktok = await channel({ channel: "tiktok" });
  const row = await post(tiktok.id);
  await refused(
    prisma.marketingPost.update({
      where: { id: row.id },
      data: {
        mode: "autonomous",
        guardDecision: "autonomous_eligible",
        templateId: "template.a",
        templateDigest: DIGEST,
      },
    }),
    /cannot be autonomous on tiktok/,
  );
});

test("autonomous mode is allowed on a channel that can retract", async () => {
  const linkedin = await channel();
  const row = await post(linkedin.id, {
    mode: "autonomous",
    guardDecision: "autonomous_eligible",
    templateId: "template.a",
    templateDigest: DIGEST,
  });
  assert.equal(row.mode, "autonomous");
});

// ---------------------------------------------------------------------------
// Channel identity, transitions and caps
// ---------------------------------------------------------------------------

test("a channel's platform, carrier and slug are immutable", async () => {
  const row = await channel();
  await refused(
    prisma.marketingChannel.update({ where: { id: row.id }, data: { channel: "x" } }),
    /identity is immutable/,
  );
  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: { provider: "manual", externalAccountRef: null },
    }),
    /identity is immutable/,
  );
  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: { accountSlug: "linkedin-9" },
    }),
    /slug is immutable/,
  );
});

test("a manual channel has no external account and an API channel must have one", async () => {
  const manual = await channel({
    channel: "rednote",
    provider: "manual",
    externalAccountRef: null,
    defaultLocale: "zh-Hans",
    allowedLocales: ["zh-Hans"],
  });
  assert.equal(manual.externalAccountRef, null);

  await refused(
    channel({ channel: "x", provider: "manual", externalAccountRef: "should-not-exist" }),
    /external_ref_matches_provider/,
  );
});

test("a reconnect returns the account to approval mode with a new epoch", async () => {
  const row = await channel();
  await prisma.marketingChannel.update({
    where: { id: row.id },
    data: { status: "approval_mode", approvalStartedAt: new Date(2026, 0, 1) },
  });

  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: { scopesDigest: OTHER_DIGEST },
    }),
    /must return to approval mode with a new epoch/,
  );

  const updated = await prisma.marketingChannel.update({
    where: { id: row.id },
    data: {
      scopesDigest: OTHER_DIGEST,
      status: "approval_mode",
      graduatedAt: null,
      graduationSnapshot: undefined,
      graduationEpoch: 1,
      approvalStartedAt: new Date(),
    },
  });
  assert.equal(updated.graduationEpoch, 1);
});

test("a connecting account cannot jump straight to autonomous mode", async () => {
  const row = await channel();
  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: {
        status: "autonomous_mode",
        approvalStartedAt: new Date(),
        graduatedAt: new Date(),
        graduationSnapshot: { graduationEpoch: 0 },
      },
    }),
    /cannot move from connect_pending to autonomous_mode/,
  );
});

test("a resume into autonomous mode needs the account to have been autonomous", async () => {
  const row = await channel();
  await prisma.marketingChannel.update({
    where: { id: row.id },
    data: { status: "approval_mode", approvalStartedAt: new Date() },
  });
  await prisma.marketingChannel.update({
    where: { id: row.id },
    data: { status: "paused", pausedAt: new Date(), pausedFromMode: "approval_mode" },
  });

  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: {
        status: "autonomous_mode",
        graduatedAt: new Date(),
        graduationSnapshot: { graduationEpoch: 0 },
      },
    }),
    /was not autonomous before it was paused/,
  );

  const resumed = await prisma.marketingChannel.update({
    where: { id: row.id },
    data: { status: "approval_mode" },
  });
  assert.equal(resumed.status, "approval_mode");
});

test("a cap override may only lower the policy cap", async () => {
  const row = await channel();
  const caps = MARKETING_CHANNEL_CAPS.linkedin;
  assert.ok(caps);

  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: { dailyCapOverride: caps.daily + 1 },
    }),
    /above the policy cap/,
  );

  const lowered = await prisma.marketingChannel.update({
    where: { id: row.id },
    data: { dailyCapOverride: 0 },
  });
  assert.equal(lowered.dailyCapOverride, 0);
});

test("a manual channel has no cap to override", async () => {
  const row = await channel({
    channel: "rednote",
    provider: "manual",
    externalAccountRef: null,
    defaultLocale: "zh-Hans",
    allowedLocales: ["zh-Hans"],
  });
  await refused(
    prisma.marketingChannel.update({
      where: { id: row.id },
      data: { weeklyCapOverride: 1 },
    }),
    /no posting cap to override/,
  );
});

test("a channel is never deleted", async () => {
  const row = await channel();
  await refused(
    prisma.marketingChannel.delete({ where: { id: row.id } }),
    /not deletable; disconnect it instead/,
  );
});

// ---------------------------------------------------------------------------
// Post history and purge
// ---------------------------------------------------------------------------

test("a post starts at version zero with exactly one draft entry", async () => {
  const row = await channel();
  await refused(
    post(row.id, { historyVersion: 3 }),
    /must start at history version zero/,
  );
  await refused(post(row.id, { history: [] }), /one draft history entry/);
  await refused(
    post(row.id, { history: [historyEntry("guard_result")] }),
    /one draft history entry/,
  );
});

test("the store's create writes the draft entry itself", async () => {
  const row = await channel();
  const created = await createMarketingPost(prisma, {
    channelId: row.id,
    locale: "en",
    kind: "social",
    logicalKey: "store-created-1",
    envelope: envelope() as never,
    envelopeDigest: DIGEST,
    rendererVersion: "r1",
    templateId: null,
    templateDigest: null,
    claimIds: [],
    assetIds: [],
    claimRegistryVersion: 1,
    assetRegistryVersion: 1,
    factSnapshot: factSnapshot as never,
    guardDecision: "approval_required",
    guardCodes: [],
    guardRuleIds: [],
    status: "drafted",
    mode: "approval",
    draftedAt: new Date(),
  });
  assert.equal(created.historyVersion, 0);
  assert.equal((created.history as { type: string }[]).length, 1);
});

test("history is append-only and its version moves by exactly one", async () => {
  const row = await channel();
  const created = await post(row.id);
  const original = created.history as unknown[];

  await refused(
    prisma.marketingPost.update({
      where: { id: created.id },
      data: {
        history: [...original, historyEntry("guard_result")],
        historyVersion: 5,
      },
    }),
    /history version moves by one/,
  );

  await refused(
    prisma.marketingPost.update({
      where: { id: created.id },
      data: { history: [historyEntry("guard_result")], historyVersion: 1 },
    }),
    /history is append-only/,
  );

  await refused(
    prisma.marketingPost.update({
      where: { id: created.id },
      data: { history: [], historyVersion: 1 },
    }),
    /history cannot lose entries/,
  );

  const appended = await prisma.marketingPost.update({
    where: { id: created.id },
    data: {
      history: [...original, historyEntry("guard_result")],
      historyVersion: 1,
    },
  });
  assert.equal(appended.historyVersion, 1);
});

test("content is only purged by retention, and never under legal hold", async () => {
  const row = await channel();
  const created = await post(row.id);

  await refused(
    prisma.marketingPost.update({
      where: { id: created.id },
      data: { envelope: Prisma.DbNull, contentPurgedAt: new Date() },
    }),
    /content is only purged by retention/,
  );

  const held = await post(row.id, { legalHold: true });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL tomverse.marketing_retention_compaction = 'on'`,
    );
    await refused(
      tx.marketingPost.update({
        where: { id: held.id },
        data: { envelope: Prisma.DbNull, contentPurgedAt: new Date() },
      }),
      /under legal hold/,
    );
  });

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL tomverse.marketing_retention_compaction = 'on'`,
    );
    await tx.marketingPost.update({
      where: { id: created.id },
      data: { envelope: Prisma.DbNull, contentPurgedAt: new Date() },
    });
  });

  const purged = await prisma.marketingPost.findUniqueOrThrow({
    where: { id: created.id },
  });
  assert.equal(purged.envelope, null);
  assert.equal(purged.envelopeDigest, DIGEST, "the digest survives the purge");
});

test("a compaction has to say that it happened", async () => {
  const row = await channel();
  const created = await post(row.id);

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL tomverse.marketing_retention_compaction = 'on'`,
    );
    await refused(
      tx.marketingPost.update({
        where: { id: created.id },
        data: { history: [], historyVersion: 1 },
      }),
      /must end with a retention_compaction entry/,
    );
    await tx.marketingPost.update({
      where: { id: created.id },
      data: {
        history: [historyEntry("retention_compaction", { removedEntryCount: 1 })],
        historyVersion: 1,
      },
    });
  });

  const compacted = await prisma.marketingPost.findUniqueOrThrow({
    where: { id: created.id },
  });
  assert.equal((compacted.history as { type: string }[]).at(-1)?.type, "retention_compaction");
});

// ---------------------------------------------------------------------------
// Deletes
// ---------------------------------------------------------------------------

test("a post is deleted only as an old refused draft, under retention", async () => {
  const row = await channel();
  const fresh = await post(row.id, { status: "rejected" });
  await refused(
    prisma.marketingPost.delete({ where: { id: fresh.id } }),
    /only deleted by retention/,
  );

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL tomverse.marketing_retention_compaction = 'on'`,
    );
    await refused(
      tx.marketingPost.delete({ where: { id: fresh.id } }),
      /not yet ninety days old/,
    );
  });

  const old = await post(row.id, {
    status: "published",
    createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
  });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL tomverse.marketing_retention_compaction = 'on'`,
    );
    await refused(
      tx.marketingPost.delete({ where: { id: old.id } }),
      /is not a deletable draft/,
    );
  });

  const deletable = await post(row.id, {
    status: "approval_expired",
    createdAt: new Date(Date.now() - 200 * 24 * 60 * 60 * 1000),
  });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL tomverse.marketing_retention_compaction = 'on'`,
    );
    await tx.marketingPost.delete({ where: { id: deletable.id } });
  });
  assert.equal(
    await prisma.marketingPost.count({ where: { id: deletable.id } }),
    0,
  );
});

// ---------------------------------------------------------------------------
// Reports and visibility runs
// ---------------------------------------------------------------------------

test("a report's retention date is the one its kind gives it", async () => {
  const createdAt = new Date("2026-01-31T00:00:00.000Z");
  const report = await insertMarketingReport(prisma, {
    kind: "weekly_kpi",
    periodStart: new Date("2026-01-01T00:00:00.000Z"),
    periodEnd: new Date("2026-01-07T00:00:00.000Z"),
    payload: {
      postsPublished: 3,
      postsRejected: 1,
      guardRejectionsByCode: [],
      channelTotals: [],
    },
    sourceVersion: "v1",
    createdAt,
  });

  assert.equal(
    report.retentionUntil.toISOString(),
    marketingReportRetentionUntil("weekly_kpi", createdAt).toISOString(),
    "the end of a shorter month is where Postgres and JavaScript disagree",
  );

  await refused(
    prisma.marketingReport.create({
      data: {
        kind: "weekly_kpi",
        periodStart: createdAt,
        periodEnd: createdAt,
        payload: {},
        sourceVersion: "v1",
        createdAt,
        retentionUntil: new Date("2027-01-31T00:00:00.000Z"),
      },
    }),
    /retentionUntil/,
  );
});

test("a report is deleted only after its retention date, under retention", async () => {
  const createdAt = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
  const report = await insertMarketingReport(prisma, {
    kind: "comment_alerts",
    periodStart: createdAt,
    periodEnd: createdAt,
    payload: {
      postId: "post.1",
      alertCount: 1,
      riskCodes: [],
      firstDetectedAt: createdAt.toISOString(),
      externalUrlHost: "www.linkedin.com",
    },
    sourceVersion: "v1",
    createdAt,
  });

  await refused(
    prisma.marketingReport.delete({ where: { id: report.id } }),
    /only deleted by retention/,
  );

  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `SET LOCAL tomverse.marketing_retention_compaction = 'on'`,
    );
    await tx.marketingReport.delete({ where: { id: report.id } });
  });
  assert.equal(await prisma.marketingReport.count({ where: { id: report.id } }), 0);
});

test("a visibility run keeps cited urls https and an answer digest only", async () => {
  const runAt = new Date("2026-09-18T00:00:00.000Z");
  const run = await insertAiVisibilityRun(prisma, {
    promptSetVersion: "p1",
    promptId: "prompt.compare",
    locale: "en",
    model: "gpt-5-6-luna",
    modelVersion: "2026-09-01",
    searchMode: "with_search",
    region: "AU",
    runAt,
    mentioned: true,
    citedUrls: ["https://tomverse.app/"],
    answerDigest: DIGEST,
    accuracyFlags: { flags: ["wrong_price"] },
  });
  assert.equal(run.retentionUntil.toISOString(), "2028-09-18T00:00:00.000Z");

  await refused(
    prisma.aiVisibilityRun.create({
      data: {
        promptSetVersion: "p1",
        promptId: "prompt.compare",
        locale: "en",
        model: "gpt-5-6-luna",
        modelVersion: "2026-09-01",
        searchMode: "with_search",
        region: "AU",
        runAt,
        mentioned: true,
        citedUrls: ["http://tomverse.app/"],
        answerDigest: DIGEST,
        retentionUntil: new Date("2028-09-18T00:00:00.000Z"),
      },
    }),
    /citedUrls/,
  );

  await refused(
    prisma.aiVisibilityRun.create({
      data: {
        promptSetVersion: "p1",
        promptId: "prompt.compare",
        locale: "en",
        model: "gpt-5-6-luna",
        modelVersion: "2026-09-01",
        searchMode: "with_search",
        region: "AU",
        runAt,
        mentioned: true,
        citedUrls: [],
        answerDigest: "not-a-digest",
        retentionUntil: new Date("2028-09-18T00:00:00.000Z"),
      },
    }),
    /answerDigest/,
  );
});
