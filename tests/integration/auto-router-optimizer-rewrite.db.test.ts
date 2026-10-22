import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import {
  AUTO_LLM_ROUTER_DEFAULT_GUIDANCE,
  AUTO_LLM_ROUTER_DEFAULT_REWRITE_GUIDANCE,
} from "@/lib/autoLlmRouterCore";
import {
  AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY,
  AUTO_LLM_ROUTER_REWRITE_GUIDANCE_SETTING_KEY,
  readActiveRouterGuidance,
} from "@/lib/autoLlmRouterGuidance";
import { AUTO_LLM_ROUTER_MODEL_SETTING_KEY, updateAutoLlmRouterModelId } from "@/lib/autoLlmRouterSettings";
import { autoLlmRouterModelAllowed } from "@/lib/autoLlmRouterCore";
import { getRuntimeModels } from "@/lib/modelRegistry";
import { PROVIDER_API_KEY_ENV_NAMES } from "@/lib/modelRegistryShared";
import {
  AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY,
  AUTO_ROUTER_OPTIMIZER_MODEL_SETTING_KEY,
  pricesOf,
  promoteAutoRouterOptimizerCycle,
  readAutoRouterOptimizerState,
  reserveOptimizerCycle,
  updateOptimizerAutomation,
  updateOptimizerModel,
} from "@/lib/autoRouterOptimizer";
import {
  AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD,
  optimizerProcessExitCode,
} from "@/lib/autoRouterOptimizerCore";
import {
  AUTO_REWRITE_OPTIMIZER_AUTOMATION_SETTING_KEY,
  loadRewriteDecisions,
  promoteAutoRewriteOptimizerCycle,
  readAutoRewriteOptimizerState,
  readRewriteOptimizerAutomation,
  rollBackAutoRewriteGuidance,
  runAutoRouterOptimizerCycleToCompletion,
  runScheduledOptimizerCycle,
  updateRewriteOptimizerAutomation,
} from "@/lib/autoRewriteOptimizer";

// The rewrite optimizer's money, promotion and audit steps on a real database
// (lib/autoRewriteOptimizer.ts). No model is called: the cycle's calls are
// covered by tests/autoRewriteOptimizerCore.test.mjs with injected fakes.
// Rewrite and routing cycles share one table, one running cycle at a time and
// the same caps, and each promotes only into its own guidance.

const session = {
  user: { id: `rewrite-optimizer-${randomUUID()}`, email: "rewrite-optimizer@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;
const actor = { session, request: new Request("https://tomverse.test/api/admin/auto-llm-router/rewrite-optimizer") };
const REWRITE_PROPOSAL =
  "Name the exact function, item or option a reference points to.\nKeep every number, name and constraint the user wrote.";
const ROUTING_PROPOSAL = "Send greetings and small talk to the lightest model.\nSend code and maths to a strong model.";

const SETTING_KEYS = [
  AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY,
  AUTO_LLM_ROUTER_REWRITE_GUIDANCE_SETTING_KEY,
  AUTO_ROUTER_OPTIMIZER_AUTOMATION_SETTING_KEY,
  AUTO_REWRITE_OPTIMIZER_AUTOMATION_SETTING_KEY,
  AUTO_ROUTER_OPTIMIZER_MODEL_SETTING_KEY,
  AUTO_LLM_ROUTER_MODEL_SETTING_KEY,
];
const createdUsers: string[] = [];

const reset = async () => {
  await prisma.autoRouterOptimizerCycle.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: SETTING_KEYS } } });
  if (createdUsers.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUsers.splice(0) } } });
  }
};
beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const reserve = (target: "routing" | "rewrite", by: typeof actor | "system" = actor, now?: Date) =>
  reserveOptimizerCycle({
    actor: by,
    optimizerModelId: "optimizer-model",
    routerModelId: "router-model",
    incumbentGuidance: target === "rewrite" ? AUTO_LLM_ROUTER_DEFAULT_REWRITE_GUIDANCE : AUTO_LLM_ROUTER_DEFAULT_GUIDANCE,
    target,
    now,
  });

