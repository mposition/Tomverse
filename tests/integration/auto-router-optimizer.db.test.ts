import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { AUTO_LLM_ROUTER_DEFAULT_GUIDANCE } from "@/lib/autoLlmRouterCore";
import {
  AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY,
  readActiveRouterGuidance,
} from "@/lib/autoLlmRouterGuidance";
import {
  AUTO_LLM_ROUTER_MODEL_SETTING_KEY,
  readAutoLlmRouterModelId,
  updateAutoLlmRouterModelId,
} from "@/lib/autoLlmRouterSettings";
import { reserveRouterCost, settleRouterCost } from "@/lib/autoLlmRouter";
import { getProviderCostBudget } from "@/lib/providerCostBudget";
import {
  AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY,
  finishOptimizerCycle,
  readOptimizerAutomation,
  updateOptimizerAutomation,
  promoteAutoRouterOptimizerCycle,
  reserveOptimizerCycle,
  rollBackAutoRouterGuidance,
} from "@/lib/autoRouterOptimizer";
import {
  AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD,
  AUTO_ROUTER_OPTIMIZER_MONTH_CAP_MICRO_USD,
  AUTO_ROUTER_OPTIMIZER_RUN_CAP_MICRO_USD,
} from "@/lib/autoRouterOptimizerCore";
import { getProviderCostBudget } from "@/lib/providerCostBudget";

// The money and audit steps of the Auto router optimizer, on a real database.
// No model is called: the cycle's calls are covered by
// tests/autoRouterOptimizerCore.test.mjs with injected fakes.

