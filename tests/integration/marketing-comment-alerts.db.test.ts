import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import {
  MarketingStoreRefusedError,
  insertMarketingReport,
  listOpenMarketingCommentAlerts,
  requireOpenMarketingCommentAlert,
} from "@/lib/marketingStore";
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