const seedCycle = (data: {
  target: "routing" | "rewrite";
  status: string;
  candidateGuidance?: string | null;
  incumbentGuidance?: string;
  createdAt?: Date;
  spentMicroUsd?: number;
  startedBy?: string;
  cases?: object[];
}) =>
  prisma.autoRouterOptimizerCycle.create({
    data: {
      optimizerModelId: "optimizer-model",
      routerModelId: "router-model",
      incumbentGuidance:
        data.incumbentGuidance ??
        (data.target === "rewrite" ? AUTO_LLM_ROUTER_DEFAULT_REWRITE_GUIDANCE : AUTO_LLM_ROUTER_DEFAULT_GUIDANCE),
      candidateGuidance: data.candidateGuidance ?? null,
      reservedMicroUsd: 0,
      spentMicroUsd: data.spentMicroUsd ?? 0,
      status: data.status,
      target: data.target,
      startedBy: data.startedBy ?? "person",
      ...(data.cases ? { cases: data.cases } : {}),
      ...(data.createdAt ? { createdAt: data.createdAt } : {}),
    },
  });

const auditFor = (cycleId: string, action: string) =>
  prisma.adminAuditLog.count({ where: { targetId: cycleId, action } });

test("a rewrite cycle starts through the shared reservation, recording its target, and one cycle of either kind runs at a time", async () => {
  const rewrite = await reserve("rewrite");
  assert.ok("cycle" in rewrite);
  const row = await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: rewrite.cycle.id } });
  assert.equal(row.target, "rewrite");
  assert.equal(row.incumbentGuidance, AUTO_LLM_ROUTER_DEFAULT_REWRITE_GUIDANCE);
  const audit = await prisma.adminAuditLog.findFirstOrThrow({
    where: { targetId: rewrite.cycle.id, action: "auto.llm_router_optimizer.cycle_started" },
  });
  assert.equal((audit.metadata as { target?: string }).target, "rewrite");
  // Running: neither kind may start.
  assert.deepEqual(await reserve("routing"), { refused: "already_running" });
  assert.deepEqual(await reserve("rewrite"), { refused: "already_running" });
  // A cycle started without a target is a routing cycle, as every earlier one.
  await prisma.autoRouterOptimizerCycle.update({ where: { id: rewrite.cycle.id }, data: { status: "failed" } });
  const routing = await reserveOptimizerCycle({
    actor,
    optimizerModelId: "optimizer-model",
    routerModelId: "router-model",
    incumbentGuidance: AUTO_LLM_ROUTER_DEFAULT_GUIDANCE,
  });
  assert.ok("cycle" in routing);
  assert.equal((await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: routing.cycle.id } })).target, "routing");
});

test("the day cap and the system's one cycle a day count both kinds", async () => {
  const now = new Date("2026-10-20T12:00:00.000Z");
  await seedCycle({
    target: "rewrite",
    status: "passed",
    createdAt: new Date("2026-10-20T01:00:00.000Z"),
    spentMicroUsd: AUTO_ROUTER_OPTIMIZER_DAY_CAP_MICRO_USD,
  });
  assert.deepEqual(await reserve("routing", actor, now), { refused: "day_cap" });

  await prisma.autoRouterOptimizerCycle.deleteMany({});
  await seedCycle({ target: "routing", status: "failed", startedBy: "system" });
  assert.deepEqual(await reserve("rewrite", "system"), { refused: "daily_done" });
  // A person still may.
  assert.ok("cycle" in (await reserve("rewrite")));
});

test("the database refuses a target outside the closed list", async () => {
  await assert.rejects(
    prisma.$executeRaw`INSERT INTO "AutoRouterOptimizerCycle" ("id", "status", "optimizerModelId", "routerModelId", "incumbentGuidance", "reservedMicroUsd", "target") VALUES (${randomUUID()}, 'failed', 'm', 'r', 'g', 0, 'answers')`,
    /AutoRouterOptimizerCycle_target_check/
  );
});

