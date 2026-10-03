import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { BILLING_FINANCE_OPS_CONTROL_KEY } from "@/lib/billingFinanceOpsControl";
import { billingFinanceOpsIdempotencyKey } from "@/lib/billingFinanceOpsDigest";
import { checkBillingFinanceOpsSilence } from "@/lib/billingFinanceOpsSilence";
import { recordAgentDigestItem } from "@/lib/agentDigestStore";
import { prisma } from "@/lib/prisma";

// docs/policy/billing-finance-ops.md §1.3 signal 2 against PostgreSQL. The
// verdict's timing is the pure function's (tests/billingFinanceOpsSilence.test.mjs);
// here a switch enabled long ago is used, and the test only asserts the
// verdict when the database clock is already past today's slot plus an hour.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const ENV = { APP_ENV: "staging" };
let savedSwitch: string | null = null;

const setSwitch = (value: string) =>
  prisma.appSetting.upsert({
    where: { key: BILLING_FINANCE_OPS_CONTROL_KEY },
    create: { key: BILLING_FINANCE_OPS_CONTROL_KEY, value },
    update: { value },
  });

const clearDigests = async () => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" DISABLE TRIGGER "AgentDigestItem_before_delete"`);
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "AgentDigestItem" WHERE "agentKey" = 'billing-finance-ops'`);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" ENABLE TRIGGER "AgentDigestItem_before_delete"`);
  }
};

const dbToday = async () => {
  const [{ nowMs }] = await prisma.$queryRaw<{ nowMs: number }[]>`
    SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::float8 AS "nowMs"`;
  const now = Number(nowMs);
  return { now, today: new Date(now).toISOString().slice(0, 10) };
};

before(async () => {
  savedSwitch = (await prisma.appSetting.findUnique({ where: { key: BILLING_FINANCE_OPS_CONTROL_KEY } }))?.value ?? null;
  await clearDigests();
});

after(async () => {
  await clearDigests();
  if (savedSwitch === null) await prisma.appSetting.deleteMany({ where: { key: BILLING_FINANCE_OPS_CONTROL_KEY } });
  else await setSwitch(savedSwitch);
  await prisma.$disconnect();
});

test("off is off, and an unreadable or missing switch is control_unreadable", async () => {
  await setSwitch(JSON.stringify({ enabled: false, revision: 0, enabledAt: null }));
  assert.equal(await checkBillingFinanceOpsSilence(ENV), "off");
  await setSwitch("{");
  assert.equal(await checkBillingFinanceOpsSilence(ENV), "control_unreadable");
  await prisma.appSetting.deleteMany({ where: { key: BILLING_FINANCE_OPS_CONTROL_KEY } });
  assert.equal(await checkBillingFinanceOpsSilence(ENV), "control_unreadable");
});

test("enabled: no row today is silent, today's row is recorded", async () => {
  await setSwitch(JSON.stringify({ enabled: true, revision: 1, enabledAt: "2026-01-01T00:00:00.000Z" }));
  const { now, today } = await dbToday();
  const due = now >= Date.parse(`${today}T02:00:00.000Z`);
  const before = await checkBillingFinanceOpsSilence(ENV);
  assert.equal(before, due ? "silent" : "not_due");

  const recorded = await recordAgentDigestItem({
    agentKey: "billing-finance-ops",
    kind: "price_deadline_digest",
    schemaVersion: 1,
    idempotencyKey: billingFinanceOpsIdempotencyKey("staging", today),
    payload: { environment: "staging", computedAtDate: today, verdict: "quiet", items: [], rejectedFields: [] },
  });
  assert.equal(recorded.status, "created");
  assert.equal(await checkBillingFinanceOpsSilence(ENV), due ? "recorded" : "not_due");
});
