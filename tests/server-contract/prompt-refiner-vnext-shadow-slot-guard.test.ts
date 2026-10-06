import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
let stageId = "prompt-refiner-vnext-one-shot-v4";
const requestId = "11111111-1111-4111-8111-111111111111";
const input = { requestId, slotIndex: 0,
  runApprovalAuditLogId: "synthetic-run-audit" };
let shadowValid = false;
let paidValid = false;
let shadowReads = 0;
let auditWrites = 0;
let slotWrites = 0;

const tx = {
  promptRefinerVnextOneShotStage: { findUnique: async ({ where }: {
    where: { id: string } }) => where.id === stageId ? ({
    id: stageId, status: "run_approved",
    runApprovalAuditLogId: input.runApprovalAuditLogId,
    manifestRoot: "a".repeat(64), runnerDigest: "b".repeat(64),
    perRequestCostMicroUsd: BigInt(29_918), costCeilingMicroUsd: BigInt(2_393_440),
    slotCount: 80,
  }) : null },
  promptRefinerVnextOneShotSlot: {
    findUnique: async () => ({ id: "synthetic-slot-0", status: "reserved",
      requestId: null, consumedAt: null, reservedCostMicroUsd: BigInt(29_918) }),
    updateMany: async () => { slotWrites++; return { count: 1 }; },
  },
};
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  takeAuditChainLock: async () => {},
  writeSystemAuditLog: async () => { auditWrites++; return "synthetic-slot-audit"; },
} });
mock.module(mod("lib/adminAuditIntegrityCore.ts"), { namedExports: {
  adminAuditIntegrityKeys: () => ["synthetic-integrity-key"],
} });
mock.module(mod("lib/promptRefinerVnextOneShotCandidateSourceReadback.ts"), {
  namedExports: { readPromptRefinerVnextOneShotCandidateSource: async () => {} },
});
mock.module(mod("lib/promptRefinerVnextOneShotPriceGuard.ts"), {
  namedExports: { assertPromptRefinerVnextOneShotCurrentPrice: async () => {} },
});
mock.module(mod("lib/promptRefinerVnextOneShotStageReadback.ts"), {
  namedExports: { lockAndReadPromptRefinerVnextOneShotStage: async () => ({
    stagePresent: true, stageStatus: "run_approved", slotCount: 80,
    reservedSlots: 80, consumedSlots: 0,
    reservationShapeValid: true, approvalAuditsValid: true,
  }) },
});
mock.module(mod("lib/promptRefinerVnextOneShotOperationalShadow.ts"), {
  namedExports: { readPromptRefinerVnextOneShotOperationalShadow: async () => {
    shadowReads++;
    return { present: shadowValid, valid: shadowValid,
      shadowAuditLogId: shadowValid ? "synthetic-shadow-audit" : null,
      dispatchAuthorized: false };
  } },
});
mock.module(mod("lib/promptRefinerVnextOneShotPaidAuthorization.ts"), {
  namedExports: { readPromptRefinerVnextOneShotPaidAuthorization: async () => ({
    present: paidValid, valid: paidValid,
    auditLogId: paidValid ? "synthetic-paid-audit" : null,
  }) },
});
mock.module(mod("lib/prisma.ts"), { namedExports: {
  prisma: { $transaction: async (work: (tx: object) => Promise<unknown>) => work(tx) },
} });
mock.module(mod("lib/promptRefinerVnextOneShotTerminalReceipt.ts"), {
  namedExports: { assertPromptRefinerVnextOneShotTerminalsComplete: async () => {} },
});
test("dispatch refuses absent shadow before any slot or audit write", async () => {
  const { consumePromptRefinerVnextOneShotSlot } = await import(
    mod("lib/promptRefinerVnextOneShotSlotConsumption.ts"));
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT = "a".repeat(64);
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST = "b".repeat(64);
  shadowValid = false;
  await assert.rejects(consumePromptRefinerVnextOneShotSlot(input),
    /vnext_one_shot_shadow_evidence_unavailable/);
  assert.equal(shadowReads, 1);
  assert.equal(auditWrites, 0);
  assert.equal(slotWrites, 0);
  shadowValid = true;
  paidValid = false;
  await assert.rejects(consumePromptRefinerVnextOneShotSlot(input),
    /vnext_one_shot_paid_authorization_unavailable/);
  assert.equal(auditWrites, 0);
  assert.equal(slotWrites, 0);
  paidValid = true;
  const result = await consumePromptRefinerVnextOneShotSlot(input);
  assert.equal(result.slotConsumptionAuditLogId, "synthetic-slot-audit");
  assert.equal(auditWrites, 1);
  assert.equal(slotWrites, 1);
});

test("closed legacy reservations cannot be consumed for the replacement run", async () => {
  const { consumePromptRefinerVnextOneShotSlot } = await import(
    mod("lib/promptRefinerVnextOneShotSlotConsumption.ts"));
  stageId = "prompt-refiner-vnext-one-shot-v1";
  shadowValid = true;
  const priorAudits = auditWrites;
  const priorSlots = slotWrites;
  await assert.rejects(consumePromptRefinerVnextOneShotSlot(input),
    /vnext_one_shot_slot_binding_mismatch/);
  assert.equal(auditWrites, priorAudits);
  assert.equal(slotWrites, priorSlots);
});

test("both enabled switches and valid runner request still refuse only missing paid audit", async () => {
  stageId = "prompt-refiner-vnext-one-shot-v4";
  shadowValid = true;
  paidValid = false;
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_SLOT_CONSUME_ENABLED = "1";
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_DISPATCH_ENABLED = "1";
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_API_TOKEN = "t".repeat(40);
  const route = await import(mod("app/api/internal/prompt-refiner/vnext-one-shot-slot/route.ts"));
  const request = () => new Request("https://example.test/api/internal/prompt-refiner/vnext-one-shot-slot", {
    method: "POST",
    headers: { authorization: `Bearer ${"t".repeat(40)}`,
      "content-type": "application/json" },
    body: JSON.stringify({ ...input, manifestRoot: "a".repeat(64),
      runnerDigest: "b".repeat(64) }),
  });
  const priorAudits = auditWrites;
  const priorSlots = slotWrites;
  const refused = await route.POST(request());
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "SLOT_CONSUMPTION_REFUSED");
  assert.equal(auditWrites, priorAudits);
  assert.equal(slotWrites, priorSlots);
  paidValid = true;
  const admitted = await route.POST(request());
  assert.equal(admitted.status, 201);
  assert.equal(auditWrites, priorAudits + 1);
  assert.equal(slotWrites, priorSlots + 1);
});
