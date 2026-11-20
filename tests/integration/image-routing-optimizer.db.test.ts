import { Prisma } from "@prisma/client";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { CHAT_IMAGE_ROUTING_CRITERIA } from "@/lib/chatImageIntentCore";
import { AUTO_LLM_ROUTER_IMAGE_GUIDANCE_SETTING_KEY, readActiveRouterGuidance } from "@/lib/autoLlmRouterGuidance";
import { AUTO_CODING_OPTIMIZER_AUTOMATION_SETTING_KEY } from "@/lib/autoCodingRouterOptimizer";
import { reserveOptimizerCycle, promoteAutoRouterOptimizerCycle } from "@/lib/autoRouterOptimizer";
import { runScheduledOptimizerCycle } from "@/lib/autoRewriteOptimizer";
import {
  AUTO_IMAGE_OPTIMIZER_AUTOMATION_SETTING_KEY,
  promoteImageRoutingOptimizerCycle,
  readImageOptimizerAutomation,
  readImageRoutingOptimizerState,
  rollBackImageRoutingGuidance,
  updateImageOptimizerAutomation,
} from "@/lib/imageRoutingOptimizer";
import { linkImageRoutingDecision, recordImageRoutingDecision } from "@/lib/imageRoutingDecisions";

/**
 * The image routing improvement agent's records and its optimizer target on
 * the shared cycle table, lock and audit. No provider is called.
 */

const session = {
  user: { id: `image-optimizer-${randomUUID()}`, email: "image-optimizer@example.test" },
  expires: new Date(Date.now() + 3_600_000).toISOString(),
} as Session;
const actor = { session, request: new Request("https://tomverse.test/api/admin/auto-llm-router/image-optimizer") };
const PROPOSAL = `${CHAT_IMAGE_ROUTING_CRITERIA}\n- prefer the model whose note names legible text for posters.`;
const KEYS = [AUTO_LLM_ROUTER_IMAGE_GUIDANCE_SETTING_KEY, AUTO_IMAGE_OPTIMIZER_AUTOMATION_SETTING_KEY, AUTO_CODING_OPTIMIZER_AUTOMATION_SETTING_KEY];
const users: string[] = [];

const reset = async () => {
  await prisma.autoRouterOptimizerCycle.deleteMany({});
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } });
};
beforeEach(reset);
after(async () => {
  await reset();
  if (users.length) await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});

const seedCycle = (data: { status: string; candidateGuidance?: string | null; summary?: object; incumbentGuidance?: string }) =>
  prisma.autoRouterOptimizerCycle.create({
    data: {
      optimizerModelId: "optimizer-model",
      routerModelId: "router-model",
      incumbentGuidance: data.incumbentGuidance ?? CHAT_IMAGE_ROUTING_CRITERIA,
      candidateGuidance: data.candidateGuidance ?? null,
      reservedMicroUsd: 0,
      status: data.status,
      summary: (data.summary ?? { costComplete: true }) as Prisma.InputJsonValue,
      target: "image",
    },
  });

test("an image cycle is a target of the shared table and lock", async () => {
  const started = await reserveOptimizerCycle({ actor, optimizerModelId: "o", routerModelId: "r", incumbentGuidance: CHAT_IMAGE_ROUTING_CRITERIA, target: "image" });
  assert.ok("cycle" in started);
  assert.deepEqual(
    await reserveOptimizerCycle({ actor, optimizerModelId: "o", routerModelId: "r", incumbentGuidance: "x", target: "coding" }),
    { refused: "already_running" }
  );
});

test("an image promotion writes the image criteria only, with every cost known, and is audited", async () => {
  const unconfirmed = await seedCycle({ status: "passed", candidateGuidance: PROPOSAL, summary: { costComplete: false } });
  assert.deepEqual(await promoteImageRoutingOptimizerCycle(unconfirmed.id, actor), { refused: "not_passed" });
  const cycle = await seedCycle({ status: "passed", candidateGuidance: PROPOSAL });
  assert.deepEqual(await promoteAutoRouterOptimizerCycle(cycle.id, actor), { refused: "not_found" }, "the Chat path refuses it");
  assert.deepEqual(await promoteImageRoutingOptimizerCycle(cycle.id, actor), { ok: true });
  const active = await readActiveRouterGuidance(prisma, "image");
  assert.equal(active.guidance, PROPOSAL);
  assert.equal(active.cycleId, cycle.id);
  assert.equal(await prisma.adminAuditLog.count({ where: { targetId: cycle.id, action: "auto.llm_router_image_guidance.promoted" } }), 1);
  const rival = await seedCycle({ status: "passed", candidateGuidance: `${PROPOSAL}\n- one more.` });
  assert.deepEqual(await promoteImageRoutingOptimizerCycle(rival.id, actor), { refused: "stale" });

  assert.deepEqual(await rollBackImageRoutingGuidance(actor), { ok: true });
  assert.equal((await readActiveRouterGuidance(prisma, "image")).guidance, CHAT_IMAGE_ROUTING_CRITERIA);
  assert.deepEqual(await rollBackImageRoutingGuidance(actor), { refused: "nothing_to_roll_back" });

  const system = await seedCycle({ status: "passed", candidateGuidance: PROPOSAL });
  assert.deepEqual(await promoteImageRoutingOptimizerCycle(system.id, "system"), { ok: true });
  const entry = await prisma.adminAuditLog.findFirstOrThrow({ where: { targetId: system.id, action: "auto.llm_router_image_guidance.promoted" } });
  assert.equal((entry.metadata as { systemActor?: string }).systemActor, "auto-router-optimizer");
});

