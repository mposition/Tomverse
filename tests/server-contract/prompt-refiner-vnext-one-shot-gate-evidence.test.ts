import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import type { Session } from "next-auth";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const stageId = "prompt-refiner-vnext-one-shot-v1";
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
    maximumRequestCostMicroUsd: 1 },
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
let receiptValid = true;
let writes = 0;
const slotRows = Array.from({ length: 80 }, (_, slotIndex) => ({
  id: `slot-${slotIndex}`, slotIndex, requestId: `request-${slotIndex}`,
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
  promptRefinerVnextOneShotStage: { findUnique: async () => stage },
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
      createdAt: new Date("2026-10-05T00:00:03.000Z") });
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
  namedExports: { readPromptRefinerVnextOneShotCandidateSource: async () => {} },
});
mock.module(mod("lib/promptRefinerVnextOneShotOperationalShadow.ts"), {
  namedExports: { readPromptRefinerVnextOneShotOperationalShadow: async () => ({
    valid: shadowValid, shadowAuditLogId: shadowValid ? target.shadowAuditLogId : null,
  }) },
});
mock.module(mod("lib/promptRefinerVnextOneShotStageReadback.ts"), {
  namedExports: {
    lockAndReadPromptRefinerVnextOneShotStage: async () => snapshot,
    readPromptRefinerVnextOneShotStage: async () => snapshot,
  },
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
  rows = []; shadowValid = true; receiptValid = true; writes = 0;
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT = baseStage.manifestRoot;
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST = baseStage.runnerDigest;
  process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_PUBLIC_KEY_B64 = publicB64;
};
async function attestation(overrides: Record<string, unknown> = {}) {
  const { signPromptRefinerVnextOneShotGateAttestation } = await import(
    mod("lib/promptRefinerVnextOneShotGateAttestation.ts"));
  const { PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_SOURCE_DIGEST } = await import(
    mod("lib/promptRefinerVnextOneShotGateSource.ts"));
  return signPromptRefinerVnextOneShotGateAttestation({
    version: "prompt-refiner-vnext-one-shot-gate-attestation-v1", ...target,
    gateSourceDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_SOURCE_DIGEST,
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

test("missing shadow, slot mismatch, tampered signature and duplicate gate fail before write", async () => {
  const gate = await load();
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
