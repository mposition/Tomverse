import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
const v2 = "prompt-refiner-vnext-one-shot-v2";
const v3 = "prompt-refiner-vnext-one-shot-v3";
const binding = {
  id: v3, sourceCommitSha: "a".repeat(40),
  sourceManifestDigest: "b".repeat(64), runnerDigest: "c".repeat(64),
  manifestRoot: "d".repeat(64),
  runtimeDeploymentId: "33333333-3333-4333-8333-333333333333",
  runtimeCommitSha: "3".repeat(40), pricePinDigest: "e".repeat(64),
  perRequestCostMicroUsd: 29918n, slotCount: 80,
  costCeilingMicroUsd: 2393440n,
};
const previous = { ...binding, id: v2,
  runtimeDeploymentId: "3565f671-c168-4d3d-8573-8e79126e1c63",
  runtimeCommitSha: "291e6d07f284e6333c34a3061dd94da77752aad9",
  stageApprovalAuditLogId: "cmuuyx04a001d02qt3ald6khq",
  runApprovalAuditLogId: "cmuuz1ltu002002qtnct9lojp",
  approvedBy: "synthetic-owner",
};
let shadowPresent = false;
let forbiddenAudits = 0;
let preregValid = true;
let preregReads = 0;
let closed = 0;
let created = null;
let slots = null;
let supersession = null;
const tx = {
  $queryRaw: async () => [{ id: v2 }],
  adminAuditLog: { count: async () => forbiddenAudits },
  promptRefinerVnextOneShotStage: {
    findUnique: async () => previous,
    updateMany: async () => { closed++; return { count: 1 }; },
    create: async ({ data }) => { created = data; return data; },
  },
  promptRefinerVnextOneShotSlot: {
    findMany: async () => Array.from({ length: 80 }, (_, slotIndex) => ({
      id: `one-shot-v2-${slotIndex}`, slotIndex,
    })),
    createMany: async ({ data }) => { slots = data; return { count: data.length }; },
  },
};
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  writeAdminAuditLog: async (input) => { supersession = input; return "v2-close-audit"; },
} });
mock.module(mod("lib/prisma.ts"), { namedExports: {
  prisma: { $transaction: async (work) => work(tx) },
} });
mock.module(mod("lib/promptRefinerVnextOneShotStageApprovalAudit.ts"), {
  namedExports: { writePromptRefinerVnextOneShotStageApprovalAudit: async () => ({
    auditLogId: "v3-stage-audit", approvedBy: "synthetic-owner",
  }) },
});
mock.module(mod("lib/promptRefinerQualityEvaluationVnextOneShotPriceReadback.ts"), {
  namedExports: { readPromptRefinerVnextOneShotPrice: async () => ({
    pricePinMatchesRegistry: true, problems: [],
  }) },
});
mock.module(mod("lib/promptRefinerVnextOneShotPriceBinding.ts"), {
  namedExports: { PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST: binding.pricePinDigest },
});
mock.module(mod("lib/promptRefinerVnextOneShotStageReadback.ts"), {
  namedExports: { readPromptRefinerVnextOneShotStage: async (_tx, id) =>
    id === v2 ? {
      stageStatus: "run_approved", reservationShapeValid: true,
      approvalAuditsValid: true, reservedSlots: 80, consumedSlots: 0,
    } : {
      stagePresent: true, stageStatus: "closed", approvalAuditsValid: true,
      reservedSlots: 80, consumedSlots: 0,
    } },
});
mock.module(mod("lib/promptRefinerVnextOneShotOperationalShadow.ts"), {
  namedExports: { readPromptRefinerVnextOneShotOperationalShadow: async () => ({
    present: shadowPresent,
  }) },
});
mock.module(mod("lib/promptRefinerVnextOneShotPreregistration.ts"), {
  namedExports: { assertPromptRefinerVnextOneShotPreregistrationForStage:
    async () => {
      preregReads++;
      if (!preregValid) throw new Error("vnext_one_shot_preregistration_unavailable");
    } },
});
const { createPromptRefinerVnextOneShotStageWithSlots } = await import(
  mod("lib/promptRefinerVnextOneShotStageWriter.ts"));
const input = { session: { user: { id: "synthetic-owner" } },
  request: new Request("https://example.test/stage", { method: "POST" }), binding };
const reset = () => { closed = 0; created = null; slots = null; supersession = null;
  shadowPresent = false; forbiddenAudits = 0; preregValid = true;
  preregReads = 0; };

test("v3 recovery binds the prior run audit and reserves 80 new slots", async () => {
  reset();
  const result = await createPromptRefinerVnextOneShotStageWithSlots(input);
  assert.equal(result.stageId, v3);
  assert.equal(result.dispatchAuthorized, false);
  assert.equal(preregReads, 1);
  assert.equal(closed, 1);
  assert.equal(created.id, v3);
  assert.equal(created.sourceCommitSha, previous.sourceCommitSha);
  assert.equal(created.manifestRoot, previous.manifestRoot);
  assert.equal(slots.length, 80);
  assert.equal(new Set(slots.map((slot) => slot.slotIndex)).size, 80);
  assert(slots.every((slot) => slot.stageId === v3 &&
    slot.id.startsWith("one-shot-v3-") && slot.reservedCostMicroUsd === 29918n));
  assert.equal(supersession.metadata.previousRunApprovalAuditLogId,
    previous.runApprovalAuditLogId);
});

test("v3 recovery refuses without the original signed B01 preregistration", async () => {
  reset(); preregValid = false;
  await assert.rejects(createPromptRefinerVnextOneShotStageWithSlots(input),
    /preregistration_unavailable/);
  assert.equal(closed, 0); assert.equal(created, null); assert.equal(slots, null);
});

test("historical shadow or unknown evidence refuses before close and new slots", async () => {
  reset(); shadowPresent = true;
  await assert.rejects(createPromptRefinerVnextOneShotStageWithSlots(input),
    /legacy_stage_not_replaceable/);
  assert.equal(closed, 0); assert.equal(created, null); assert.equal(slots, null);
  reset(); forbiddenAudits = 1;
  await assert.rejects(createPromptRefinerVnextOneShotStageWithSlots(input),
    /legacy_stage_not_replaceable/);
  assert.equal(closed, 0); assert.equal(created, null); assert.equal(slots, null);
});