test("a rewrite promotion writes the rewrite guidance only, and each kind refuses the other's cycle", async () => {
  const rewrite = await seedCycle({ target: "rewrite", status: "passed", candidateGuidance: REWRITE_PROPOSAL });
  const routing = await seedCycle({ target: "routing", status: "passed", candidateGuidance: ROUTING_PROPOSAL });

  // Neither promotion path accepts the other kind's cycle.
  assert.deepEqual(await promoteAutoRouterOptimizerCycle(rewrite.id, actor), { refused: "not_found" });
  assert.deepEqual(await promoteAutoRewriteOptimizerCycle(routing.id, actor), { refused: "not_found" });
  assert.equal(await prisma.appSetting.count({ where: { key: { in: SETTING_KEYS } } }), 0);

  assert.deepEqual(await promoteAutoRewriteOptimizerCycle(rewrite.id, actor), { ok: true });
  const active = await readActiveRouterGuidance(prisma, "rewrite");
  assert.equal(active.guidance, REWRITE_PROPOSAL);
  assert.equal(active.cycleId, rewrite.id);
  assert.deepEqual(active.history, [{ guidance: AUTO_LLM_ROUTER_DEFAULT_REWRITE_GUIDANCE, cycleId: null }]);
  // The routing guidance is untouched.
  assert.equal(await prisma.appSetting.count({ where: { key: AUTO_LLM_ROUTER_GUIDANCE_SETTING_KEY } }), 0);
  assert.equal((await readActiveRouterGuidance()).guidance, AUTO_LLM_ROUTER_DEFAULT_GUIDANCE);
  assert.equal(await auditFor(rewrite.id, "auto.llm_router_rewrite_guidance.promoted"), 1);
  assert.deepEqual(await promoteAutoRewriteOptimizerCycle(rewrite.id, actor), { refused: "already_promoted" });

  // A second rewrite cycle measured against the default is now stale.
  const rival = await seedCycle({ target: "rewrite", status: "passed", candidateGuidance: `${REWRITE_PROPOSAL}\nKeep the tone.` });
  assert.deepEqual(await promoteAutoRewriteOptimizerCycle(rival.id, actor), { refused: "stale" });
  const failed = await seedCycle({ target: "rewrite", status: "failed", candidateGuidance: REWRITE_PROPOSAL });
  assert.deepEqual(await promoteAutoRewriteOptimizerCycle(failed.id, actor), { refused: "not_passed" });
});

test("an automatic rewrite promotion is the optimizer's system actor", async () => {
  const cycle = await seedCycle({ target: "rewrite", status: "passed", candidateGuidance: REWRITE_PROPOSAL });
  assert.deepEqual(await promoteAutoRewriteOptimizerCycle(cycle.id, "system"), { ok: true });
  const entry = await prisma.adminAuditLog.findFirstOrThrow({
    where: { targetId: cycle.id, action: "auto.llm_router_rewrite_guidance.promoted" },
  });
  assert.equal(entry.actorUserId, null);
  assert.equal((entry.metadata as { systemActor?: string }).systemActor, "auto-router-optimizer");
});

test("a rewrite rollback returns one step to the default and is audited", async () => {
  assert.deepEqual(await rollBackAutoRewriteGuidance(actor), { refused: "nothing_to_roll_back" });
  const cycle = await seedCycle({ target: "rewrite", status: "passed", candidateGuidance: REWRITE_PROPOSAL });
  await promoteAutoRewriteOptimizerCycle(cycle.id, actor);
  assert.deepEqual(await rollBackAutoRewriteGuidance(actor), { ok: true });
  const active = await readActiveRouterGuidance(prisma, "rewrite");
  assert.equal(active.cycleId, null);
  assert.equal(active.guidance, AUTO_LLM_ROUTER_DEFAULT_REWRITE_GUIDANCE);
  assert.equal(await prisma.appSetting.count({ where: { key: AUTO_LLM_ROUTER_REWRITE_GUIDANCE_SETTING_KEY } }), 0);
  assert.equal(await auditFor(cycle.id, "auto.llm_router_rewrite_guidance.rolled_back"), 1);
});

