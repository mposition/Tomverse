import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import {
  BILLING_FINANCE_OPS_CONTROL_KEY,
  BILLING_FINANCE_OPS_MONITOR_CONFIRMATION_KEY,
} from "@/lib/billingFinanceOpsControl";
import {
  BILLING_FINANCE_OPS_CONTROL_AUDIT_ACTION,
  BILLING_FINANCE_OPS_MONITORS_AUDIT_ACTION,
  BillingFinanceOpsControlRefusedError,
  recordBillingFinanceOpsMonitorConfirmation,
  setBillingFinanceOpsSwitch,
} from "@/lib/billingFinanceOpsControlStore";
import { prisma } from "@/lib/prisma";

// docs/policy/billing-finance-ops.md §1.2–1.3 against PostgreSQL: each write
// and its administrator audit entry commit together, turning on needs a recent
// monitor check, turning off needs nothing, and a refusal writes nothing.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const session = { user: { id: "bfo-operator", email: "operator@example.test" }, expires: "2099-01-01T00:00:00.000Z" };
const KEYS = [BILLING_FINANCE_OPS_CONTROL_KEY, BILLING_FINANCE_OPS_MONITOR_CONFIRMATION_KEY];
let saved: { key: string; value: string }[] = [];

before(async () => {
  saved = await prisma.appSetting.findMany({ where: { key: { in: KEYS } }, select: { key: true, value: true } });
});

after(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } });
  for (const row of saved) await prisma.appSetting.create({ data: row });
  await prisma.$disconnect();
});

const readSwitch = async () =>
  JSON.parse((await prisma.appSetting.findUniqueOrThrow({ where: { key: BILLING_FINANCE_OPS_CONTROL_KEY } })).value);

const auditCount = (action: string) => prisma.adminAuditLog.count({ where: { action } });

const refusedWith = (code: string) => (error: unknown) =>
  error instanceof BillingFinanceOpsControlRefusedError && error.code === code;

test("turning on without a monitor check is refused and writes nothing", async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } });
  await prisma.appSetting.create({
    data: { key: BILLING_FINANCE_OPS_CONTROL_KEY, value: JSON.stringify({ enabled: false, revision: 0, enabledAt: null }) },
  });
  const before = await auditCount(BILLING_FINANCE_OPS_CONTROL_AUDIT_ACTION);
  await assert.rejects(
    setBillingFinanceOpsSwitch({ session: session as never, enabled: true }),
    refusedWith("monitor_confirmation_required"),
  );
  assert.deepEqual(await readSwitch(), { enabled: false, revision: 0, enabledAt: null });
  assert.equal(await auditCount(BILLING_FINANCE_OPS_CONTROL_AUDIT_ACTION), before);
});

test("a monitor check, then on, then off: each one row change and one audit entry", async () => {
  const monitorsBefore = await auditCount(BILLING_FINANCE_OPS_MONITORS_AUDIT_ACTION);
  const { confirmedAt } = await recordBillingFinanceOpsMonitorConfirmation({ session: session as never });
  assert.equal(await auditCount(BILLING_FINANCE_OPS_MONITORS_AUDIT_ACTION), monitorsBefore + 1);
  const confirmation = await prisma.appSetting.findUniqueOrThrow({ where: { key: BILLING_FINANCE_OPS_MONITOR_CONFIRMATION_KEY } });
  assert.deepEqual(JSON.parse(confirmation.value), { confirmedAt });

  const controlBefore = await auditCount(BILLING_FINANCE_OPS_CONTROL_AUDIT_ACTION);
  const onState = await setBillingFinanceOpsSwitch({ session: session as never, enabled: true });
  assert.equal(onState.enabled, true);
  assert.equal(onState.revision, 1);
  assert.ok(onState.enabledAt && Math.abs(Date.parse(onState.enabledAt) - Date.now()) < 60_000, "enabledAt is the database's now");
  assert.deepEqual(await readSwitch(), onState);

  const audit = await prisma.adminAuditLog.findFirstOrThrow({
    where: { action: BILLING_FINANCE_OPS_CONTROL_AUDIT_ACTION },
    orderBy: { createdAt: "desc" },
  });
  assert.equal(audit.actorUserId, "bfo-operator");
  assert.deepEqual(audit.metadata, { from: "disabled", to: "enabled", revision: 1, enabledAt: onState.enabledAt });

  assert.deepEqual(await setBillingFinanceOpsSwitch({ session: session as never, enabled: false }), {
    enabled: false,
    revision: 2,
    enabledAt: null,
  });
  assert.equal(await auditCount(BILLING_FINANCE_OPS_CONTROL_AUDIT_ACTION), controlBefore + 2);
});

test("an unreadable switch can always be turned off, which writes a clean row", async () => {
  await prisma.appSetting.update({ where: { key: BILLING_FINANCE_OPS_CONTROL_KEY }, data: { value: "{ broken" } });
  await assert.rejects(setBillingFinanceOpsSwitch({ session: session as never, enabled: true }), refusedWith("control_unreadable"));
  assert.deepEqual(await setBillingFinanceOpsSwitch({ session: session as never, enabled: false }), {
    enabled: false,
    revision: 1,
    enabledAt: null,
  });
  assert.deepEqual(await readSwitch(), { enabled: false, revision: 1, enabledAt: null });
});
