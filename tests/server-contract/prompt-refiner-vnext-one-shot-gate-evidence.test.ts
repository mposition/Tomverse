import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { Session } from "next-auth";
import { promptRefinerVnextOneShotGatePublicKeyDigest,
  promptRefinerVnextOneShotSlotBindingDigest } from
  "../../lib/promptRefinerVnextOneShotGateAttestation";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const stageId = "prompt-refiner-vnext-one-shot-v4";
const v5StageId = "prompt-refiner-vnext-one-shot-v5";
const target = { stageApprovalAuditLogId: "synthetic-stage-audit",
  runApprovalAuditLogId: "synthetic-run-audit",
  shadowAuditLogId: "synthetic-shadow-audit",
  runtimeDeploymentId: "11111111-1111-4111-8111-111111111111" };
const baseStage = { id: stageId, status: "run_approved",
  approvedBy: "synthetic-owner", ...target,
  sourceCommitSha: "a".repeat(40), sourceManifestDigest: "b".repeat(64),
  runnerDigest: "c".repeat(64), manifestRoot: "d".repeat(64),
  runtimeCommitSha: "e".repeat(40), pricePinDigest: "f".repeat(64),
  perRequestCostMicroUsd: BigInt(29_918), costCeilingMicroUsd: BigInt(2_393_440),
  slotCount: 80 };
const cell = { general_rewrite: 8, injection_framing: 4, quoted_literal: 4,
  code_json_literal: 4, constraint_negation: 4, range_number: 4,
  forbidden_or_safety_addition: 4, safety_abstain_direct: 4,
  safety_abstain_indirect: 4 };
const challenge = { boundary_near_miss: 4, adversarial_variant: 4,
  mixed_language: 4, constrained_format: 4 };
const summary = { version: "prompt-refiner-vnext-one-shot-gate-v1",
  outcomes: { suggested: 64, abstained: 16, failed: 0, unknown: 0,
    not_dispatched: 0 },
  successfulCells: { ko: cell, en: cell },
  successfulChallenges: { ko: challenge, en: challenge },
  directionIssues: { wrong_direction_suggestion: 0,
    wrong_direction_abstention: 0, reason_mismatch: 0 },
  criticalViolations: { quoted_or_code_literal_corruption: 0,
    constraint_fabrication_or_loss: 0, injection_instruction_promoted: 0,
    unsafe_content_added: 0 },
  toolCallCount: 0, providerRetryCount: 0,
  cost: { completeUsageCount: 80, heldReservationCount: 0,
    knownCostMicroUsd: 80, heldReservationMicroUsd: 0,
    maximumRequestCostMicroUsd: 1, observedOverCapCount: 0 },
  latency: { terminalObservedCount: 80, p90Ms: 100, maximumMs: 100 },
  audit: { fixedReviewed: 4, fixedClear: 4, exceptionRequired: 0,
    exceptionReviewed: 0, exceptionClear: 0, overflowCandidates: 0,
    unresolvedSuspicions: 0, confirmedCriticalViolations: 0 } };

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicB64 = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const privateB64 = privateKey.export({ format: "der", type: "pkcs8" }).toString("base64");
let stage = { ...baseStage };
let snapshot = { stagePresent: true, stageStatus: "run_approved", slotCount: 80,
  reservedSlots: 0, consumedSlots: 80, reservationShapeValid: true,
  approvalAuditsValid: true };
