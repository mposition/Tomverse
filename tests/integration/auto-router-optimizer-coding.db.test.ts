import { Prisma } from "@prisma/client";
import { verifiedOptimizerSummary } from "../fixtures/optimizerVerifiedSummary";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import {
  AUTO_LLM_ROUTER_CODING_GUIDANCE,
  AUTO_LLM_ROUTER_DEFAULT_GUIDANCE,
  AUTO_LLM_ROUTER_DEFAULT_REWRITE_GUIDANCE,
} from "@/lib/autoLlmRouterCore";
import {
  AUTO_LLM_ROUTER_CODING_GUIDANCE_SETTING_KEY,
  AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY,
  AUTO_LLM_ROUTER_REWRITE_GUIDANCE_SETTING_KEY,
  readActiveRouterGuidance,
} from "@/lib/autoLlmRouterGuidance";
import { AUTO_LLM_ROUTER_MODEL_SETTING_KEY } from "@/lib/autoLlmRouterSettings";
import {
  AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY,
  AUTO_ROUTER_OPTIMIZER_MODEL_SETTING_KEY,
  promoteAutoRouterOptimizerCycle,
  reserveOptimizerCycle,
} from "@/lib/autoRouterOptimizer";
import {
  AUTO_REWRITE_OPTIMIZER_AUTOMATION_SETTING_KEY,
  promoteAutoRewriteOptimizerCycle,
  runScheduledOptimizerCycle,
} from "@/lib/autoRewriteOptimizer";
import {
  AUTO_CODING_OPTIMIZER_AUTOMATION_SETTING_KEY,
  promoteCodingRouterOptimizerCycle,
  readCodingOptimizerAutomation,
  readCodingRouterOptimizerState,
  rollBackCodingRouterGuidance,
  startCodingRouterOptimizerCycle,
  updateCodingOptimizerAutomation,
} from "@/lib/autoCodingRouterOptimizer";

/**
 * The coding router optimizer (lib/autoCodingRouterOptimizer.ts): a third
 * target in the shared cycle table, lock, caps and audit. No provider is
 * called here: a cycle that would be paid is refused before it starts.
 */

const VERIFIED_SUMMARY = verifiedOptimizerSummary();
const session = {
  user: { id: `coding-optimizer-${randomUUID()}`, email: "coding-optimizer@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;
const actor = { session, request: new Request("https://tomverse.test/api/admin/auto-llm-router/coding-optimizer") };
const CODING_PROPOSAL = "Send renames and commit messages to a standard candidate.\nSend failing-test debugging to a premium candidate.";
const SETTING_KEYS = [
  AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY,
  AUTO_LLM_ROUTER_REWRITE_GUIDANCE_SETTING_KEY,
  AUTO_LLM_ROUTER_CODING_GUIDANCE_SETTING_KEY,
  AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY,
  AUTO_REWRITE_OPTIMIZER_AUTOMATION_SETTING_KEY,
  AUTO_CODING_OPTIMIZER_AUTOMATION_SETTING_KEY,
  AUTO_ROUTER_OPTIMIZER_MODEL_SETTING_KEY,
  AUTO_LLM_ROUTER_MODEL_SETTING_KEY,
];

const reset = async () => {
  await prisma.autoRouterOptimizerCycle.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: SETTING_KEYS } } });
};
beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const seedCycle = (data: { target: "routing" | "rewrite" | "coding"; status: string; candidateGuidance?: string | null; incumbentGuidance?: string }) =>
  prisma.autoRouterOptimizerCycle.create({
    data: {
      optimizerModelId: "optimizer-model",
      routerModelId: "router-model",
      incumbentGuidance:
        data.incumbentGuidance ??
        (data.target === "coding"
          ? AUTO_LLM_ROUTER_CODING_GUIDANCE
          : data.target === "rewrite"
            ? AUTO_LLM_ROUTER_DEFAULT_REWRITE_GUIDANCE
            : AUTO_LLM_ROUTER_DEFAULT_GUIDANCE),
      candidateGuidance: data.candidateGuidance ?? null,
      reservedMicroUsd: 0,
      status: data.status,
      summary: VERIFIED_SUMMARY as Prisma.InputJsonValue,
      target: data.target,
    },
  });
const auditFor = (cycleId: string, action: string) => prisma.adminAuditLog.count({ where: { targetId: cycleId, action } });

test("a coding cycle is a third target in the shared table, lock and caps", async () => {
  const started = await reserveOptimizerCycle({
    actor,
    optimizerModelId: "optimizer-model",
    routerModelId: "router-model",
    incumbentGuidance: AUTO_LLM_ROUTER_CODING_GUIDANCE,
    target: "coding",
  });
  assert.ok("cycle" in started);
  assert.equal((await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: started.cycle.id } })).target, "coding");
  // One cycle of any kind at a time.
  assert.deepEqual(
    await reserveOptimizerCycle({ actor, optimizerModelId: "o", routerModelId: "r", incumbentGuidance: "x", target: "routing" }),
    { refused: "already_running" }
  );
  // The database refuses a target the code does not know.
  await assert.rejects(seedCycle({ target: "other" as "coding", status: "failed" }));
});