const session = {
  user: { id: `router-optimizer-${randomUUID()}`, email: "optimizer@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;
const actor = { session, request: new Request("https://tomverse.test/api/admin/auto-llm-router/optimizer") };
const PROPOSAL = "Send greetings and small talk to the lightest model.\nSend code and maths to a strong model.";

// Two test-only providers with explicit budgets, so the shared provider
// buckets of real providers are never touched.
const OPTIMIZER_PROVIDER = "optimizertest";
const ROUTER_PROVIDER = "routertest";
const environment = {
  ...process.env,
  CHAT_PROVIDER_OPTIMIZERTEST_COST_MICROUSD_PER_DAY: "900000000",
  CHAT_PROVIDER_OPTIMIZERTEST_COST_MICROUSD_PER_MONTH: "9000000000",
  CHAT_PROVIDER_ROUTERTEST_COST_MICROUSD_PER_DAY: "900000000",
  CHAT_PROVIDER_ROUTERTEST_COST_MICROUSD_PER_MONTH: "9000000000",
};
const providerKeys = [`provider:${OPTIMIZER_PROVIDER}`, `provider:${ROUTER_PROVIDER}`];

const reset = async () => {
  await prisma.autoRouterOptimizerCycle.deleteMany({});
  await prisma.appSetting.deleteMany({
    where: {
      key: {
        in: [
          AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY,
          AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY,
          AUTO_LLM_ROUTER_MODEL_SETTING_KEY,
        ],
      },
    },
  });
  await prisma.chatUsageBucket.deleteMany({ where: { key: { in: providerKeys } } });
};
beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

/** `worstCaseMicroUsd` split 60/40 between the optimizer and router providers. */
const reserve = (worstCaseMicroUsd: number, now?: Date, by: typeof actor | "system" = actor) =>
  reserveOptimizerCycle({
    actor: by,
    optimizerModelId: "optimizer-model",
    routerModelId: "router-model",
    incumbentGuidance: AUTO_LLM_ROUTER_DEFAULT_GUIDANCE,
    providers: [
      { provider: OPTIMIZER_PROVIDER, microUsd: Math.round(worstCaseMicroUsd * 0.6) },
      { provider: ROUTER_PROVIDER, microUsd: worstCaseMicroUsd - Math.round(worstCaseMicroUsd * 0.6) },
    ],
    now,
    environment,
  });

const bucket = async (provider: string, period: "provider-cost-day" | "provider-cost-month") =>
  (await prisma.chatUsageBucket.findMany({ where: { key: `provider:${provider}`, period } }))
    .reduce((sum, row) => sum + Number(row.count), 0);

const seedCycle = (data: {
  status: string;
  createdAt?: Date;
  spentMicroUsd?: number;
  reservedMicroUsd?: number;
  incumbentGuidance?: string;
  candidateGuidance?: string | null;
}) =>
  prisma.autoRouterOptimizerCycle.create({
    data: {
      optimizerModelId: "optimizer-model",
      routerModelId: "router-model",
      incumbentGuidance: data.incumbentGuidance ?? AUTO_LLM_ROUTER_DEFAULT_GUIDANCE,
      candidateGuidance: data.candidateGuidance ?? null,
      reservedMicroUsd: data.reservedMicroUsd ?? 1_000,
      spentMicroUsd: data.spentMicroUsd ?? 0,
      status: data.status,
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });

const auditFor = (cycleId: string, action: string) =>
  prisma.adminAuditLog.count({ where: { targetId: cycleId, action } });

test("a reservation holds its worst case, is audited with the cycle, and one runs at a time", async () => {
  assert.deepEqual(await reserve(AUTO_ROUTER_OPTIMIZER_RUN_CAP_MICRO_USD + 1), { refused: "run_cap" });

  const first = await reserve(10_000);
  assert.ok("cycle" in first);
  assert.equal(first.cycle.reservedMicroUsd, 10_000);
  assert.equal(await auditFor(first.cycle.id, "auto.llm_router_optimizer.cycle_started"), 1);
  // Each provider's own day and month budget holds its share.
  assert.equal(await bucket(OPTIMIZER_PROVIDER, "provider-cost-day"), 6_000);
  assert.equal(await bucket(OPTIMIZER_PROVIDER, "provider-cost-month"), 6_000);
  assert.equal(await bucket(ROUTER_PROVIDER, "provider-cost-day"), 4_000);

  assert.deepEqual(await reserve(1_000), { refused: "already_running" });
  assert.equal(await prisma.autoRouterOptimizerCycle.count(), 1);
  assert.equal(await bucket(OPTIMIZER_PROVIDER, "provider-cost-day"), 6_000);
});

test("a full provider budget refuses the cycle and leaves nothing behind", async () => {
  const dayLimit = getProviderCostBudget(ROUTER_PROVIDER, environment).day;
  const today = new Date();
  await prisma.chatUsageBucket.create({
    data: {
      key: `provider:${ROUTER_PROVIDER}`,
      period: "provider-cost-day",
      periodStart: new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())),
      count: BigInt(dayLimit - 1_000),
    },
  });
  assert.deepEqual(await reserve(10_000), { refused: "provider_budget" });
  // The optimizer provider's share, taken first, rolled back with the rest.
  assert.equal(await bucket(OPTIMIZER_PROVIDER, "provider-cost-day"), 0);
  assert.equal(await bucket(ROUTER_PROVIDER, "provider-cost-day"), dayLimit - 1_000);
  assert.equal(await prisma.autoRouterOptimizerCycle.count(), 0);
});

test("a finished cycle settles each provider to what it spent, exactly once", async () => {
  const started = await reserve(10_000);
  assert.ok("cycle" in started);
  const spentByProvider = new Map([[OPTIMIZER_PROVIDER, 1_200]]);
  const data = { status: "passed", spentMicroUsd: 1_200, finishedAt: new Date() };
  assert.equal(await finishOptimizerCycle({ cycleId: started.cycle.id, data, spentByProvider }), true);
  assert.equal(await bucket(OPTIMIZER_PROVIDER, "provider-cost-day"), 1_200);
  assert.equal(await bucket(OPTIMIZER_PROVIDER, "provider-cost-month"), 1_200);
  assert.equal(await bucket(ROUTER_PROVIDER, "provider-cost-day"), 0);
  // A second settlement of the same cycle changes nothing.
  assert.equal(await finishOptimizerCycle({ cycleId: started.cycle.id, data, spentByProvider }), false);
  assert.equal(await bucket(OPTIMIZER_PROVIDER, "provider-cost-day"), 1_200);
});

test("a cycle cut off by a restart is closed at its full reservation, then a new one may start", async () => {
  const stale = await seedCycle({
    status: "running",
    reservedMicroUsd: 5_000,
    createdAt: new Date(Date.now() - 20 * 60_000),
  });
  const next = await reserve(1_000);
  assert.ok("cycle" in next);
  const closed = await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: stale.id } });
  assert.equal(closed.status, "error");
  assert.equal(closed.failure, "interrupted");
  assert.equal(closed.spentMicroUsd, 5_000);
  // A late result from the interrupted cycle is not recorded and gives nothing back.
  const late = await finishOptimizerCycle({
    cycleId: stale.id,
    data: { status: "passed", spentMicroUsd: 10, finishedAt: new Date() },
    spentByProvider: new Map(),
  });
  assert.equal(late, false);
  assert.equal((await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: stale.id } })).status, "error");
});