let rows: Array<Record<string, unknown>> = [];
let shadowValid = true;
let shadowReadError = false;
let receiptValid = true;
let terminalReadback = {
  valid: true, terminalReceipts: 80, unknownReceipts: 0,
  consumedWithoutReceipt: 0, reservedSlots: 0, observedCostMicroUsd: 80,
  slots: Array.from({ length: 80 }, (_, index) => ({
    state: "terminal", resultKind: index < 64 ? "suggested" : "abstained",
  })),
};
let writes = 0;
const stageReadIds: string[] = [];
const candidateStageIds: string[] = [];
const slotRows = Array.from({ length: 80 }, (_, slotIndex) => ({
  id: `slot-${slotIndex}`, slotIndex,
  requestId: `11111111-1111-4111-8111-${String(slotIndex).padStart(12, "0")}`,
  status: "consumed",
}));
const consumedAudits = slotRows.map((slot) => ({
  id: `slot-audit-${slot.slotIndex}`,
  targetId: slot.id,
  createdAt: new Date("2026-10-05T00:00:01.000Z"),
  metadata: { requestId: slot.requestId, slotIndex: slot.slotIndex,
    runApprovalAuditLogId: target.runApprovalAuditLogId,
    reservedCostMicroUsd: 29_918,
    cumulativeReservedCostMicroUsd: (slot.slotIndex + 1) * 29_918,
    systemActor: "prompt-refiner-vnext-one-shot-runner" },
}));
const tx = {
  adminAuditLog: {
    findMany: async ({ where }: { where: { action: string } }) =>
      where.action === "prompt_refiner.vnext_one_shot.slot_consumed"
        ? consumedAudits : rows.filter((row) => row.action === where.action),
    findUnique: async ({ where }: { where: { id: string } }) =>
      where.id === target.shadowAuditLogId
        ? { createdAt: new Date("2026-10-05T00:00:00.000Z") } : null,
  },
  promptRefinerVnextOneShotStage: { findUnique: async ({ where }: {
    where: { id: string } }) => where.id === stage.id ? stage : null },
  promptRefinerVnextOneShotSlot: { findMany: async () => slotRows },
};

mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  takeAuditChainLock: async () => {},
  writeAdminAuditLog: async (input: Record<string, unknown>) => {
    writes++;
    const id = `synthetic-${input.action}-${writes}`;
    rows.push({ id, action: input.action, targetType: input.targetType,
      targetId: input.targetId, actorUserId: "synthetic-owner",
      summary: input.summary, metadata: input.metadata,
      createdAt: new Date(Date.now() + 1_000) });
    return id;
  },
} });
mock.module(mod("lib/adminAuditIntegrityCore.ts"), { namedExports: {
  adminAuditIntegrityKeys: () => ["synthetic-integrity-key"],
} });
mock.module(mod("lib/promptRefinerVnextOneShotAuditReadback.ts"), {
  namedExports: { promptRefinerVnextOneShotAuditReceiptIsValid:
    async () => receiptValid },
});
mock.module(mod("lib/promptRefinerVnextOneShotCandidateSourceReadback.ts"), {
  namedExports: { readPromptRefinerVnextOneShotCandidateSource:
    async (_tx: unknown, requestedStageId: string) => {
      candidateStageIds.push(requestedStageId);
    } },
});
mock.module(mod("lib/promptRefinerVnextOneShotOperationalShadow.ts"), {
  namedExports: { readPromptRefinerVnextOneShotOperationalShadow: async () => {
    if (shadowReadError) throw new Error("synthetic_database_read_failed");
    return { valid: shadowValid,
      shadowAuditLogId: shadowValid ? target.shadowAuditLogId : null };
  } },
});
mock.module(mod("lib/promptRefinerVnextOneShotStageReadback.ts"), {
  namedExports: {
    lockAndReadPromptRefinerVnextOneShotStage: async (_tx: unknown,
      _options: unknown, requestedStageId: string) => {
      stageReadIds.push(requestedStageId);
      return snapshot;
    },
    readPromptRefinerVnextOneShotStage: async (_tx: unknown,
      requestedStageId: string) => {
      stageReadIds.push(requestedStageId);
      return snapshot;
    },
  },
});
mock.module(mod("lib/promptRefinerVnextOneShotTerminalReceipt.ts"), {
  namedExports: { readPromptRefinerVnextOneShotTerminalReceipts:
    async (_tx: unknown, requestedStageId: string) => {
      stageReadIds.push(requestedStageId);
      return terminalReadback;
    } },
});
mock.module(mod("lib/prisma.ts"), { namedExports: {
  prisma: { $transaction: async (work: (tx: object) => Promise<unknown>) => work(tx) },
} });

type GateModule = typeof import("../../lib/promptRefinerVnextOneShotGateEvidence");
const load = () => import(mod("lib/promptRefinerVnextOneShotGateEvidence.ts")) as
  Promise<GateModule>;
const session = { user: { id: "synthetic-owner" } } as Session;
const request = new Request("https://example.test/api/admin/prompt-refiner/vnext-one-shot-gate",
  { method: "POST" });
