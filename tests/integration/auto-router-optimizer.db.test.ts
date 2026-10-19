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
  AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY,
  finishOptimizerCycle,
  readOptimizerAutomation,
  updateOptimizerAutomation,
  promoteAutoRouterOptimizerCycle,
  readAutoRouterOptimizerState,
  reserveOptimizerCycle,
  rollBackAutoRouterGuidance,
} from "@/lib/autoRouterOptimizer";
import {
  AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD,
  AUTO_ROUTER_OPTIMIZER_MONTH_CAP_MICRO_USD,
  AUTO_ROUTER_OPTIMIZER_RUN_CAP_MICRO_USD,
  AUTO_ROUTER_OPTIMIZER_STALE_RUNNING_MS,
} from "@/lib/autoRouterOptimizerCore";

// The money and audit steps of the Auto router optimizer, on a real database.
// No model is called: the cycle's calls are covered by
// tests/autoRouterOptimizerCore.test.mjs with injected fakes. Caps are judged
// on actual spend only (owner, 2026-10-19): nothing is reserved at the start.

const session = {
  user: { id: `router-optimizer-${randomUUID()}`, email: "optimizer@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;
const actor = { session, request: new Request("https://tomverse.test/api/admin/auto-llm-router/optimizer") };
const PROPOSAL = "Send greetings and small talk to the lightest model.\nSend code and maths to a strong model.";

// Two test-only providers, so the shared provider buckets of real providers
// are never touched.
const OPTIMIZER_PROVIDER = "optimizertest";
const ROUTER_PROVIDER = "routertest";
// An answering model's provider: neither the optimizer's nor the router's.
const ANSWER_PROVIDER = "answertest";
const providerKeys = [OPTIMIZER_PROVIDER, ROUTER_PROVIDER, ANSWER_PROVIDER].map((provider) => `provider:${provider}`);
// Old enough to be closed as interrupted.
const staleCreatedAt = () => new Date(Date.now() - AUTO_ROUTER_OPTIMIZER_STALE_RUNNING_MS - 5 * 60_000);

const reset = async () => {
  await prisma.autoRouterOptimizerCycle.deleteMany({});
  await prisma.appSetting.deleteMany({
    where: { key: { in: [AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY, AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY] } },
  });
  await prisma.chatUsageBucket.deleteMany({ where: { key: { in: providerKeys } } });
};
beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const reserve = (now?: Date, by: typeof actor | "system" = actor) =>
  reserveOptimizerCycle({
    actor: by,
    optimizerModelId: "optimizer-model",
    routerModelId: "router-model",
    incumbentGuidance: AUTO_LLM_ROUTER_DEFAULT_GUIDANCE,
    now,
  });

const bucket = async (provider: string, period: "provider-cost-day" | "provider-cost-month") =>
  (await prisma.chatUsageBucket.findMany({ where: { key: `provider:${provider}`, period } }))
    .reduce((sum, row) => sum + Number(row.count), 0);

const utcDay = (at: Date) => new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));

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

test("a cycle starts with the room left under the caps, reserves nothing, is audited with it, and one runs at a time", async () => {
  const first = await reserve();
  assert.ok("cycle" in first);
  assert.equal(first.cycle.budgetMicroUsd, AUTO_ROUTER_OPTIMIZER_RUN_CAP_MICRO_USD);
  const row = await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: first.cycle.id } });
  assert.equal(row.status, "running");
  assert.equal(row.reservedMicroUsd, 0);
  assert.equal(row.providerReservations, null);
  assert.equal(row.spentMicroUsd, 0);
  const audit = await prisma.adminAuditLog.findFirstOrThrow({
    where: { targetId: first.cycle.id, action: "auto.llm_router_optimizer.cycle_started" },
  });
  assert.equal(
    (audit.metadata as { budgetMicroUsd?: number }).budgetMicroUsd,
    AUTO_ROUTER_OPTIMIZER_RUN_CAP_MICRO_USD
  );
  // No provider bucket is held for a cycle that has spent nothing yet.
  assert.equal(await bucket(OPTIMIZER_PROVIDER, "provider-cost-day"), 0);
  assert.equal(await bucket(ROUTER_PROVIDER, "provider-cost-day"), 0);

  assert.deepEqual(await reserve(), { refused: "already_running" });
  assert.equal(await prisma.autoRouterOptimizerCycle.count(), 1);
});

