import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { POST } from "@/app/api/internal/marketing-generator-context/route";
import { createMarketingChannel, insertMarketingReport } from "@/lib/marketingStore";
import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";

const SECRET = "c".repeat(48);
const DIGEST = "b".repeat(64);

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

async function channelIn(status: string, channel = "linkedin") {
  const row = await createMarketingChannel(prisma, {
    channel,
    provider: "zernio",
    externalAccountRef: `zernio-${Math.random().toString(36).slice(2)}`,
    defaultLocale: "en",
    allowedLocales: ["en"],
    scopesDigest: DIGEST,
    policyVersion: 1,
  } as Parameters<typeof createMarketingChannel>[1]);
  return status === "connect_pending"
    ? row
    : prisma.marketingChannel.update({ where: { id: row.id }, data: { status } as never });
}

const call = (body: unknown, secret: string | null = SECRET) =>
  POST(
    new Request("http://localhost/api/internal/marketing-generator-context", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(secret ? { authorization: `Bearer ${secret}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

const withSecret = async (run: () => Promise<void>) => {
  const previous = process.env.MARKETING_GENERATOR_SUBMIT_SECRET;
  process.env.MARKETING_GENERATOR_SUBMIT_SECRET = SECRET;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.MARKETING_GENERATOR_SUBMIT_SECRET;
    else process.env.MARKETING_GENERATOR_SUBMIT_SECRET = previous;
  }
};

test("only the generator's secret and a run id are answered", () =>
  withSecret(async () => {
    assert.equal((await call({ generatorRunId: "run-1" }, null)).status, 401);
    assert.equal((await call({ generatorRunId: "run-1" }, "x".repeat(48))).status, 401);
    assert.equal((await call({ generatorRunId: "run-1", channelId: "x" })).status, 400);
    assert.equal((await call({})).status, 400);
    // The body is counted while it is read, not after.
    assert.equal((await call({ generatorRunId: "run-1", pad: "x".repeat(4096) })).status, 413);
  }));

test("the context names approval-mode accounts, claims without evidence, and facts without their pages", () =>
  withSecret(async () => {
    const approval = await channelIn("approval_mode");
    await channelIn("connect_pending", "x");
    const now = new Date();
    await insertMarketingReport(prisma, {
      kind: "brief",
      periodStart: now,
      periodEnd: now,
      payload: { topicIds: ["topic_compare"], claimIds: [], sourceDigests: [DIGEST] },
      sourceVersion: "test",
    } as never);
    await insertMarketingReport(prisma, {
      kind: "market_intel",
      periodStart: now,
      periodEnd: now,
      payload: {
        facts: [
          {
            competitorId: "poe",
            factType: "launch_date",
            value: { kind: "date", value: "2026-10-01" },
            sourceUrl: "https://poe.com/blog/launch",
            checkedAt: now.toISOString(),
          },
        ],
        unrepresentableFactCount: 2,
      },
      sourceVersion: "test",
    } as never);

    const response = await call({ generatorRunId: "run-1" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const text = await response.text();
    const { context } = JSON.parse(text) as {
      context: {
        channels: { id: string }[];
        claims: Record<string, unknown>[];
        brief: { payload: { topicIds: string[] } } | null;
        marketIntel: { payload: { facts: Record<string, unknown>[]; unrepresentableFactCount: number } } | null;
      };
    };
    assert.deepEqual(context.channels.map((row) => row.id), [approval.id]);
    for (const claim of context.claims) {
      assert.equal("evidence" in claim, false);
      assert.equal("factSource" in claim, false);
    }
    assert.deepEqual(context.brief?.payload.topicIds, ["topic_compare"]);
    assert.equal(context.marketIntel?.payload.unrepresentableFactCount, 2);
    assert.deepEqual(Object.keys(context.marketIntel?.payload.facts[0] ?? {}).sort(), [
      "checkedAt",
      "competitorId",
      "factType",
      "value",
    ]);
    assert.equal(/https?:\/\//.test(text), false, "no URL reaches the generator");
  }));
