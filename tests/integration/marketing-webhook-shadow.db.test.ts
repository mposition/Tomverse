import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { MARKETING_WEBHOOK_SHADOW_KEY } from "@/lib/marketingAutomationAccess";
import { MARKETING_WEBHOOK_FAULT_ARM_KEY } from "@/lib/marketingWebhookCore";
import {
  marketingWebhookShadowExists,
  recordMarketingWebhookShadow,
  runMarketingTransaction,
} from "@/lib/marketingStore";
import {
  consumeMarketingWebhookFaultArm,
  setMarketingWebhookFaultArm,
  writeMarketingWebhookShadowSwitch,
} from "@/lib/marketingWebhookSettings";
import { MarketingWebhookSettingRefusedError } from "@/lib/marketingWebhookCore";
import { takeAuditChainLock } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import { resetTestFixture } from "./resetTestFixture";

// The staging shadow receiver's two races, against PostgreSQL (S2 plan, S2e).
//
// Both are properties a fake cannot have: that the partial unique index on the
// shadow report's event digest refuses a second report of one event inside the
// transaction that would also have written its audit entry, and that two
// deliveries racing for one armed fault produce exactly one committed winner.

const AUDIT_SECRET = "marketing-webhook-shadow-db-secret-0042";
const DIGEST = "d".repeat(64);
const OTHER_DIGEST = "e".repeat(64);

const shadow = (eventIdDigest: string) => ({
  eventIdDigest,
  eventType: "post.published",
  channelId: "chn-webhook-1",
  derivedStatus: "published",
  statusQueryMatch: true,
});

const saved: Record<string, string | undefined> = {};

const reset = async () => {
  await resetTestFixture(prisma, `TRUNCATE TABLE "MarketingReport" RESTART IDENTITY CASCADE`);
  // Clear the audit-linked fixtures in the same disposable test database.
  // Keep the v4 foreign-key closure explicit for audit-backed rows.
  await resetTestFixture(prisma, `
    TRUNCATE TABLE
      "PromptRefinerShadowAttempt",
      "PromptRefinerShadowRun",
      "PromptRefinerReservation",
      "PromptRefinerReservationStage",
      "AmuxReviewDecision",
      "AmuxIdeaAnalysisBudgetHold",
      "AmuxIdeaAnalysisPriceVersion",
      "EngineeringAgentApproval",
      "AmuxIdeaUnitDecision",
      "AmuxIdeaDraftUnit",
      "AmuxIdeaTransferPreview",
      "AmuxIdeaAnalysisChunk",
      "AmuxIdeaSourceScopeApproval",
      "AmuxIdeaSourcePlanRevision",
      "AmuxIdeaSubmission",
      "AmuxIdeaFrontierModelApproval",
      "AdminAuditLog"
    RESTART IDENTITY CASCADE
  `);
  await prisma.appSetting.deleteMany({
    where: { key: { in: [MARKETING_WEBHOOK_FAULT_ARM_KEY, MARKETING_WEBHOOK_SHADOW_KEY] } },
  });
};

beforeEach(async () => {
  for (const key of ["ADMIN_AUDIT_INTEGRITY_KEY", "TOMVERSE_DEPLOY_ENV", "APP_ENV"]) {
    saved[key] = process.env[key];
  }
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = AUDIT_SECRET;
  process.env.TOMVERSE_DEPLOY_ENV = "staging";
  process.env.APP_ENV = "staging";
  await reset();
});

after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await reset();
  await prisma.$disconnect();
});

const shadowAudits = () =>
  prisma.adminAuditLog.count({ where: { action: "marketing_webhook.shadow_recorded" } });