test("the rewrite automation has its own switches, off by default, changed only with an audit entry", async () => {
  assert.deepEqual(await readRewriteOptimizerAutomation(), { daily: false, autoPromote: false });
  // Turning the routing automation on leaves the rewrite switches off.
  await updateOptimizerAutomation(actor, { daily: true, autoPromote: true });
  assert.deepEqual(await readRewriteOptimizerAutomation(), { daily: false, autoPromote: false });

  await updateRewriteOptimizerAutomation(actor, { daily: true, autoPromote: false });
  assert.deepEqual(await readRewriteOptimizerAutomation(), { daily: true, autoPromote: false });
  const entry = await prisma.adminAuditLog.findFirstOrThrow({
    where: {
      action: "auto.llm_router_rewrite_optimizer_automation.updated",
      targetId: AUTO_REWRITE_OPTIMIZER_AUTOMATION_SETTING_KEY,
    },
    orderBy: { createdAt: "desc" },
  });
  assert.deepEqual((entry.metadata as { after?: unknown }).after, { daily: true, autoPromote: false });
  assert.equal(entry.actorUserId, session.user?.id);
  await updateRewriteOptimizerAutomation(actor, { daily: false, autoPromote: false });
  assert.equal(await prisma.appSetting.count({ where: { key: AUTO_REWRITE_OPTIMIZER_AUTOMATION_SETTING_KEY } }), 0);
});

test("the daily step picks its target from the switches and starts nothing without an optimizer model", async () => {
  assert.deepEqual(await runScheduledOptimizerCycle(), { started: false, reason: "daily_off" });

  await updateRewriteOptimizerAutomation(actor, { daily: true, autoPromote: false });
  assert.deepEqual(await runScheduledOptimizerCycle(), { started: false, reason: "optimizer_off", target: "rewrite" });

  // Both on: they take turns after the last cycle the system started.
  await updateOptimizerAutomation(actor, { daily: true, autoPromote: false });
  assert.equal((await runScheduledOptimizerCycle()).target, "routing");
  await seedCycle({ target: "routing", status: "failed", startedBy: "system" });
  assert.equal((await runScheduledOptimizerCycle()).target, "rewrite");
  assert.equal(await prisma.autoRouterOptimizerCycle.count(), 1);
});

test("the own-process run follows the daily step's rule, and a refusal is nothing to wait for", async () => {
  // The Auto Router Optimizer service's entry (scripts/run-auto-router-optimizer.mjs).
  assert.deepEqual(await runAutoRouterOptimizerCycleToCompletion(), { started: false, reason: "daily_off" });
  await updateRewriteOptimizerAutomation(actor, { daily: true, autoPromote: false });
  const refused = await runAutoRouterOptimizerCycleToCompletion();
  assert.deepEqual(refused, { started: false, reason: "optimizer_off", target: "rewrite" });
  assert.equal(optimizerProcessExitCode(refused), 0);
  await updateOptimizerAutomation(actor, { daily: true, autoPromote: false });
  assert.deepEqual(await runAutoRouterOptimizerCycleToCompletion(), {
    started: false,
    reason: "optimizer_off",
    target: "routing",
  });
  assert.equal(await prisma.autoRouterOptimizerCycle.count(), 0);
});