test("a coding promotion writes the coding guidance only, and each kind refuses the others' cycles", async () => {
  const coding = await seedCycle({ target: "coding", status: "passed", candidateGuidance: CODING_PROPOSAL });
  const rewrite = await seedCycle({ target: "rewrite", status: "passed", candidateGuidance: "Keep every number." });
  assert.deepEqual(await promoteAutoRouterOptimizerCycle(coding.id, actor), { refused: "not_found" });
  assert.deepEqual(await promoteAutoRewriteOptimizerCycle(coding.id, actor), { refused: "not_found" });
  assert.deepEqual(await promoteCodingRouterOptimizerCycle(rewrite.id, actor), { refused: "not_found" });
  assert.equal((await readActiveRouterGuidance(prisma, "coding")).guidance, AUTO_LLM_ROUTER_CODING_GUIDANCE, "the code default");

  assert.deepEqual(await promoteCodingRouterOptimizerCycle(coding.id, actor), { ok: true });
  const active = await readActiveRouterGuidance(prisma, "coding");
  assert.equal(active.guidance, CODING_PROPOSAL);
  assert.equal(active.cycleId, coding.id);
  assert.equal(await prisma.appSetting.count({ where: { key: AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY } }), 0, "Chat's guidance untouched");
  assert.equal(await auditFor(coding.id, "auto.llm_router_coding_guidance.promoted"), 1);
  assert.deepEqual(await promoteCodingRouterOptimizerCycle(coding.id, actor), { refused: "already_promoted" });

  const rival = await seedCycle({ target: "coding", status: "passed", candidateGuidance: `${CODING_PROPOSAL}\nKeep the model.` });
  assert.deepEqual(await promoteCodingRouterOptimizerCycle(rival.id, actor), { refused: "stale" });
});

test("an automatic coding promotion is the optimizer's system actor, and a rollback returns to the default", async () => {
  const cycle = await seedCycle({ target: "coding", status: "passed", candidateGuidance: CODING_PROPOSAL });
  assert.deepEqual(await promoteCodingRouterOptimizerCycle(cycle.id, "system"), { ok: true });
  const entry = await prisma.adminAuditLog.findFirstOrThrow({ where: { targetId: cycle.id, action: "auto.llm_router_coding_guidance.promoted" } });
  assert.equal(entry.actorUserId, null);
  assert.equal((entry.metadata as { systemActor?: string }).systemActor, "auto-router-optimizer");

  assert.deepEqual(await rollBackCodingRouterGuidance(actor), { ok: true });
  const active = await readActiveRouterGuidance(prisma, "coding");
  assert.equal(active.cycleId, null);
  assert.equal(active.guidance, AUTO_LLM_ROUTER_CODING_GUIDANCE);
  assert.equal(await prisma.appSetting.count({ where: { key: AUTO_LLM_ROUTER_CODING_GUIDANCE_SETTING_KEY } }), 0);
  assert.deepEqual(await rollBackCodingRouterGuidance(actor), { refused: "nothing_to_roll_back" });
});

test("the coding automation starts with its daily run on, is audited, and the daily run picks coding without spending", async () => {
  // Owner decision 2026-11-20: daily on, auto-promote off, with no row.
  assert.deepEqual(await readCodingOptimizerAutomation(), { daily: true, autoPromote: false });
  await updateCodingOptimizerAutomation(actor, { daily: false, autoPromote: false });
  assert.deepEqual(await readCodingOptimizerAutomation(), { daily: false, autoPromote: false }, "off is stored as a row");
  assert.equal(await prisma.appSetting.count({ where: { key: AUTO_CODING_OPTIMIZER_AUTOMATION_SETTING_KEY } }), 1);
  assert.deepEqual(await runScheduledOptimizerCycle(), { started: false, reason: "daily_off" });
  await updateCodingOptimizerAutomation(actor, { daily: true, autoPromote: false });
  assert.equal(await prisma.appSetting.count({ where: { key: AUTO_CODING_OPTIMIZER_AUTOMATION_SETTING_KEY } }), 0, "the default is no row");
  assert.equal(
    await prisma.adminAuditLog.count({ where: { action: "auto.llm_router_coding_optimizer_automation.updated" } }) >= 2,
    true
  );
  // A row that cannot be parsed never spends.
  await prisma.appSetting.create({ data: { key: AUTO_CODING_OPTIMIZER_AUTOMATION_SETTING_KEY, value: "{not json" } });
  assert.deepEqual(await readCodingOptimizerAutomation(), { daily: false, autoPromote: false });
  await prisma.appSetting.deleteMany({ where: { key: AUTO_CODING_OPTIMIZER_AUTOMATION_SETTING_KEY } });
  // No optimizer model is set, so the coding cycle is refused before any call.
  assert.deepEqual(await runScheduledOptimizerCycle(), { started: false, reason: "optimizer_off", target: "coding" });
  assert.deepEqual(await startCodingRouterOptimizerCycle(actor), { refused: "optimizer_off" });
  assert.equal(await prisma.autoRouterOptimizerCycle.count(), 0);

  const state = await readCodingRouterOptimizerState();
  assert.equal(state.automation.daily, true);
  assert.equal(state.active.guidance, AUTO_LLM_ROUTER_CODING_GUIDANCE);
  assert.ok(state.report.day && state.report.week, "the coding routing report reads the receipts");
  assert.deepEqual(state.cycles, []);
});