const reset = () => {
  stage = { ...baseStage };
  snapshot = { stagePresent: true, stageStatus: "run_approved", slotCount: 80,
    reservedSlots: 0, consumedSlots: 80, reservationShapeValid: true,
    approvalAuditsValid: true };
  rows = []; shadowValid = true; shadowReadError = false;
  receiptValid = true; writes = 0;
  stageReadIds.length = 0;
  candidateStageIds.length = 0;
  terminalReadback = {
    valid: true, terminalReceipts: 80, unknownReceipts: 0,
    consumedWithoutReceipt: 0, reservedSlots: 0, observedCostMicroUsd: 80,
    slots: Array.from({ length: 80 }, (_, index) => ({
      state: "terminal", resultKind: index < 64 ? "suggested" : "abstained",
    })),
  };
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT = baseStage.manifestRoot;
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST = baseStage.runnerDigest;
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_PUBLIC_KEY_B64 = publicB64;
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_PUBLIC_KEY_DIGEST =
    promptRefinerVnextOneShotGatePublicKeyDigest(publicB64);
};
async function attestation(overrides: Record<string, unknown> = {}) {
  const { signPromptRefinerVnextOneShotGateAttestation } = await import(
    mod("lib/promptRefinerVnextOneShotGateAttestation.ts"));
  const { PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_SOURCE_DIGEST } = await import(
    mod("lib/promptRefinerVnextOneShotGateSource.ts"));
  return signPromptRefinerVnextOneShotGateAttestation({
    version: "prompt-refiner-vnext-one-shot-gate-attestation-v1", ...target,
    gateSourceDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_SOURCE_DIGEST,
    slotBindingDigest: promptRefinerVnextOneShotSlotBindingDigest(slotRows.map(
      (slot) => ({ slotIndex: slot.slotIndex, requestId: slot.requestId,
        slotConsumptionAuditLogId: `slot-audit-${slot.slotIndex}` }))),
    signedAt: new Date().toISOString(), summary, ...overrides,
  }, privateB64);
}

test("exact synthetic stage/run/shadow/80 audited slots record gate, then separate owner decision", async () => {
  const gate = await load(); reset();
  const signed = await attestation();
  const result = await gate.recordPromptRefinerVnextOneShotGateEvidence({
    session, request, attestation: signed,
  });
  assert.equal(result.gateOutcome, "pass");
  assert.equal(result.finalDisposition, null);
  assert.equal(result.dispatchAuthorized, false);
  assert.equal(writes, 1);
  assert.equal(JSON.stringify(rows[0].metadata).includes(stage.manifestRoot), false);
  assert.equal((await gate.readPromptRefinerVnextOneShotGateEvidence(
    tx as never, stage as never)).valid, true);
  assert.deepEqual((await gate.readPromptRefinerVnextOneShotGateEvidence(
    tx as never, stage as never)).reasonCodes, []);
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_PUBLIC_KEY_B64 = "rotated";
  assert.equal((await gate.readPromptRefinerVnextOneShotGateEvidence(
    tx as never, stage as never)).valid, true,
  "historical evidence keeps its verified public key even after rotation");
  assert.equal((await gate.readPromptRefinerVnextOneShotDisposition(
    tx as never, stage as never)).valid, false);
  const decided = await gate.recordPromptRefinerVnextOneShotDisposition({
    session, request,
    target: { ...target, gateAuditLogId: result.gateAuditLogId },
    decision: "pass",
  });
  assert.equal(decided.finalDisposition, "pass");
  assert.equal(decided.dispatchAuthorized, false);
  assert.equal(writes, 2);
  assert.equal((await gate.readPromptRefinerVnextOneShotDisposition(
    tx as never, stage as never)).valid, true);
});

