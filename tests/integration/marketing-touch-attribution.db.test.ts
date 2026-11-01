import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  findLatestMarketingTouch,
  recordProductAnalyticsEvent,
  repairLateMarketingTouchSnapshots,
} from "@/lib/productAnalyticsServer";
import { MARKETING_TOUCH_WINDOW_MS } from "@/lib/marketingTouchCore";

// docs/policy/marketing-automation.md §10.1 against PostgreSQL: the event-name
// CHECK admits `marketing_touch` and still refuses a name the application does
// not know, and the attribution query picks the last touch of the same browser
// (or account) inside the seven days before receipt -- both ends inclusive.

const reset = () =>
  prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "ProductAnalyticsEvent", "User" RESTART IDENTITY CASCADE`
  );

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const receivedAt = new Date("2026-11-01T00:00:00.000Z");

const recordTouch = (input: {
  clientId: string;
  occurredAt: Date;
  campaign: string;
  userId?: string | null;
}) =>
  recordProductAnalyticsEvent({
    eventName: "marketing_touch",
    source: "client",
    userId: input.userId ?? null,
    attribution: {
      client_id: input.clientId,
      session_id: "1761955200000",
      utm_source: "linkedin",
      utm_medium: "social",
      utm_campaign: input.campaign,
      language: "en",
      country: "AU",
    },
    modelCount: 0,
    plan: "Guest",
    properties: {
      utm_content: "linkedin-1",
      touch_evidence: "client_observed_server_time",
    },
    occurredAt: input.occurredAt,
    dedupeKey: `client:${randomUUID()}`,
  });

test("the event-name check admits marketing_touch and refuses an unknown name", async () => {
  const clientId = randomUUID();
  assert.equal(
    await recordTouch({ clientId, occurredAt: receivedAt, campaign: "launch" }),
    true
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(
      `INSERT INTO "ProductAnalyticsEvent"
         ("id", "dedupeKey", "eventName", "source", "anonymousIdHash", "sessionIdHash",
          "utmSource", "utmMedium", "utmCampaign", "language", "country", "modelCount", "plan")
       VALUES ('forged', 'forged', 'marketing_touch_forged', 'client', 'a', 'b',
          'x', 'y', 'z', 'en', 'AU', 0, 'Guest')`
    ),
    /ProductAnalyticsEvent_name_check/
  );
});

test("the last touch inside the window wins; the boundaries and other browsers do not", async () => {
  const clientId = randomUUID();
  const otherClient = randomUUID();
  const exactlySevenDays = new Date(receivedAt.getTime() - MARKETING_TOUCH_WINDOW_MS);
  await recordTouch({ clientId, occurredAt: exactlySevenDays, campaign: "edge" });
  await recordTouch({
    clientId,
    occurredAt: new Date(exactlySevenDays.getTime() - 1),
    campaign: "stale",
  });
  await recordTouch({
    clientId,
    occurredAt: new Date(receivedAt.getTime() + 1),
    campaign: "future",
  });
  await recordTouch({
    clientId: otherClient,
    occurredAt: new Date(receivedAt.getTime() - 60_000),
    campaign: "someone-else",
  });

  const edge = await findLatestMarketingTouch({ clientId, userId: null, receivedAt });
  assert.equal(edge?.utmCampaign, "edge", "exactly seven days before receipt is inside");
  assert.equal(edge?.utmContent, "linkedin-1");
  assert.equal(edge?.occurredAt.getTime(), exactlySevenDays.getTime());

  await recordTouch({
    clientId,
    occurredAt: new Date(receivedAt.getTime() - 2 * 24 * 60 * 60 * 1000),
    campaign: "recent",
  });
  const recent = await findLatestMarketingTouch({ clientId, userId: null, receivedAt });
  assert.equal(recent?.utmCampaign, "recent");

  assert.equal(
    await findLatestMarketingTouch({ clientId: randomUUID(), userId: null, receivedAt }),
    null,
    "a browser with no touch is unattributed"
  );
});

test("a signed-in conversion also finds the account's own touch from another browser", async () => {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test` } });
  await recordTouch({
    clientId: randomUUID(),
    userId: user.id,
    occurredAt: new Date(receivedAt.getTime() - 60_000),
    campaign: "account-touch",
  });
  const found = await findLatestMarketingTouch({
    clientId: randomUUID(),
    userId: user.id,
    receivedAt,
  });
  assert.equal(found?.utmCampaign, "account-touch");
  assert.equal(
    await findLatestMarketingTouch({ clientId: randomUUID(), userId: null, receivedAt }),
    null
  );
});

const recordSignup = (input: { clientId: string; userId: string; occurredAt: Date }) =>
  recordProductAnalyticsEvent({
    eventName: "signup_completed",
    source: "client",
    userId: input.userId,
    attribution: {
      client_id: input.clientId,
      session_id: "1761955200000",
      utm_source: "(direct)",
      utm_medium: "(none)",
      utm_campaign: "(not set)",
      language: "en",
      country: "AU",
    },
    modelCount: 0,
    plan: "Free",
    properties: { method: "google", touch_attribution: "unattributed" },
    occurredAt: input.occurredAt,
    dedupeKey: `singleton:signup_completed:${input.userId}`,
  });

test("a touch stored after its sign-up repairs that sign-up only", async () => {
  const mine = await prisma.user.create({ data: { email: `${randomUUID()}@example.test` } });
  const theirs = await prisma.user.create({ data: { email: `${randomUUID()}@example.test` } });
  const clientId = randomUUID();
  const signedUpAt = new Date();
  await recordSignup({ clientId, userId: mine.id, occurredAt: signedUpAt });
  await recordSignup({ clientId: randomUUID(), userId: theirs.id, occurredAt: signedUpAt });

  const touchReceivedAt = new Date();
  const repaired = await repairLateMarketingTouchSnapshots({
    clientId,
    userId: null,
    touch: {
      utmSource: "linkedin",
      utmMedium: "social",
      utmCampaign: "launch",
      utmContent: "linkedin-1",
      occurredAt: touchReceivedAt,
    },
    touchObservedAt: new Date(signedUpAt.getTime() - 60_000),
  });
  assert.equal(repaired, 1);

  const rows = await prisma.productAnalyticsEvent.findMany({
    where: { eventName: "signup_completed" },
    select: { userId: true, properties: true },
  });
  const byUser = new Map(rows.map((row) => [row.userId, row.properties as Record<string, unknown>]));
  assert.equal(byUser.get(mine.id)?.touch_attribution, "attributed");
  assert.equal(byUser.get(mine.id)?.touch_utm_content, "linkedin-1");
  assert.equal(byUser.get(mine.id)?.touch_received_at, touchReceivedAt.toISOString());
  assert.equal(byUser.get(mine.id)?.method, "google");
  assert.equal(byUser.get(theirs.id)?.touch_attribution, "unattributed", "another browser is untouched");
});
