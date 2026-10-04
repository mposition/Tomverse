import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { BILLING_FINANCE_OPS_CONTROL_KEY } from "@/lib/billingFinanceOpsControl";
import { billingFinanceOpsIdempotencyKey } from "@/lib/billingFinanceOpsDigest";
import { checkBillingFinanceOpsSilence } from "@/lib/billingFinanceOpsSilence";
import { recordAgentDigestItem } from "@/lib/agentDigestStore";
import { type ObservedOperationalIncident, observeOperationalIncidents } from "@/lib/operationalMonitoring";
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

/** The verdict and every incident the check raised while producing it. */
const check = async () => {
  const incidents: ObservedOperationalIncident[] = [];
  const stop = observeOperationalIncidents((incident) => incidents.push(incident));
  try {
    return { verdict: await checkBillingFinanceOpsSilence(ENV), incidents };
  } finally {
    stop();
  }
};

/** An alert names the environment and the date and nothing else of the run. */
const assertAlert = (incidents: ObservedOperationalIncident[], code: string, today: string) => {
  assert.equal(incidents.length, 1);
  const [incident] = incidents;
  assert.equal(incident.code, code);
  assert.equal(incident.severity, "warning");
  assert.deepEqual(incident.context, { component: "billing-finance-ops-agent", environment: "staging", date: today });
};
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

test("off raises nothing; an unreadable or missing switch raises control_unreadable", async () => {
  const { today } = await dbToday();
  await setSwitch(JSON.stringify({ enabled: false, revision: 0, enabledAt: null }));
  const off = await check();
  assert.equal(off.verdict, "off");
  assert.equal(off.incidents.length, 0);

  await setSwitch("{");
  const malformed = await check();
  assert.equal(malformed.verdict, "control_unreadable");
  assertAlert(malformed.incidents, "BILLING_FINANCE_OPS_CONTROL_UNREADABLE", today);

  await prisma.appSetting.deleteMany({ where: { key: BILLING_FINANCE_OPS_CONTROL_KEY } });
  const missing = await check();
  assert.equal(missing.verdict, "control_unreadable");
  assertAlert(missing.incidents, "BILLING_FINANCE_OPS_CONTROL_UNREADABLE", today);
});

test("enabled: no row today is silent, today's row is recorded", async () => {
  await setSwitch(JSON.stringify({ enabled: true, revision: 1, enabledAt: "2026-01-01T00:00:00.000Z" }));
  const { now, today } = await dbToday();
  const due = now >= Date.parse(`${today}T02:00:00.000Z`);
  const before = await check();
  assert.equal(before.verdict, due ? "silent" : "not_due");
  if (due) assertAlert(before.incidents, "BILLING_FINANCE_OPS_DEADLINE_SILENT", today);
  else assert.equal(before.incidents.length, 0);

  const recorded = await recordAgentDigestItem({
    agentKey: "billing-finance-ops",
    kind: "price_deadline_digest",
    schemaVersion: 1,
    idempotencyKey: billingFinanceOpsIdempotencyKey("staging", today),
    payload: { environment: "staging", computedAtDate: today, verdict: "quiet", items: [], rejectedFields: [] },
  });
  assert.equal(recorded.status, "created");
  const after = await check();
  assert.equal(after.verdict, due ? "recorded" : "not_due");
  assert.equal(after.incidents.length, 0);
});

test("a switch turned on after today's slot is not due and raises nothing, whatever the time of day", async () => {
  await clearDigests();
  const { today } = await dbToday();
  await setSwitch(JSON.stringify({ enabled: true, revision: 2, enabledAt: `${today}T01:30:00.000Z` }));
  const result = await check();
  assert.equal(result.verdict, "not_due");
  assert.equal(result.incidents.length, 0);
});
