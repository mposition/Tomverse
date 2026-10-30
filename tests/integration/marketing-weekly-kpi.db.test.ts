import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import { createMarketingChannel } from "@/lib/marketingStore";
import { runMarketingWeeklyKpi } from "@/lib/marketingWeeklyKpi";
import { marketingKpiWeek } from "@/lib/marketingWeeklyKpiCore";
import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";

const DIGEST = "c".repeat(64);
const DAY = 24 * 60 * 60 * 1000;

const reset = () =>
  resetTestFixture(
    prisma,
    `TRUNCATE TABLE "MarketingPost", "MarketingChannel", "MarketingReport" RESTART IDENTITY CASCADE`,
  );

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

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

/** A post the Guard refused, created at the given time, with the one-draft trigger off for the insert. */
async function guardRejected(channelId: string, createdAt: Date, guardCodes: string[]) {
  await prisma.$executeRawUnsafe(`ALTER TABLE "MarketingPost" DISABLE TRIGGER "marketing_post_starts_as_one_draft"`);
  try {
    await prisma.marketingPost.create({
      data: {
        channelId,
        locale: "en",
        kind: "social",
        logicalKey: `post-${Math.random().toString(36).slice(2)}`,
        envelope: { channel: "linkedin", locale: "en", renderedText: "Side by side.", claimIds: [], assets: [] },
        envelopeDigest: DIGEST,
        rendererVersion: "r1",
        claimIds: [],
        assetIds: [],
        claimRegistryVersion: 1,
        assetRegistryVersion: 1,
        factSnapshot: { priceRows: [], catalogue: null, modelRegistryRows: [], evidenceDigests: [] },
        factsDigest: DIGEST,
        guardDecision: "reject",
        guardCodes,
        guardRuleIds: [],
        status: "guard_rejected",
        mode: "approval",
        history: [{ at: createdAt.toISOString(), type: "draft", envelopeDigest: DIGEST }],
        historyVersion: 0,
        createdAt,
      },
    });
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "MarketingPost" ENABLE TRIGGER "marketing_post_starts_as_one_draft"`);
  }
}

test("no account, no report: there is no week of marketing to count", async () => {
  const result = await runMarketingWeeklyKpi(prisma);
  assert.equal(result.recorded, false);
  assert.equal(result.recorded === false && result.reason, "no_accounts");
  assert.equal(await prisma.marketingReport.count(), 0);
});

test("the week that has ended is reported once, with the counts the core makes of it", async () => {
  const account = await channel();
  const week = marketingKpiWeek(new Date());
  await guardRejected(account.id, new Date(week.start.getTime() + DAY), ["claim_unknown"]);
  // Before the week: not counted.
  await guardRejected(account.id, new Date(week.start.getTime() - DAY), ["claim_unknown"]);

  const first = await runMarketingWeeklyKpi(prisma);
  assert.equal(first.recorded, true);
  assert.equal(first.weekStart, week.start.toISOString());

  const rows = await prisma.marketingReport.findMany({ where: { kind: "weekly_kpi" } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].periodStart.toISOString(), week.start.toISOString());
  assert.equal(rows[0].periodEnd.toISOString(), week.end.toISOString());
  assert.equal(rows[0].sourceVersion, "marketing-weekly-kpi-v1");
  assert.deepEqual(rows[0].payload, {
    postsPublished: 0,
    postsRejected: 0,
    guardRejectionsByCode: [{ code: "claim_unknown", count: 1 }],
    channelTotals: [{ accountSlug: account.accountSlug, published: 0, failed: 0 }],
  });

  // The next day's maintenance finds the week reported and adds nothing.
  const again = await runMarketingWeeklyKpi(prisma);
  assert.equal(again.recorded === false && again.reason, "already_recorded");
  assert.equal(await prisma.marketingReport.count({ where: { kind: "weekly_kpi" } }), 1);
});

test("with the marketing kill switch on nothing is recorded (policy §6.1)", async () => {
  await channel();
  for (const value of ["1", "on", " x "]) {
    const result = await runMarketingWeeklyKpi(prisma, { [MARKETING_AUTOMATION_KILL_SWITCH_ENV]: value });
    assert.deepEqual(result, { recorded: false, reason: "kill_switch" });
  }
  assert.equal(await prisma.marketingReport.count(), 0);
  // An empty value is off, as at every other marketing gate.
  const off = await runMarketingWeeklyKpi(prisma, { [MARKETING_AUTOMATION_KILL_SWITCH_ENV]: "  " });
  assert.equal(off.recorded, true);
});

test("two runs at once record the week once", async () => {
  await channel();
  const results = await Promise.all([runMarketingWeeklyKpi(prisma), runMarketingWeeklyKpi(prisma)]);
  assert.deepEqual(results.map((result) => result.recorded).sort(), [false, true]);
  assert.equal(await prisma.marketingReport.count({ where: { kind: "weekly_kpi" } }), 1);
});
