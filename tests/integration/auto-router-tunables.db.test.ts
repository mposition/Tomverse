import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { AUTO_LLM_ROUTER_TIMEOUT_MS } from "@/lib/autoLlmRouterCore";
import {
  applyCycleTunableChanges,
  revertTunedTimeoutIfWorse,
  undoTunableByOperator,
  updateSettingAutoApply,
} from "@/lib/autoRouterTunables";
import {
  AUTO_ROUTER_SETTING_AUTO_APPLY_KEY,
  AUTO_ROUTER_TUNABLES_SETTING_KEY,
  readAutoRouterTunables,
  readSettingAutoApply,
} from "@/lib/autoRouterTunablesRead";

// The optimizer's own setting changes on a real database (owner approval
// 2026-10-20, with a notice to the operator): nothing applies while the
// owner's switch is off; an admitted change commits with its system audit
// entry and its outcome in the cycle's summary; a timeout that made routing
// worse is undone by the next cycle; an operator can undo any of them.
// No email leaves: OPS_ALERT_EMAIL is unset here, so the notice only logs.

// The audit writer signs with the environment's key, as the other suites in
// this database do: a suite-only key would break a later whole-chain check.
delete process.env.OPS_ALERT_EMAIL;
delete process.env.ADMIN_ALERT_EMAIL;

const session = {
  user: { id: `tunables-${randomUUID()}`, email: "tunables@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;
const actor = { session, request: new Request("https://tomverse.test/api/admin/auto-llm-router/optimizer") };

const reset = async () => {
  await prisma.autoRouterOptimizerCycle.deleteMany({});
  await prisma.autoRouterDecision.deleteMany({ where: { traceId: { startsWith: "tunables-test-" } } });
  await prisma.appSetting.deleteMany({
    where: { key: { in: [AUTO_ROUTER_TUNABLES_SETTING_KEY, AUTO_ROUTER_SETTING_AUTO_APPLY_KEY] } },
  });
};
beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const seedCycle = () =>
  prisma.autoRouterOptimizerCycle.create({
    data: {
      optimizerModelId: "optimizer-model",
      routerModelId: "router-model",
      incumbentGuidance: "guidance",
      reservedMicroUsd: 0,
      status: "failed",
      summary: { evaluated: 20 },
    },
  });

const busyRouter = {
  decisions: 100,
  outcomes: { picked: 88, invalid: 0, error: 4, timeout: 8 },
  latencyMs: { p50: 2_100, p90: 5_000 },
};
const candidates = [
  { id: "mini", credits: 9 },
  { id: "luna", credits: 9 },
  { id: "terra", credits: 12 },
];
const raiseTimeout = { setting: "routerTimeoutMs", value: 6_500, modelId: null, hours: null, reason: "타임아웃 8%" };
const excludeMini = { setting: "excludeModel", value: null, modelId: "mini", hours: 12, reason: "답변 실패 반복" };

const auditRows = (action: string) =>
  prisma.adminAuditLog.findMany({ where: { action }, orderBy: { createdAt: "asc" } });

test("with the owner's switch off nothing is applied, and the cycle says it was skipped", async () => {
  const cycle = await seedCycle();
  const applied = await applyCycleTunableChanges({
    cycleId: cycle.id,
    proposed: [raiseTimeout],
    evidence: { routerStats: busyRouter, answerStats: {}, candidates },
  });
  assert.deepEqual(applied, []);
  assert.deepEqual(await readAutoRouterTunables(), { routerTimeoutMs: null, excluded: [], timeoutRevertedAt: null });
  const summary = (await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: cycle.id } }))
    .summary as Record<string, unknown>;
  assert.equal((summary.settingChanges as { skipped: string }).skipped, "auto_apply_off");
  assert.equal(summary.evaluated, 20, "the rest of the summary is kept");
});