test("two deliveries of one event leave one report and one audit entry", async () => {
  const results = await Promise.allSettled([
    runMarketingTransaction(prisma, (tx) => recordMarketingWebhookShadow(tx, shadow(DIGEST))),
    runMarketingTransaction(prisma, (tx) => recordMarketingWebhookShadow(tx, shadow(DIGEST))),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(await prisma.marketingReport.count({ where: { kind: "webhook_shadow" } }), 1);
  // The refused delivery took its audit entry down with it.
  assert.equal(await shadowAudits(), 1);
  assert.equal(await marketingWebhookShadowExists(prisma, DIGEST), true);
});

test("a later delivery of a recorded event is refused by the index and leaves nothing", async () => {
  await runMarketingTransaction(prisma, (tx) => recordMarketingWebhookShadow(tx, shadow(DIGEST)));
  await assert.rejects(
    runMarketingTransaction(prisma, (tx) => recordMarketingWebhookShadow(tx, shadow(DIGEST))),
  );
  assert.equal(await prisma.marketingReport.count(), 1);
  assert.equal(await shadowAudits(), 1);
});

test("different events are different reports", async () => {
  await runMarketingTransaction(prisma, (tx) => recordMarketingWebhookShadow(tx, shadow(DIGEST)));
  await runMarketingTransaction(prisma, (tx) =>
    recordMarketingWebhookShadow(tx, shadow(OTHER_DIGEST)),
  );
  assert.equal(await prisma.marketingReport.count({ where: { kind: "webhook_shadow" } }), 2);
  assert.equal(await marketingWebhookShadowExists(prisma, OTHER_DIGEST), true);
  assert.equal(await marketingWebhookShadowExists(prisma, "f".repeat(64)), false);
});

test("two deliveries racing for one armed fault: exactly one consumes it", async () => {
  await runMarketingTransaction(prisma, (tx) =>
    setMarketingWebhookFaultArm(tx, {
      eventIdDigest: DIGEST,
      expectedGeneration: 0,
      ttlMs: 10 * 60 * 1000,
    }),
  );
  const consume = () =>
    runMarketingTransaction(prisma, (tx) =>
      consumeMarketingWebhookFaultArm(tx, { eventIdDigest: DIGEST }),
    );
  const outcomes = await Promise.all([consume(), consume(), consume()]);
  assert.equal(outcomes.filter((outcome) => outcome.consumed).length, 1);
  assert.equal(
    await prisma.adminAuditLog.count({ where: { action: "marketing_webhook.fault_arm_consumed" } }),
    1,
  );
  const row = await prisma.appSetting.findUnique({ where: { key: MARKETING_WEBHOOK_FAULT_ARM_KEY } });
  assert.equal(JSON.parse(row?.value ?? "{}").state, "consumed");
  // The retry finds it spent.
  assert.deepEqual(await consume(), { consumed: false });
});

test("an arm against a stale generation is refused by the compare-and-set", async () => {
  await runMarketingTransaction(prisma, (tx) =>
    setMarketingWebhookFaultArm(tx, { eventIdDigest: DIGEST, expectedGeneration: 0, ttlMs: 60_000 }),
  );
  await assert.rejects(
    runMarketingTransaction(prisma, (tx) =>
      setMarketingWebhookFaultArm(tx, { eventIdDigest: OTHER_DIGEST, expectedGeneration: 0, ttlMs: 60_000 }),
    ),
  );
  const row = await prisma.appSetting.findUnique({ where: { key: MARKETING_WEBHOOK_FAULT_ARM_KEY } });
  assert.equal(JSON.parse(row?.value ?? "{}").eventIdDigest, DIGEST);
});

test("two first writes of an absent setting: one succeeds, one is a conflict", async () => {
  const outcomes = await Promise.allSettled([
    runMarketingTransaction(prisma, (tx) =>
      writeMarketingWebhookShadowSwitch(tx, { enabled: true, expectedEnabled: false }),
    ),
    runMarketingTransaction(prisma, (tx) =>
      writeMarketingWebhookShadowSwitch(tx, { enabled: true, expectedEnabled: false }),
    ),
  ]);
  assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const rejected = outcomes.find((outcome) => outcome.status === "rejected");
  assert.ok(
    rejected?.status === "rejected" &&
      rejected.reason instanceof MarketingWebhookSettingRefusedError &&
      rejected.reason.code === "shadow_switch_conflict",
  );

  const arms = await Promise.allSettled([
    runMarketingTransaction(prisma, (tx) =>
      setMarketingWebhookFaultArm(tx, { eventIdDigest: DIGEST, expectedGeneration: 0, ttlMs: 60_000 }),
    ),
    runMarketingTransaction(prisma, (tx) =>
      setMarketingWebhookFaultArm(tx, { eventIdDigest: OTHER_DIGEST, expectedGeneration: 0, ttlMs: 60_000 }),
    ),
  ]);
  assert.equal(arms.filter((outcome) => outcome.status === "fulfilled").length, 1);
  const lost = arms.find((outcome) => outcome.status === "rejected");
  assert.ok(
    lost?.status === "rejected" &&
      lost.reason instanceof MarketingWebhookSettingRefusedError &&
      lost.reason.code === "fault_arm_conflict",
  );
});

test("an arm holding the audit lock and a delivery crossing it never deadlock", async () => {
  // The interleaving that deadlocked, made to happen rather than hoped for. The
  // arm side does what the admin runner does -- the audit chain lock first --
  // then waits until the delivery has started and gone as far as it can before
  // it writes the row. A delivery that took the row before the audit lock (the
  // order round 2 of the review found) would now hold the row and wait for the
  // audit lock, while the arm holds the audit lock and waits for the row:
  // PostgreSQL would kill one of them with a deadlock error, which is not a
  // domain refusal and fails this test. With the audit lock first on both
  // sides, the delivery simply waits its turn.
  await runMarketingTransaction(prisma, (tx) =>
    setMarketingWebhookFaultArm(tx, { eventIdDigest: DIGEST, expectedGeneration: 0, ttlMs: 60_000 }),
  );
  let delivery: Promise<{ readonly consumed: boolean }> | null = null;
  const arm = runMarketingTransaction(
    prisma,
    async (tx) => {
      await takeAuditChainLock(tx);
      delivery = runMarketingTransaction(prisma, (inner) =>
        consumeMarketingWebhookFaultArm(inner, { eventIdDigest: DIGEST }),
      );
      // Long enough for the delivery to reach whatever it will block on.
      await new Promise((resolve) => setTimeout(resolve, 500));
      return setMarketingWebhookFaultArm(tx, {
        eventIdDigest: OTHER_DIGEST,
        expectedGeneration: 1,
        ttlMs: 60_000,
      });
    },
    { timeout: 15_000 },
  );
  const [armed, consumed] = await Promise.allSettled([
    arm,
    (async () => {
      while (delivery === null) await new Promise((resolve) => setTimeout(resolve, 10));
      return delivery;
    })(),
  ]);
  // The arm committed first, so the delivery found an arm for another event and
  // consumed nothing. Neither side failed.
  assert.equal(armed.status, "fulfilled", armed.status === "rejected" ? String(armed.reason) : "");
  assert.equal(consumed.status, "fulfilled", consumed.status === "rejected" ? String(consumed.reason) : "");
  assert.deepEqual(consumed.status === "fulfilled" ? consumed.value : null, { consumed: false });
});
