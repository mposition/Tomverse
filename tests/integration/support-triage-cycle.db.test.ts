import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  SUPPORT_TRIAGE_CYCLE_CADENCE_MS,
  readSupportTriageHealth,
  runSupportTriageCycleQuietly,
} from "@/lib/supportTriageCycle";
import { SUPPORT_TRIAGE_ENABLED_SETTING_KEY } from "@/lib/supportTriageLlmSetting";

// Support triage on the maintenance cron (docs/policy/support-triage.md §3, §7).
//
// What needs a database: the switch, the run rows that gate the cadence, and
// the retention run the triggers constrain.

const ON = { SUPPORT_TRIAGE_ENABLED: "true" };

const clearRuns = async () => {
  await prisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "test_cycle_slow_delete" ON "SupportTriageRun"`);
  await prisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS test_cycle_slow_delete()`);
  await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" DISABLE TRIGGER "SupportTriageRun_before_delete"`);
  try {
    await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageRun"`);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" ENABLE TRIGGER "SupportTriageRun_before_delete"`);
  }
};

const reset = async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageSuggestion"`);
  await prisma.feedback.deleteMany({ where: { id: { startsWith: "fb-cycle-" } } });
  await prisma.appSetting.deleteMany({ where: { key: SUPPORT_TRIAGE_ENABLED_SETTING_KEY } });
  await clearRuns();
};

const report = () =>
  prisma.feedback.create({ data: { id: "fb-cycle-a", type: "bug", message: "The answer stopped." } });

const nextTick = (ticks = 1) => new Date(Date.now() + ticks * SUPPORT_TRIAGE_CYCLE_CADENCE_MS + 1_000);

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("a deployment that never used triage writes nothing, whatever the tick", async () => {
  for (const env of [{}, { SUPPORT_TRIAGE_ENABLED: "false" }, { SUPPORT_TRIAGE_ENABLED: "TRUE" }]) {
    assert.deepEqual(await runSupportTriageCycleQuietly({ env }), {
      worker: { outcome: "off" },
      retention: { outcome: "off" },
    });
  }
  await report();
  await runSupportTriageCycleQuietly({ env: {} });
  assert.equal(await prisma.supportTriageRun.count(), 0);
  assert.equal(await prisma.supportTriageSuggestion.count({ where: { feedbackId: "fb-cycle-a" } }), 0);
});

test("on, the first tick triages a report and the next tick inside the cadence runs nothing", async () => {
  await report();
  const first = await runSupportTriageCycleQuietly({ env: ON, llm: null });
  assert.equal(first.worker.outcome, "ran");
  assert.equal(first.worker.pass?.ready, 1);
  assert.equal(first.retention.outcome, "ran");
  assert.equal(await prisma.supportTriageSuggestion.count({ where: { feedbackId: "fb-cycle-a" } }), 1);
  const second = await runSupportTriageCycleQuietly({ env: ON, llm: null });
  assert.deepEqual(second, { worker: { outcome: "not_due" }, retention: { outcome: "not_due" } });
  assert.equal(await prisma.supportTriageRun.count(), 2);
  // Past the cadence it runs again.
  const third = await runSupportTriageCycleQuietly({ env: ON, llm: null, now: nextTick() });
  assert.equal(third.worker.outcome, "ran");
  assert.equal(await prisma.supportTriageRun.count(), 4);
});

test("the Admin switch decides over the environment, and off still deletes what is left", async () => {
  await report();
  await runSupportTriageCycleQuietly({ env: ON, llm: null });
  await prisma.appSetting.create({ data: { key: SUPPORT_TRIAGE_ENABLED_SETTING_KEY, value: "false" } });
  const off = await runSupportTriageCycleQuietly({ env: ON, llm: null, now: nextTick() });
  assert.equal(off.worker.outcome, "off");
  // A suggestion exists: retention keeps its turn while the worker stays off.
  assert.equal(off.retention.outcome, "ran");
});

test("the cycle reports a stuck retention and never throws", async () => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" DISABLE TRIGGER "SupportTriageRun_before_insert"`);
  try {
    await prisma.$executeRawUnsafe(`
      INSERT INTO "SupportTriageRun" ("id", "kind", "outcome", "createdAt", "deadlineAt", "finishedAt")
      SELECT 'stuck', 'worker', 'success', t.b, t.b, t.b
        FROM (SELECT (clock_timestamp() AT TIME ZONE 'UTC') - interval '31 days' AS b) t`);
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "SupportTriageRun" ENABLE TRIGGER "SupportTriageRun_before_insert"`);
  }
  await prisma.$executeRawUnsafe(`CREATE FUNCTION test_cycle_slow_delete() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF OLD."id" = 'stuck' THEN PERFORM pg_sleep(1); END IF; RETURN OLD; END $$`);
  await prisma.$executeRawUnsafe(`CREATE TRIGGER "test_cycle_slow_delete" BEFORE DELETE ON "SupportTriageRun"
    FOR EACH ROW EXECUTE FUNCTION test_cycle_slow_delete()`);
  // Off, but a run row is past its retention: retention still takes its turn.
  const result = await runSupportTriageCycleQuietly({ env: {} });
  assert.deepEqual(result, { worker: { outcome: "off" }, retention: { outcome: "ran", notProgressing: true } });
});

test("the panel's health is quiet until triage is used, then names the last runs and what is overdue", async () => {
  assert.deepEqual(await readSupportTriageHealth({ env: {} }), {
    worker: null,
    retention: null,
    reportsToday: 0,
    failedRunsToday: 0,
    stale: false,
  });
  // On with nothing run yet: fail-closed.
  assert.equal((await readSupportTriageHealth({ env: ON })).stale, true);
  await report();
  await runSupportTriageCycleQuietly({ env: ON, llm: null });
  const fresh = await readSupportTriageHealth({ env: ON });
  assert.equal(fresh.stale, false);
  assert.equal(fresh.worker?.outcome, "success");
  assert.equal(fresh.retention?.outcome, "success");
  assert.equal(fresh.reportsToday, 1);
  assert.equal(fresh.failedRunsToday, 0);
  // Two hours on with no run: overdue, and still judged once switched off
  // because a suggestion is left to delete.
  const later = new Date(Date.now() + 2 * 60 * 60_000);
  assert.equal((await readSupportTriageHealth({ env: ON, now: later })).stale, true);
  assert.equal((await readSupportTriageHealth({ env: {}, now: later })).stale, true);
});
