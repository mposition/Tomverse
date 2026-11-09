import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { createMarketingChannel } from "@/lib/marketingStore";
import { readMarketingFunnelCounts } from "@/lib/marketingWeeklyReportRead";
import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";

// The weekly report's funnel counts (owner request 2026-11-09), read against
// the real tables: posts by publishedAt, touches by the account slug in
// utm_content, attributed sign-ups with how many of those accounts have used
// the product and paid.

const DIGEST = "c".repeat(64);
const DAY = 24 * 60 * 60 * 1000;
const window = { start: new Date("2026-11-01T14:00:00.000Z"), end: new Date("2026-11-08T14:00:00.000Z") };
const inWeek = new Date(window.start.getTime() + 2 * DAY);
const beforeWeek = new Date(window.start.getTime() - DAY);

const reset = () =>
  resetTestFixture(
    prisma,
    `TRUNCATE TABLE "MarketingPost", "MarketingChannel", "ProductAnalyticsEvent", "BillingTransaction", "Conversation", "User" RESTART IDENTITY CASCADE`,
  );

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const channel = () =>
  createMarketingChannel(prisma, {
    channel: "linkedin",
    provider: "zernio",
    externalAccountRef: `zernio-${Math.random().toString(36).slice(2)}`,
    defaultLocale: "en",
    allowedLocales: ["en"],
    scopesDigest: DIGEST,
    policyVersion: 1,
  } as Parameters<typeof createMarketingChannel>[1]);

/**
 * A post with `publishedAt` set, which is all the funnel counts. Written as a
 * Guard-refused row so the published-state checks do not apply to the fixture.
 */
async function publishedAt(channelId: string, at: Date) {
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
        guardCodes: [],
        guardRuleIds: [],
        status: "guard_rejected",
        mode: "approval",
        history: [{ at: at.toISOString(), type: "draft", envelopeDigest: DIGEST }],
        historyVersion: 0,
        createdAt: at,
        publishedAt: at,
      },
    });
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "MarketingPost" ENABLE TRIGGER "marketing_post_starts_as_one_draft"`);
  }
}

let sequence = 0;
async function event(input: {
  eventName: "marketing_touch" | "signup_completed";
  at: Date;
  userId?: string | null;
  properties: Record<string, unknown>;
}) {
  sequence += 1;
  await prisma.productAnalyticsEvent.create({
    data: {
      dedupeKey: `funnel-${sequence}`,
      eventName: input.eventName,
      source: "client",
      userId: input.userId ?? null,
      anonymousIdHash: `anon-${sequence}`,
      sessionIdHash: `session-${sequence}`,
      utmSource: "linkedin",
      utmMedium: "social",
      utmCampaign: "launch",
      language: "en",
      country: "AU",
      modelCount: 0,
      plan: "Free",
      properties: input.properties as object,
      occurredAt: input.at,
    },
  });
}

async function user(label: string) {
  return prisma.user.create({ data: { email: `${label}-${Math.random().toString(36).slice(2)}@example.test` } });
}

test("posts, touches and attributed sign-ups are counted per account, with use and payment", async () => {
  const account = await channel();
  await publishedAt(account.id, inWeek);
  await publishedAt(account.id, inWeek);
  await publishedAt(account.id, beforeWeek);

  await event({ eventName: "marketing_touch", at: inWeek, properties: { utm_content: account.accountSlug } });
  await event({ eventName: "marketing_touch", at: inWeek, properties: { utm_content: account.accountSlug } });
  await event({ eventName: "marketing_touch", at: inWeek, properties: {} });
  await event({ eventName: "marketing_touch", at: beforeWeek, properties: { utm_content: account.accountSlug } });

  const used = await user("used");
  const paid = await user("paid");
  const idle = await user("idle");
  const attributed = (userId: string) => ({
    eventName: "signup_completed" as const,
    at: inWeek,
    userId,
    properties: { touch_attribution: "attributed", touch_utm_content: account.accountSlug },
  });
  await event(attributed(used.id));
  await event(attributed(paid.id));
  await event(attributed(idle.id));
  await event({ eventName: "signup_completed", at: inWeek, userId: (await user("direct")).id, properties: { touch_attribution: "unattributed" } });

  await prisma.conversation.create({ data: { userId: used.id, title: "t", selectedModels: "[]" } });
  await prisma.conversation.create({ data: { userId: paid.id, title: "t", selectedModels: "[]" } });
  await prisma.conversation.create({ data: { userId: paid.id, title: "t2", selectedModels: "[]" } });
  await prisma.billingTransaction.create({
    data: {
      userId: paid.id,
      productType: "subscription",
      productId: "pro",
      stripeCheckoutSessionId: `cs_${Math.random().toString(36).slice(2)}`,
      amountPaidMinor: 1000,
      currency: "AUD",
      amountPaidUsdMicroUsd: BigInt(6_500_000),
      usdConversionSource: "fixture",
      paidAt: inWeek,
    },
  });

  const counts = await readMarketingFunnelCounts(prisma, window);
  assert.deepEqual(counts.published, [{ accountSlug: account.accountSlug, count: 2 }]);
  const touches = [...(counts.touches ?? [])].sort((left, right) => (left.account ?? "").localeCompare(right.account ?? ""));
  assert.deepEqual(touches, [
    { account: null, count: 1 },
    { account: account.accountSlug, count: 2 },
  ]);
  assert.deepEqual(counts.signups, [{ account: account.accountSlug, signups: 3, firstUse: 2, paid: 1 }]);
});

test("an empty week reads as counted zeros, not as unread", async () => {
  const counts = await readMarketingFunnelCounts(prisma, window);
  assert.deepEqual(counts, { published: [], touches: [], signups: [] });
});
