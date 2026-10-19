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
  promoteAutoRouterOptimizerCycle,
  reserveOptimizerCycle,
  rollBackAutoRouterGuidance,
} from "@/lib/autoRouterOptimizer";
import {
  AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD,
  AUTO_ROUTER_OPTIMIZER_MONTH_CAP_MICRO_USD,
  AUTO_ROUTER_OPTIMIZER_RUN_CAP_MICRO_USD,
} from "@/lib/autoRouterOptimizerCore";

// The money and audit steps of the Auto router optimizer, on a real database.
// No model is called: the cycle's calls are covered by
// tests/autoRouterOptimizerCore.test.mjs with injected fakes.

const session = {
  user: { id: `router-optimizer-${randomUUID()}`, email: "optimizer@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;
const actor = { session, request: new Request("https://tomverse.test/api/admin/auto-llm-router/optimizer") };
const PROPOSAL = "Send greetings and small talk to the lightest model.\nSend code and maths to a strong model.";

const reset = async () => {
  await prisma.autoRouterOptimizerCycle.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY } });
};
beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const reserve = (worstCaseMicroUsd: number, now?: Date) =>
  reserveOptimizerCycle({
    actor,
    optimizerModelId: "optimizer-model",
    routerModelId: "router-model",
    incumbentGuidance: AUTO_LLM_ROUTER_DEFAULT_GUIDANCE,
    worstCaseMicroUsd,
    now,
  });

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

test("a reservation is capped per run, audited with the cycle, and one runs at a time", async () => {
  const first = await reserve(AUTO_ROUTER_OPTIMIZER_RUN_CAP_MICRO_USD * 3);
  assert.ok("cycle" in first);
  assert.equal(first.cycle.reservedMicroUsd, AUTO_ROUTER_OPTIMIZER_RUN_CAP_MICRO_USD);
  assert.equal(await auditFor(first.cycle.id, "auto.llm_router_optimizer.cycle_started"), 1);

  assert.deepEqual(await reserve(1_000), { refused: "already_running" });
  assert.equal(await prisma.autoRouterOptimizerCycle.count(), 1);
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
  assert.deepEqual(active.previous, { guidance: AUTO_LLM_ROUTER_DEFAULT_GUIDANCE, cycleId: null });
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