test("verified v5 readback distinguishes latency-only failure without authorizing pass", async () => {
  const gate = await load(); reset();
  stage = { ...baseStage, id: v5StageId };
  const absent = await gate.readPromptRefinerVnextOneShotGateEvidence(
    tx as never, stage as never, v5StageId);
  assert.equal(absent.present, false);
  assert.equal(absent.reasonCodes, null);
  assert.equal(absent.latencyOnlyFailure, null);
  const latencySummary = { ...summary,
    latency: { ...summary.latency, maximumMs: 12_599 } };
  const recorded = await gate.recordPromptRefinerVnextOneShotGateEvidence({
    session, request, attestation: await attestation({ summary: latencySummary }),
    stageId: v5StageId,
  });
  assert.equal(recorded.gateOutcome, "fail");
  const readback = await gate.readPromptRefinerVnextOneShotGateEvidence(
    tx as never, stage as never, v5StageId);
  assert.equal(readback.valid, true);
  assert.equal(readback.gateOutcome, "fail");
  assert.deepEqual(readback.reasonCodes, ["latency_ceiling_exceeded"]);
  assert.equal(readback.latencyOnlyFailure, true);
  assert.equal(gate.canRecordPromptRefinerVnextOneShotDisposition("fail", "pass"), false);

  const metadata = rows[0].metadata as Record<string, unknown>;
  rows[0].metadata = { ...metadata, reasonCodes: [] };
  const tampered = await gate.readPromptRefinerVnextOneShotGateEvidence(
    tx as never, stage as never, v5StageId);
  assert.equal(tampered.valid, false);
  assert.equal(tampered.reasonCodes, null);
  assert.equal(tampered.latencyOnlyFailure, null);

  reset(); stage = { ...baseStage, id: v5StageId };
  const mixedSummary = { ...latencySummary, directionIssues: {
    ...summary.directionIssues, reason_mismatch: 1,
  } };
  await gate.recordPromptRefinerVnextOneShotGateEvidence({
    session, request, attestation: await attestation({ summary: mixedSummary }),
    stageId: v5StageId,
  });
  const mixed = await gate.readPromptRefinerVnextOneShotGateEvidence(
    tx as never, stage as never, v5StageId);
  assert.equal(mixed.valid, true);
  assert.deepEqual(mixed.reasonCodes,
    ["direction_mismatch", "latency_ceiling_exceeded"]);
  assert.equal(mixed.latencyOnlyFailure, false);
});

test("v5 gate requires its own 80 terminal receipts and records only v5 audits", async () => {
  const gate = await load(); reset();
  stage = { ...baseStage, id: v5StageId };
  const complete = terminalReadback;
  for (const invalid of [
    { ...complete, observedCostMicroUsd: 81 },
    { ...complete, terminalReceipts: 79 },
    { ...complete, unknownReceipts: 1 },
    { ...complete, reservedSlots: 1 },
    { ...complete, slots: complete.slots.map((slot, index) =>
      index === 0 ? { ...slot, resultKind: "failed" } : slot) },
  ]) {
    terminalReadback = invalid;
    await assert.rejects(gate.recordPromptRefinerVnextOneShotGateEvidence({
      session, request, attestation: await attestation(), stageId: v5StageId,
    }), /gate_slot_evidence_mismatch/);
  }
  assert.equal(writes, 0);
  terminalReadback = complete;
  const recorded = await gate.recordPromptRefinerVnextOneShotGateEvidence({
    session, request, attestation: await attestation(), stageId: v5StageId,
  });
  assert.equal(recorded.gateOutcome, "pass");
  assert.equal(rows[0].targetId, v5StageId);
  assert.equal((await gate.readPromptRefinerVnextOneShotGateEvidence(
    tx as never, stage as never, v5StageId)).valid, true);
  const decision = await gate.recordPromptRefinerVnextOneShotDisposition({
    session, request, stageId: v5StageId,
    target: { ...target, gateAuditLogId: recorded.gateAuditLogId },
    decision: "pass",
  });
  assert.equal(decision.finalDisposition, "pass");
  assert.equal(rows[1].targetId, v5StageId);
  assert.equal((await gate.readPromptRefinerVnextOneShotDisposition(
    tx as never, stage as never, v5StageId)).valid, true);
  assert.ok(stageReadIds.length > 0);
  assert.ok(stageReadIds.every((id) => id === v5StageId));
  assert.ok(candidateStageIds.length > 0);
  assert.ok(candidateStageIds.every((id) => id === v5StageId));
});

test("the closed legacy stage cannot receive new gate evidence", async () => {
  const gate = await load(); reset();
  stage = { ...baseStage, id: "prompt-refiner-vnext-one-shot-v1",
    status: "closed" };
  await assert.rejects(gate.recordPromptRefinerVnextOneShotGateEvidence({
    session, request, attestation: await attestation(),
  }), /gate_binding_mismatch/);
  assert.equal(writes, 0);
});