test("the day and month caps refuse a reservation that would cross them", async () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  await seedCycle({
    status: "passed",
    createdAt: new Date("2026-10-15T01:00:00.000Z"),
    spentMicroUsd: AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD - 500,
  });
  assert.deepEqual(await reserve(1_000, now), { refused: "day_cap" });
  assert.equal(await prisma.autoRouterOptimizerCycle.count(), 1);

  await prisma.autoRouterOptimizerCycle.deleteMany({});
  // Spread over earlier days of the month so no single day reaches its cap.
  for (let day = 1; day <= 7; day += 1) {
    await seedCycle({
      status: "failed",
      createdAt: new Date(Date.UTC(2026, 9, day, 6)),
      spentMicroUsd: Math.floor(AUTO_ROUTER_OPTIMIZER_MONTH_CAP_MICRO_USD / 7),
    });
  }
  assert.deepEqual(await reserve(1_000, now), { refused: "month_cap" });
  // A new month starts from nothing.
  const nextMonth = await reserve(1_000, new Date("2026-11-02T00:00:00.000Z"));
  assert.ok("cycle" in nextMonth);
});

test("promotion is a compare-and-set on the guidance the cycle measured", async () => {
  const cycle = await seedCycle({ status: "passed", candidateGuidance: PROPOSAL });
  const rival = await seedCycle({ status: "passed", candidateGuidance: `${PROPOSAL}\nPrefer fewer credits.` });
  const failed = await seedCycle({ status: "failed", candidateGuidance: PROPOSAL });

  assert.deepEqual(await promoteAutoRouterOptimizerCycle(failed.id, actor), { refused: "not_passed" });
  assert.deepEqual(await promoteAutoRouterOptimizerCycle("missing", actor), { refused: "not_found" });

  assert.deepEqual(await promoteAutoRouterOptimizerCycle(cycle.id, actor), { ok: true });
  const active = await readActiveRouterGuidance();
  assert.equal(active.guidance, PROPOSAL);
  assert.equal(active.cycleId, cycle.id);
  assert.deepEqual(active.history, [{ guidance: AUTO_LLM_ROUTER_DEFAULT_GUIDANCE, cycleId: null }]);
  assert.equal(await auditFor(cycle.id, "auto.llm_router_guidance.promoted"), 1);
  assert.ok((await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: cycle.id } })).promotedAt);

  assert.deepEqual(await promoteAutoRouterOptimizerCycle(cycle.id, actor), { refused: "already_promoted" });
  // The rival measured itself against the default, which is no longer in force.
  assert.deepEqual(await promoteAutoRouterOptimizerCycle(rival.id, actor), { refused: "stale" });
  assert.equal((await readActiveRouterGuidance()).cycleId, cycle.id);
});