test("a finished cycle adds what each provider was actually paid to its buckets, exactly once", async () => {
  const started = await reserve();
  assert.ok("cycle" in started);
  // Chat spend already in the router provider's day bucket stays and is added to.
  await prisma.chatUsageBucket.create({
    data: {
      key: `provider:${ROUTER_PROVIDER}`,
      period: "provider-cost-day",
      periodStart: utcDay(new Date()),
      count: BigInt(5_000),
    },
  });
  const spentByProvider = new Map([[OPTIMIZER_PROVIDER, 1_200], [ROUTER_PROVIDER, 300]]);
  const data = { status: "passed", spentMicroUsd: 1_500, finishedAt: new Date() };
  assert.equal(await finishOptimizerCycle({ cycleId: started.cycle.id, data, spentByProvider }), true);
  assert.equal(await bucket(OPTIMIZER_PROVIDER, "provider-cost-day"), 1_200);
  assert.equal(await bucket(OPTIMIZER_PROVIDER, "provider-cost-month"), 1_200);
  assert.equal(await bucket(ROUTER_PROVIDER, "provider-cost-day"), 5_300);
  assert.equal(await bucket(ROUTER_PROVIDER, "provider-cost-month"), 300);
  const row = await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: started.cycle.id } });
  assert.equal(row.status, "passed");
  assert.equal(row.spentMicroUsd, 1_500);
  // A second finish of the same cycle changes nothing.
  assert.equal(await finishOptimizerCycle({ cycleId: started.cycle.id, data, spentByProvider }), false);
  assert.equal(await bucket(OPTIMIZER_PROVIDER, "provider-cost-day"), 1_200);
  assert.equal(await bucket(ROUTER_PROVIDER, "provider-cost-day"), 5_300);
});

test("an answering model's spend is booked to its own provider, beside the optimizer's and the router's", async () => {
  const started = await reserve();
  assert.ok("cycle" in started);
  // As runOptimizerCycle sums it: each call to the provider that was paid.
  const spentByProvider = new Map([
    [OPTIMIZER_PROVIDER, 2_000],
    [ROUTER_PROVIDER, 400],
    [ANSWER_PROVIDER, 900],
  ]);
  const data = { status: "failed", failure: "too_few_decided", spentMicroUsd: 3_300, finishedAt: new Date() };
  assert.equal(await finishOptimizerCycle({ cycleId: started.cycle.id, data, spentByProvider }), true);
  for (const [provider, microUsd] of spentByProvider) {
    assert.equal(await bucket(provider, "provider-cost-day"), microUsd);
    assert.equal(await bucket(provider, "provider-cost-month"), microUsd);
  }
  const row = await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: started.cycle.id } });
  assert.equal(row.spentMicroUsd, 3_300);
});

test("Admin state shows a cycle's synthetic cases and never a real decision's", async () => {
  const realDecisionId = `real-${randomUUID()}`;
  const cycle = await prisma.autoRouterOptimizerCycle.create({
    data: {
      optimizerModelId: "optimizer-model",
      routerModelId: "router-model",
      incumbentGuidance: AUTO_LLM_ROUTER_DEFAULT_GUIDANCE,
      reservedMicroUsd: 0,
      status: "failed",
      failure: "too_few_decided",
      cases: [
        { decisionId: realDecisionId, incumbentPick: "strong", candidatePick: "light", verdict: "candidate" },
        {
          decisionId: "synthetic-1",
          source: "synthetic",
          message: "1마일은 몇 km인가요?",
          kind: "easy",
          incumbentPick: "strong",
          candidatePick: "light",
          verdict: "undecided",
        },
      ],
      summary: { evaluated: 2, undecided: 1 },
    },
  });
  const state = await readAutoRouterOptimizerState();
  const view = state.cycles.find((item) => item.id === cycle.id);
  assert.ok(view);
  assert.deepEqual(view.syntheticCases, [
    { message: "1마일은 몇 km인가요?", kind: "easy", incumbentPick: "strong", candidatePick: "light", verdict: "undecided" },
  ]);
  assert.equal("cases" in view, false);
  assert.equal(JSON.stringify(state).includes(realDecisionId), false);
});

test("a cycle that cannot record its result still books its known spend to the row and the buckets, once", async () => {
  const started = await reserve();
  assert.ok("cycle" in started);
  // The recovery path in runInBackground: the same finish, as a run error.
  const recover = () =>
    finishOptimizerCycle({
      cycleId: started.cycle.id,
      data: { status: "error", failure: "run_error", spentMicroUsd: 800, finishedAt: new Date() },
      spentByProvider: new Map([[OPTIMIZER_PROVIDER, 500], [ROUTER_PROVIDER, 300]]),
    });
  assert.equal(await recover(), true);
  const row = await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: started.cycle.id } });
  assert.equal(row.status, "error");
  assert.equal(row.failure, "run_error");
  assert.equal(row.spentMicroUsd, 800);
  assert.equal(await bucket(OPTIMIZER_PROVIDER, "provider-cost-day"), 500);
  assert.equal(await bucket(ROUTER_PROVIDER, "provider-cost-month"), 300);
  // Had the first recording committed after all, the recovery adds nothing.
  assert.equal(await recover(), false);
  assert.equal(await bucket(OPTIMIZER_PROVIDER, "provider-cost-day"), 500);
  assert.equal(await bucket(ROUTER_PROVIDER, "provider-cost-month"), 300);
});

