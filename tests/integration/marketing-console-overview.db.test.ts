import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { readMarketingConsoleOverview } from "@/lib/marketingConsoleOverview";
import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";

const reset = () =>
  resetTestFixture(
    prisma,
    `TRUNCATE TABLE "MarketingLlmCall", "MarketingPost", "MarketingReport", "MarketingChannel", "MarketingCompetitor", "AdminAuditLog" RESTART IDENTITY CASCADE`,
  );
beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("an empty marketing record reads as zeros and 'never ran', not as unreadable", async () => {
  const { readAt, environment, ...overview } = await readMarketingConsoleOverview();
  assert.ok(Date.parse(readAt) > 0);
  assert.equal(typeof environment, "string");
  assert.deepEqual(overview, {
    pending: { count: 0, oldestAt: null },
    llm: { calls: 0, countedMicroUsd: 0, tokenMicroUsd: 0 },
    lastRun: { at: null, calls: 0, reportAt: null, factsKept: null, factsDropped: null },
    accounts: { total: 0, byStatus: {} },
    competitors: { approved: 0 },
  });
});