test("the image automation starts all off; a malformed row spends nothing", async () => {
  assert.deepEqual(await readImageOptimizerAutomation(), { daily: false, autoPromote: false, modelEval: false });
  await updateImageOptimizerAutomation(actor, { daily: true, autoPromote: false, modelEval: true });
  assert.deepEqual(await readImageOptimizerAutomation(), { daily: true, autoPromote: false, modelEval: true });
  await updateImageOptimizerAutomation(actor, { daily: false, autoPromote: false, modelEval: false });
  assert.equal(await prisma.appSetting.count({ where: { key: AUTO_IMAGE_OPTIMIZER_AUTOMATION_SETTING_KEY } }), 0, "the default is no row");
  for (const value of ["{bad", '{"daily":true,"autoPromote":false}', '{"daily":true,"autoPromote":false,"modelEval":"yes"}']) {
    await prisma.appSetting.create({ data: { key: AUTO_IMAGE_OPTIMIZER_AUTOMATION_SETTING_KEY, value } });
    assert.deepEqual(await readImageOptimizerAutomation(), { daily: false, autoPromote: false, modelEval: false }, value);
    await prisma.appSetting.deleteMany({ where: { key: AUTO_IMAGE_OPTIMIZER_AUTOMATION_SETTING_KEY } });
  }
  // Switched on with coding off, the daily run picks image, and without an optimizer model it spends nothing.
  await updateImageOptimizerAutomation(actor, { daily: true, autoPromote: false, modelEval: false });
  await prisma.appSetting.create({ data: { key: AUTO_CODING_OPTIMIZER_AUTOMATION_SETTING_KEY, value: JSON.stringify({ daily: false, autoPromote: false }) } });
  assert.deepEqual(await runScheduledOptimizerCycle(), { started: false, reason: "optimizer_off", target: "image" });
  assert.equal(await prisma.autoRouterOptimizerCycle.count(), 0);
  const state = await readImageRoutingOptimizerState();
  assert.equal(state.active.guidance, CHAT_IMAGE_ROUTING_CRITERIA);
  assert.ok(state.report.day && state.report.week);
});

test("a routing decision is recorded content-free and linked only to its owner's group, once", async () => {
  const user = await prisma.user.create({ data: { email: `${randomUUID()}@example.test` } });
  const other = await prisma.user.create({ data: { email: `${randomUUID()}@example.test` } });
  users.push(user.id, other.id);
  const conversation = await prisma.conversation.create({ data: { userId: user.id, title: "Images", selectedModels: "[]", kind: "chat" } });
  const decisionId = await recordImageRoutingDecision({
    userId: user.id,
    conversationId: conversation.id,
    source: "auto_chat",
    routerModelId: "gpt-6-luna",
    decision: { image: true, modelId: "gpt-image-2", preset: null, prompt: null, edit: false },
    outcome: "image",
    followUp: false,
    attachedPhoto: false,
    candidateCount: 5,
    latencyMs: 900,
  });
  assert.ok(decisionId);
  const row = await prisma.imageRoutingDecision.findUniqueOrThrow({ where: { id: decisionId } });
  assert.equal(row.modelFallback, true, "no preset named: the default preset answers");
  const group = await prisma.imageGenerationGroup.create({ data: { userId: user.id, conversationId: conversation.id, groupIdempotencyKey: randomUUID() } });
  await linkImageRoutingDecision({ decisionId, userId: other.id, groupId: group.id });
  assert.equal((await prisma.imageRoutingDecision.findUniqueOrThrow({ where: { id: decisionId } })).groupId, null, "another person's group never links");
  await linkImageRoutingDecision({ decisionId, userId: user.id, groupId: group.id });
  assert.equal((await prisma.imageRoutingDecision.findUniqueOrThrow({ where: { id: decisionId } })).groupId, group.id);
  // Deleting the conversation keeps the record without the link; a gone conversation is not a lost decision.
  await prisma.imageGenerationGroup.deleteMany({ where: { id: group.id } });
  await prisma.conversation.delete({ where: { id: conversation.id } });
  assert.equal((await prisma.imageRoutingDecision.findUniqueOrThrow({ where: { id: decisionId } })).conversationId, null);
  const orphan = await recordImageRoutingDecision({
    userId: user.id,
    conversationId: conversation.id,
    source: "composer",
    routerModelId: "gpt-6-luna",
    decision: { image: false },
    outcome: "chat",
    followUp: false,
    attachedPhoto: false,
    candidateCount: 5,
    latencyMs: null,
  });
  assert.ok(orphan, "recorded without the conversation that is gone");
  assert.equal((await prisma.imageRoutingDecision.findUniqueOrThrow({ where: { id: orphan } })).conversationId, null);
  // Deleting the person deletes the record.
  await prisma.user.delete({ where: { id: user.id } });
  assert.equal(await prisma.imageRoutingDecision.count({ where: { id: decisionId } }), 0);
});
