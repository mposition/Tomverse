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
import { prisma } from "@/lib/prisma";

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
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "MarketingReport", "AdminAuditLog" RESTART IDENTITY`);
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

test("an arm and a delivery crossing on one row never deadlock", async () => {
  // The admin runner takes the audit chain lock and then writes the arm; the
  // receiver now does the same. Round 2 of the review found the receiver taking
  // them in the opposite order, which is a deadlock waiting for the right
  // interleaving -- so this crosses them repeatedly and requires every one to
  // settle without a database error.
  await runMarketingTransaction(prisma, (tx) =>
    setMarketingWebhookFaultArm(tx, { eventIdDigest: DIGEST, expectedGeneration: 0, ttlMs: 60_000 }),
  );
  for (let round = 1; round <= 5; round += 1) {
    const outcomes = await Promise.allSettled([
      runMarketingTransaction(prisma, (tx) =>
        setMarketingWebhookFaultArm(tx, {
          eventIdDigest: DIGEST,
          expectedGeneration: round,
          ttlMs: 60_000,
        }),
      ),
      runMarketingTransaction(prisma, (tx) =>
        consumeMarketingWebhookFaultArm(tx, { eventIdDigest: DIGEST }),
      ),
    ]);
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        // A lost compare-and-set is an answer; a deadlock is not.
        assert.ok(
          outcome.reason instanceof MarketingWebhookSettingRefusedError,
          String(outcome.reason),
        );
      }
    }
    // Re-arm for the next crossing at whatever generation the row now holds.
    const row = await prisma.appSetting.findUnique({ where: { key: MARKETING_WEBHOOK_FAULT_ARM_KEY } });
    const generation = JSON.parse(row?.value ?? "{}").generation as number;
    if (generation === round) {
      await runMarketingTransaction(prisma, (tx) =>
        setMarketingWebhookFaultArm(tx, {
          eventIdDigest: DIGEST,
          expectedGeneration: generation,
          ttlMs: 60_000,
        }),
      );
    }
  }
});