test("rollback returns one step to the default and is audited", async () => {
  const cycle = await seedCycle({ status: "passed", candidateGuidance: PROPOSAL });
  assert.deepEqual(await rollBackAutoRouterGuidance(actor), { refused: "nothing_to_roll_back" });
  await promoteAutoRouterOptimizerCycle(cycle.id, actor);

  assert.deepEqual(await rollBackAutoRouterGuidance(actor), { ok: true });
  const active = await readActiveRouterGuidance();
  assert.equal(active.cycleId, null);
  assert.equal(active.guidance, AUTO_LLM_ROUTER_DEFAULT_GUIDANCE);
  assert.equal(
    await prisma.appSetting.count({ where: { key: AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY } }),
    0
  );
  assert.equal(await auditFor(cycle.id, "auto.llm_router_guidance.rolled_back"), 1);
  assert.deepEqual(await rollBackAutoRouterGuidance(actor), { refused: "nothing_to_roll_back" });
});

test("a finishing cycle and its close as interrupted never leave cost and buckets disagreeing", async () => {
  for (let round = 0; round < 5; round += 1) {
    await reset();
    const started = await reserve(10_000);
    assert.ok("cycle" in started);
    // Old enough to be closed as interrupted by the next reservation.
    await prisma.autoRouterOptimizerCycle.update({
      where: { id: started.cycle.id },
      data: { createdAt: new Date(Date.now() - 20 * 60_000) },
    });
    const [finished] = await Promise.all([
      finishOptimizerCycle({
        cycleId: started.cycle.id,
        data: { status: "passed", spentMicroUsd: 1_200, finishedAt: new Date() },
        spentByProvider: new Map([[OPTIMIZER_PROVIDER, 1_200]]),
      }),
      reserve(1_000),
    ]);
    const row = await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: started.cycle.id } });
    const optimizerDay = await bucket(OPTIMIZER_PROVIDER, "provider-cost-day");
    const routerDay = await bucket(ROUTER_PROVIDER, "provider-cost-day");
    // The second reservation (if it ran) holds 600 + 400 on top.
    const second = (await prisma.autoRouterOptimizerCycle.count()) === 2;
    const held = second ? { optimizer: 600, router: 400 } : { optimizer: 0, router: 0 };
    if (finished) {
      assert.equal(row.status, "passed");
      assert.equal(row.spentMicroUsd, 1_200);
      assert.equal(optimizerDay - held.optimizer, 1_200);
      assert.equal(routerDay - held.router, 0);
    } else {
      assert.equal(row.status, "error");
      assert.equal(row.spentMicroUsd, 10_000);
      assert.equal(optimizerDay - held.optimizer, 6_000);
      assert.equal(routerDay - held.router, 4_000);
    }
  }
});

test("an automatic promotion is the system actor's, through the same compare-and-set", async () => {
  const cycle = await seedCycle({ status: "passed", candidateGuidance: PROPOSAL });
  assert.deepEqual(await promoteAutoRouterOptimizerCycle(cycle.id, "system"), { ok: true });
  const entry = await prisma.adminAuditLog.findFirstOrThrow({
    where: { targetId: cycle.id, action: "auto.llm_router_guidance.promoted" },
  });
  assert.equal(entry.actorUserId, null);
  assert.equal((entry.metadata as { systemActor?: string }).systemActor, "auto-router-optimizer");
  assert.deepEqual(await promoteAutoRouterOptimizerCycle(cycle.id, "system"), { refused: "already_promoted" });
});

test("the daily step starts nothing while the daily switch is off", async () => {
  const { runScheduledAutoRouterOptimizerCycle } = await import("@/lib/autoRouterOptimizer");
  assert.deepEqual(await runScheduledAutoRouterOptimizerCycle(), { started: false, reason: "daily_off" });
  assert.equal(await prisma.autoRouterOptimizerCycle.count(), 0);
});

