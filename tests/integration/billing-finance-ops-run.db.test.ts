import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { BILLING_FINANCE_OPS_CONTROL_KEY } from "@/lib/billingFinanceOpsControl";
import { runBillingFinanceOpsDeadline } from "@/lib/billingFinanceOpsRun";
import { prisma } from "@/lib/prisma";

// docs/policy/billing-finance-ops.md §1.1–1.2 against PostgreSQL through the
// migration history: an enabled run records one digest and its audit entry, a
// second run the same day replays, a run past its deadline leaves nothing,
// and a switch row the reader cannot read is a fault, not "off".

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const SECRET = "t".repeat(40);
const ENV = { BILLING_FINANCE_OPS_RUN_SECRET: SECRET, APP_ENV: "staging" };
const ON = JSON.stringify({ enabled: true, revision: 1, enabledAt: "2026-10-04T00:00:00.000Z" });

const call = (deadlineMs?: number) =>
  runBillingFinanceOpsDeadline(
    new Request("https://example.invalid/api/internal/agents/billing-finance-ops/runs", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    }),
    { env: ENV, ...(deadlineMs === undefined ? {} : { deadlineMs }) },
  );

let savedSwitch: string | null = null;

const clearDigests = async () => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" DISABLE TRIGGER "AgentDigestItem_before_delete"`);
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "AgentDigestItem" WHERE "agentKey" = 'billing-finance-ops'`);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" ENABLE TRIGGER "AgentDigestItem_before_delete"`);
  }
};

const setSwitch = (value: string) =>
  prisma.appSetting.upsert({
    where: { key: BILLING_FINANCE_OPS_CONTROL_KEY },
    create: { key: BILLING_FINANCE_OPS_CONTROL_KEY, value },
    update: { value },
  });

before(async () => {
  savedSwitch = (await prisma.appSetting.findUnique({ where: { key: BILLING_FINANCE_OPS_CONTROL_KEY } }))?.value ?? null;
  await clearDigests();
});

after(async () => {
  await clearDigests();
  if (savedSwitch === null) {
    await prisma.appSetting.deleteMany({ where: { key: BILLING_FINANCE_OPS_CONTROL_KEY } });
  } else {
    await setSwitch(savedSwitch);
  }
  await prisma.$disconnect();
});

const digestRows = () =>
  prisma.agentDigestItem.findMany({ where: { agentKey: "billing-finance-ops" }, orderBy: { createdAt: "asc" } });

test("the seeded switch is off and a run records nothing", async () => {
  await setSwitch(JSON.stringify({ enabled: false, revision: 0, enabledAt: null }));
  assert.deepEqual((await call()).body, { result: "disabled" });
  assert.equal((await digestRows()).length, 0);
});

test("a run past its deadline is refused by the database and leaves no row and no audit entry", async () => {
  await setSwitch(ON);
  const auditBefore = await prisma.adminAuditLog.count({ where: { targetType: "AgentDigestItem" } });
  const answer = await call(-1_000);
  assert.deepEqual(answer, { status: 409, body: { result: "deadline_exceeded" } });
  assert.equal((await digestRows()).length, 0);
  assert.equal(await prisma.adminAuditLog.count({ where: { targetType: "AgentDigestItem" } }), auditBefore);
});

test("an enabled run records one digest for this environment and UTC day; a second one replays", async () => {
  await setSwitch(ON);
  const first = await call();
  assert.deepEqual(first, { status: 201, body: { result: "created" } });

  const rows = await digestRows();
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.kind, "price_deadline_digest");
  const [{ today }] = await prisma.$queryRaw<{ today: string }[]>`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS today`;
  assert.equal(row.idempotencyKey, `billing-finance-ops:price-deadline:staging:${today}`);
  const payload = row.payload as Record<string, unknown>;
  assert.equal(payload.environment, "staging");
  assert.equal(payload.computedAtDate, today);
  assert.deepEqual(Object.keys(payload).sort(), ["computedAtDate", "environment", "items", "rejectedFields", "verdict"]);

  const audit = await prisma.adminAuditLog.findFirstOrThrow({ where: { targetType: "AgentDigestItem", targetId: row.id } });
  assert.equal((audit.metadata as Record<string, unknown>).systemActor, "billing-finance-ops-intake");

  assert.deepEqual(await call(), { status: 200, body: { result: "replayed" } });
  assert.equal((await digestRows()).length, 1);
});

test("a switch row that cannot be read answers control_unreadable, never disabled", async () => {
  await setSwitch("{ not json");
  assert.deepEqual(await call(), { status: 503, body: { result: "control_unreadable" } });
  await prisma.appSetting.deleteMany({ where: { key: BILLING_FINANCE_OPS_CONTROL_KEY } });
  assert.deepEqual(await call(), { status: 503, body: { result: "control_unreadable" } });
});