test("an admitted change commits with its system audit entry and its outcome in the cycle", async () => {
  await updateSettingAutoApply(actor, true);
  assert.equal(await readSettingAutoApply(), true);
  const cycle = await seedCycle();
  const before = (await auditRows("auto.llm_router_tunable.applied")).length;
  const applied = await applyCycleTunableChanges({
    cycleId: cycle.id,
    proposed: [raiseTimeout, excludeMini, { setting: "maxCredits", value: 1, modelId: null, hours: null, reason: "x" }],
    evidence: {
      routerStats: busyRouter,
      answerStats: { mini: { answered: 3, failed: 3 } },
      candidates,
    },
  });
  assert.equal(applied.length, 2);
  const tunables = await readAutoRouterTunables();
  assert.equal(tunables.routerTimeoutMs?.value, 6_500);
  assert.equal(tunables.routerTimeoutMs?.previous, AUTO_LLM_ROUTER_TIMEOUT_MS);
  assert.deepEqual(tunables.excluded.map((item) => item.modelId), ["mini"]);
  const audit = await auditRows("auto.llm_router_tunable.applied");
  assert.equal(audit.length, before + 1);
  const metadata = audit.at(-1)!.metadata as Record<string, unknown>;
  assert.equal(metadata.cycleId, cycle.id);
  assert.equal(metadata.systemActor, "auto-router-optimizer");
  const summary = (await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: cycle.id } }))
    .summary as { settingChanges: { applied: unknown[]; rejected: { reason: string }[] } };
  assert.equal(summary.settingChanges.applied.length, 2);
  assert.deepEqual(summary.settingChanges.rejected.map((item) => item.reason), ["unknown_setting"]);
});

test("a tuned timeout that made routing worse is undone by the next cycle, with its audit entry", async () => {
  await updateSettingAutoApply(actor, true);
  const cycle = await seedCycle();
  await applyCycleTunableChanges({
    cycleId: cycle.id,
    proposed: [raiseTimeout],
    evidence: { routerStats: busyRouter, answerStats: {}, candidates },
  });
  // Before: 12% timeouts or errors. After the change: 40% on 30 decisions.
  const user = await prisma.user.create({
    data: { email: `tunables-${randomUUID()}@example.test`, name: "Tunables" },
  });
  try {
    const conversation = await prisma.conversation.create({
      data: { selectedModels: '["gpt-6-luna"]', userId: user.id, title: "t", kind: "chat" },
    });
    await prisma.autoRouterDecision.createMany({
      data: Array.from({ length: 30 }, (_, index) => ({
        version: "auto-llm-router-v1",
        traceId: `tunables-test-${index}`,
        userId: user.id,
        conversationId: conversation.id,
        routerInput: "x",
        candidates: [],
        taskKind: "general",
        ruleModelId: "mini",
        routerModelId: "router",
        pickedModelId: index < 12 ? null : "luna",
        outcome: index < 12 ? "error" : "picked",
        latencyMs: index < 12 ? 7_000 : 1_000,
      })),
    });
    // The audit table is append-only: count what this test adds.
    const revertsBefore = (await auditRows("auto.llm_router_tunable.reverted")).length;
    assert.equal(await revertTunedTimeoutIfWorse(), "reverted");
    const afterRevert = await readAutoRouterTunables();
    assert.equal(afterRevert.routerTimeoutMs, null);
    assert.ok(afterRevert.timeoutRevertedAt, "the cooldown is on record");
    // The same cycle cannot put the reverted timeout straight back.
    const again = await applyCycleTunableChanges({
      cycleId: cycle.id,
      proposed: [raiseTimeout],
      evidence: { routerStats: busyRouter, answerStats: {}, candidates },
    });
    assert.deepEqual(again, []);
    assert.equal((await readAutoRouterTunables()).routerTimeoutMs, null);
    assert.equal((await auditRows("auto.llm_router_tunable.reverted")).length, revertsBefore + 1);
    // Nothing tuned now: a second check keeps.
    assert.equal(await revertTunedTimeoutIfWorse(), "kept");
  } finally {
    await prisma.autoRouterDecision.deleteMany({ where: { userId: user.id } });
    await prisma.conversation.deleteMany({ where: { userId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
  }
});

test("an operator undoes an exclusion or the timeout, and undoing what is not set is refused", async () => {
  await updateSettingAutoApply(actor, true);
  const cycle = await seedCycle();
  await applyCycleTunableChanges({
    cycleId: cycle.id,
    proposed: [raiseTimeout, excludeMini],
    evidence: { routerStats: busyRouter, answerStats: { mini: { answered: 1, failed: 2 } }, candidates },
  });
  assert.deepEqual(await undoTunableByOperator(actor, { setting: "excludeModel", modelId: "mini" }), { ok: true });
  assert.deepEqual((await readAutoRouterTunables()).excluded, []);
  assert.deepEqual(await undoTunableByOperator(actor, { setting: "excludeModel", modelId: "mini" }), {
    refused: "not_set",
  });
  assert.deepEqual(await undoTunableByOperator(actor, { setting: "routerTimeoutMs" }), { ok: true });
  // A person's undo also starts the cooldown, so the row keeps that record.
  const left = await readAutoRouterTunables();
  assert.equal(left.routerTimeoutMs, null);
  assert.deepEqual(left.excluded, []);
  assert.ok(left.timeoutRevertedAt);
  assert.equal((await auditRows("auto.llm_router_tunable.undone")).length >= 2, true);
});