test("the automation switches change only together with their audit entry", async () => {
  assert.deepEqual(await readOptimizerAutomation(), { daily: false, autoPromote: false });
  await updateOptimizerAutomation(actor, { daily: true, autoPromote: false });
  assert.deepEqual(await readOptimizerAutomation(), { daily: true, autoPromote: false });
  const entry = await prisma.adminAuditLog.findFirstOrThrow({
    where: { action: "auto.llm_router_optimizer_automation.updated", targetId: AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY },
    orderBy: { createdAt: "desc" },
  });
  assert.deepEqual((entry.metadata as { after?: unknown }).after, { daily: true, autoPromote: false });
  assert.equal(entry.actorUserId, session.user?.id);

  await updateOptimizerAutomation(actor, { daily: false, autoPromote: false });
  assert.equal(await prisma.appSetting.count({ where: { key: AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY } }), 0);
});

test("the system starts at most one cycle a day; a person still may", async () => {
  const first = await reserve(1_000, undefined, "system");
  assert.ok("cycle" in first);
  await prisma.autoRouterOptimizerCycle.update({ where: { id: first.cycle.id }, data: { status: "failed" } });
  assert.deepEqual(await reserve(1_000, undefined, "system"), { refused: "daily_done" });
  const byPerson = await reserve(1_000);
  assert.ok("cycle" in byPerson);
  const rows = await prisma.autoRouterOptimizerCycle.findMany({ select: { startedBy: true } });
  assert.deepEqual(rows.map((row) => row.startedBy).sort(), ["person", "system"]);
});

test("the router model changes only together with its audit entry, and a no-op writes neither", async () => {
  const entries = () =>
    prisma.adminAuditLog.count({
      where: { action: "auto.llm_router_model.updated", targetId: AUTO_LLM_ROUTER_MODEL_SETTING_KEY, actorUserId: session.user?.id },
    });
  assert.equal(await updateAutoLlmRouterModelId(actor, "router-model"), true);
  assert.equal(await readAutoLlmRouterModelId(), "router-model");
  assert.equal(await entries(), 1);
  // A retry of the same request neither writes nor needs to: the first one
  // committed with its record.
  assert.equal(await updateAutoLlmRouterModelId(actor, "router-model"), false);
  assert.equal(await entries(), 1);
  assert.equal(await updateAutoLlmRouterModelId(actor, null), true);
  assert.equal(await readAutoLlmRouterModelId(), null);
  const last = await prisma.adminAuditLog.findFirstOrThrow({
    where: { action: "auto.llm_router_model.updated", actorUserId: session.user?.id },
    orderBy: { createdAt: "desc" },
  });
  assert.deepEqual(last.metadata, { before: "router-model", after: null });
});

test("a live router call holds its worst case in both provider buckets or neither, then settles to actual", async () => {
  const now = new Date();
  const { day } = getProviderCostBudget(ROUTER_PROVIDER);
  // Leave 100 micro-USD of room today.
  await prisma.chatUsageBucket.create({
    data: { key: `provider:${ROUTER_PROVIDER}`, period: "provider-cost-day", periodStart: utcDay(now), count: day - 100 },
  });
  assert.equal(await reserveRouterCost(ROUTER_PROVIDER, 101, now), false);
  assert.equal(await bucket(ROUTER_PROVIDER, "provider-cost-day"), day - 100);
  assert.equal(await bucket(ROUTER_PROVIDER, "provider-cost-month"), 0);

  assert.equal(await reserveRouterCost(ROUTER_PROVIDER, 100, now), true);
  assert.equal(await bucket(ROUTER_PROVIDER, "provider-cost-day"), day);
  assert.equal(await bucket(ROUTER_PROVIDER, "provider-cost-month"), 100);

  // The call cost 30 of the 100 held.
  await settleRouterCost(ROUTER_PROVIDER, 30 - 100, now);
  assert.equal(await bucket(ROUTER_PROVIDER, "provider-cost-day"), day - 70);
  assert.equal(await bucket(ROUTER_PROVIDER, "provider-cost-month"), 30);
});