test("a cycle cut off by a restart is closed without changing its recorded spend, then a new one may start", async () => {
  const stale = await seedCycle({
    status: "running",
    reservedMicroUsd: 5_000, // an older row's reservation: never turned into spend
    spentMicroUsd: 700,
    createdAt: staleCreatedAt(),
  });
  const next = await reserve();
  assert.ok("cycle" in next);
  const closed = await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: stale.id } });
  assert.equal(closed.status, "error");
  assert.equal(closed.failure, "interrupted");
  assert.equal(closed.spentMicroUsd, 700);
  assert.ok(closed.finishedAt);
  // A late result from the interrupted cycle is not recorded and adds nothing.
  const late = await finishOptimizerCycle({
    cycleId: stale.id,
    data: { status: "passed", spentMicroUsd: 10, finishedAt: new Date() },
    spentByProvider: new Map([[OPTIMIZER_PROVIDER, 10]]),
  });
  assert.equal(late, false);
  const after = await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: stale.id } });
  assert.equal(after.status, "error");
  assert.equal(after.spentMicroUsd, 700);
  assert.equal(await bucket(OPTIMIZER_PROVIDER, "provider-cost-day"), 0);
});

test("the day and month caps refuse once actual spend reaches them; below, the budget is the room left", async () => {
  const now = new Date("2026-10-15T12:00:00.000Z");
  const today = await seedCycle({
    status: "passed",
    createdAt: new Date("2026-10-15T01:00:00.000Z"),
    spentMicroUsd: AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD - 500,
  });
  // Under the cap: admitted, with only the day's room as its budget.
  const admitted = await reserve(now);
  assert.ok("cycle" in admitted);
  assert.equal(admitted.cycle.budgetMicroUsd, 500);
  await prisma.autoRouterOptimizerCycle.delete({ where: { id: admitted.cycle.id } });
  // At the cap: refused, and nothing is written.
  await prisma.autoRouterOptimizerCycle.update({
    where: { id: today.id },
    data: { spentMicroUsd: AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD },
  });
  assert.deepEqual(await reserve(now), { refused: "day_cap" });
  assert.equal(await prisma.autoRouterOptimizerCycle.count(), 1);

  // An older row's reservation is not spend: only what it spent counts.
  await prisma.autoRouterOptimizerCycle.deleteMany({});
  await seedCycle({
    status: "error",
    createdAt: new Date("2026-10-15T02:00:00.000Z"),
    reservedMicroUsd: AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD,
    spentMicroUsd: 1_000,
  });
  const pastReservation = await reserve(now);
  assert.ok("cycle" in pastReservation);
  assert.equal(pastReservation.cycle.budgetMicroUsd, AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD - 1_000);

  await prisma.autoRouterOptimizerCycle.deleteMany({});
  // Spread over earlier days of the month so no single day passes its cap.
  const perDay = AUTO_ROUTER_OPTIMIZER_MONTH_CAP_MICRO_USD / 6;
  assert.ok(perDay <= AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD);
  for (let day = 1; day <= 6; day += 1) {
    await seedCycle({
      status: "failed",
      createdAt: new Date(Date.UTC(2026, 9, day, 6)),
      spentMicroUsd: perDay,
    });
  }
  assert.deepEqual(await reserve(now), { refused: "month_cap" });
  // A new month starts from nothing.
  const nextMonth = await reserve(new Date("2026-11-02T00:00:00.000Z"));
  assert.ok("cycle" in nextMonth);
  assert.equal(nextMonth.cycle.budgetMicroUsd, AUTO_ROUTER_OPTIMIZER_RUN_CAP_MICRO_USD);
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
    const started = await reserve();
    assert.ok("cycle" in started);
    // Old enough to be closed as interrupted by the next start.
    await prisma.autoRouterOptimizerCycle.update({
      where: { id: started.cycle.id },
      data: { createdAt: staleCreatedAt() },
    });
    const [finished] = await Promise.all([
      finishOptimizerCycle({
        cycleId: started.cycle.id,
        data: { status: "passed", spentMicroUsd: 1_200, finishedAt: new Date() },
        spentByProvider: new Map([[OPTIMIZER_PROVIDER, 900], [ROUTER_PROVIDER, 300]]),
      }),
      reserve(),
    ]);
    const row = await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: started.cycle.id } });
    // The second start, if it ran, holds nothing in any bucket.
    const optimizerMonth = await bucket(OPTIMIZER_PROVIDER, "provider-cost-month");
    const routerMonth = await bucket(ROUTER_PROVIDER, "provider-cost-month");
    if (finished) {
      assert.equal(row.status, "passed");
      assert.equal(row.spentMicroUsd, 1_200);
      assert.equal(optimizerMonth, 900);
      assert.equal(routerMonth, 300);
    } else {
      assert.equal(row.status, "error");
      assert.equal(row.spentMicroUsd, 0);
      assert.equal(optimizerMonth, 0);
      assert.equal(routerMonth, 0);
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
  const first = await reserve(undefined, "system");
  assert.ok("cycle" in first);
  await prisma.autoRouterOptimizerCycle.update({ where: { id: first.cycle.id }, data: { status: "failed" } });
  assert.deepEqual(await reserve(undefined, "system"), { refused: "daily_done" });
  const byPerson = await reserve();
  assert.ok("cycle" in byPerson);
  const rows = await prisma.autoRouterOptimizerCycle.findMany({ select: { startedBy: true } });
  assert.deepEqual(rows.map((row) => row.startedBy).sort(), ["person", "system"]);
});