test("missing shadow, slot mismatch, tampered signature and duplicate gate fail before write", async () => {
  const gate = await load();
  reset();
  delete process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_PUBLIC_KEY_DIGEST;
  await assert.rejects(gate.recordPromptRefinerVnextOneShotGateEvidence({
    session, request, attestation: await attestation(),
  }), /signer_pin_unavailable/);
  assert.equal(writes, 0);
  reset(); shadowValid = false;
  await assert.rejects(gate.recordPromptRefinerVnextOneShotGateEvidence({
    session, request, attestation: await attestation(),
  }), /shadow_unavailable/);
  assert.equal(writes, 0);
  reset(); snapshot.consumedSlots = 79;
  await assert.rejects(gate.recordPromptRefinerVnextOneShotGateEvidence({
    session, request, attestation: await attestation(),
  }), /slot_evidence_mismatch/);
  assert.equal(writes, 0);
  reset(); receiptValid = false;
  await assert.rejects(gate.recordPromptRefinerVnextOneShotGateEvidence({
    session, request, attestation: await attestation(),
  }), /slot_evidence_mismatch/);
  assert.equal(writes, 0);
  reset();
  await assert.rejects(gate.recordPromptRefinerVnextOneShotGateEvidence({
    session, request, attestation: await attestation({
      gateSourceDigest: "0".repeat(64),
    }),
  }), /binding_mismatch/);
  assert.equal(writes, 0);
  reset();
  await assert.rejects(gate.recordPromptRefinerVnextOneShotGateEvidence({
    session, request, attestation: await attestation({
      slotBindingDigest: "0".repeat(64),
    }),
  }), /slot_evidence_mismatch/);
  assert.equal(writes, 0);
  reset();
  const signed = await attestation();
  await assert.rejects(gate.recordPromptRefinerVnextOneShotGateEvidence({
    session, request, attestation: { ...signed,
      runtimeDeploymentId: "22222222-2222-4222-8222-222222222222" },
  }), /attestation_invalid/);
  assert.equal(writes, 0);
  await gate.recordPromptRefinerVnextOneShotGateEvidence({
    session, request, attestation: signed,
  });
  await assert.rejects(gate.recordPromptRefinerVnextOneShotGateEvidence({
    session, request, attestation: signed,
  }), /gate_duplicate/);
  assert.equal(writes, 1);
});

test("historical signed evidence survives age and database read errors stay unknown", async () => {
  const gate = await load(); reset();
  await gate.recordPromptRefinerVnextOneShotGateEvidence({
    session, request, attestation: await attestation(),
  });
  const metadata = rows[0].metadata as Record<string, unknown>;
  rows[0].metadata = { ...metadata, attestation: await attestation({
    signedAt: "2026-01-01T00:00:00.000Z",
  }) };
  rows[0].createdAt = new Date("2026-01-01T00:00:01.000Z");
  assert.equal((await gate.readPromptRefinerVnextOneShotGateEvidence(
    tx as never, stage as never)).valid, true);
  shadowReadError = true;
  await assert.rejects(gate.readPromptRefinerVnextOneShotGateEvidence(
    tx as never, stage as never), /synthetic_database_read_failed/);
});

test("stored signer tampering, duplicate gate and broken audit invalidate readback", async () => {
  const gate = await load(); reset();
  await gate.recordPromptRefinerVnextOneShotGateEvidence({
    session, request, attestation: await attestation(),
  });
  const original = rows[0];
  rows = [{ ...original, metadata: {
    ...(original.metadata as Record<string, unknown>),
    gatePublicKeyDigest: "0".repeat(64),
  } }];
  assert.equal((await gate.readPromptRefinerVnextOneShotGateEvidence(
    tx as never, stage as never)).valid, false);
  rows = [original, { ...original, id: "duplicate-gate" }];
  assert.equal((await gate.readPromptRefinerVnextOneShotGateEvidence(
    tx as never, stage as never)).valid, false);
  rows = [original]; receiptValid = false;
  assert.equal((await gate.readPromptRefinerVnextOneShotGateEvidence(
    tx as never, stage as never)).valid, false);
});

test("a failed or missing gate cannot be upgraded by a person or inferred as pass", async () => {
  const gate = await load(); reset();
  assert.equal((await gate.readPromptRefinerVnextOneShotDisposition(
    tx as never, stage as never)).valid, false);
  assert.equal(gate.canRecordPromptRefinerVnextOneShotDisposition("fail", "pass"), false);
  assert.equal(gate.canRecordPromptRefinerVnextOneShotDisposition(
    "insufficient_evidence", "pass"), false);
  await assert.rejects(gate.recordPromptRefinerVnextOneShotDisposition({
    session, request, target: { ...target, gateAuditLogId: "absent" },
    decision: "pass",
  }), /disposition_gate_unavailable/);
  assert.equal(writes, 0);
});