test("the own-process run returns only when its cycle is recorded, with how it ended", async () => {
  // No provider is reached: every key is unset and fetch throws, so each call
  // fails before it leaves. With no real decision and no synthetic message the
  // cycle ends as too few cases -- recorded, at no cost.
  const models = await getRuntimeModels();
  const model = models.find(
    (candidate) =>
      candidate.enabled &&
      (candidate.provider === "openai" || candidate.provider === "anthropic") &&
      autoLlmRouterModelAllowed(candidate) &&
      pricesOf(candidate)
  );
  assert.ok(model, "the catalogue has a priced OpenAI or Anthropic model");
  await updateOptimizerModel(actor, model.id);
  await updateAutoLlmRouterModelId(actor, model.id);
  await updateOptimizerAutomation(actor, { daily: true, autoPromote: false });

  const keys = Object.values(PROVIDER_API_KEY_ENV_NAMES).flat();
  const saved = Object.fromEntries(keys.map((name) => [name, process.env[name]]));
  const realFetch = globalThis.fetch;
  let fetched = 0;
  globalThis.fetch = (async () => {
    fetched += 1;
    throw new Error("no network in this test");
  }) as typeof fetch;
  for (const name of keys) delete process.env[name];
  try {
    const result = await runAutoRouterOptimizerCycleToCompletion();
    assert.equal(result.started, true);
    assert.ok(result.started);
    assert.equal(result.target, "routing");
    assert.deepEqual(result.outcome, { recorded: true, status: "failed", failure: "too_few_cases" });
    assert.equal(optimizerProcessExitCode(result), 0);
    // Returned after the row was closed, not while it was still running.
    const row = await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id: result.cycleId } });
    assert.equal(row.status, "failed");
    assert.equal(row.failure, "too_few_cases");
    assert.equal(row.startedBy, "system");
    assert.equal(row.spentMicroUsd, 0);
    assert.ok(row.finishedAt);
    assert.equal(fetched, 0);
  } finally {
    globalThis.fetch = realFetch;
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("each Admin section lists only its own cycles; rewrite synthetic cases are shown and real ones never", async () => {
  const realDecisionId = `real-${randomUUID()}`;
  const rewrite = await seedCycle({
    target: "rewrite",
    status: "failed",
    cases: [
      { decisionId: realDecisionId, incumbentPick: "strong", candidatePick: "strong", verdict: "candidate" },
      {
        decisionId: "synthetic-1",
        source: "synthetic",
        message: "그거 영어로 바꿔 줘",
        previousAnswer: "안녕하세요",
        incumbentRewrite: null,
        candidateRewrite: "\"안녕하세요\"를 영어로 번역해 줘.",
        incumbentPick: "light",
        candidatePick: "light",
        verdict: "candidate",
      },
    ],
  });
  const routing = await seedCycle({ target: "routing", status: "failed" });

  const rewriteState = await readAutoRewriteOptimizerState();
  assert.deepEqual(rewriteState.cycles.map((cycle) => cycle.id), [rewrite.id]);
  assert.deepEqual(rewriteState.cycles[0].syntheticCases, [{
    message: "그거 영어로 바꿔 줘",
    previousAnswer: "안녕하세요",
    incumbentRewrite: null,
    candidateRewrite: "\"안녕하세요\"를 영어로 번역해 줘.",
    answerModelId: "light",
    verdict: "candidate",
  }]);
  assert.equal(JSON.stringify(rewriteState).includes(realDecisionId), false);
  assert.equal(rewriteState.active.guidance, AUTO_LLM_ROUTER_DEFAULT_REWRITE_GUIDANCE);
  assert.equal(rewriteState.listedCycles, 10);

  const routingState = await readAutoRouterOptimizerState();
  assert.deepEqual(routingState.cycles.map((cycle) => cycle.id), [routing.id]);
});

test("only follow-ups the live router was asked to rewrite are sampled", async () => {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test`, name: "Rewrite Sample" } });
  createdUsers.push(user.id);
  const conversation = await prisma.conversation.create({
    data: { selectedModels: '["gpt-6-luna"]', userId: user.id, title: "Sample", kind: "chat" },
  });
  const candidates = [
    { id: "light", name: "Light", provider: "p", bestFor: "chat", tier: "standard", credits: 1 },
    { id: "strong", name: "Strong", provider: "p", bestFor: "code", tier: "advanced", credits: 5 },
  ];
  const decision = (overrides: { version: string; routerInput?: string; routerContext?: string | null; outcome?: string }) =>
    prisma.autoRouterDecision.create({
      data: {
        version: overrides.version,
        traceId: randomUUID(),
        userId: user.id,
        conversationId: conversation.id,
        routerInput: overrides.routerInput ?? "fix that",
        routerContext: overrides.routerContext === undefined ? "def f(): pass" : overrides.routerContext,
        candidates,
        taskKind: "coding",
        ruleModelId: "light",
        routerModelId: "router-model",
        pickedModelId: "strong",
        outcome: overrides.outcome ?? "picked",
        latencyMs: 10,
      },
    });
  const kept = await decision({ version: "auto-llm-router-v1+rewrite" });
  const keptPromoted = await decision({ version: "auto-llm-router-v1+c1+rewrite+r1" });
  await decision({ version: "auto-llm-router-v1" }); // rewriting off: attachments unknown
  await decision({ version: "auto-llm-router-v1+rewrite", routerContext: null }); // not a follow-up
  await decision({ version: "auto-llm-router-v1+rewrite", outcome: "error" });
  await decision({ version: "auto-llm-router-v1+rewrite", routerInput: "x".repeat(1_501) });

  const sampled = await loadRewriteDecisions();
  assert.deepEqual(sampled.map((item) => item.id).sort(), [kept.id, keptPromoted.id].sort());
  assert.ok(sampled.every((item) => item.routerContext === "def f(): pass" && item.pickedModelId === "strong"));
});
