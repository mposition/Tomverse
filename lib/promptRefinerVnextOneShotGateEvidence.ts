import "server-only";

import type { PromptRefinerVnextOneShotStage, Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { SYSTEM_AUDIT_ACTOR_METADATA_KEY } from "@/lib/adminAuditSystemActors";
import { promptRefinerVnextOneShotAuditReceiptIsValid } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";
import { readPromptRefinerVnextOneShotCandidateSource } from
  "@/lib/promptRefinerVnextOneShotCandidateSourceReadback";
import { readPromptRefinerVnextOneShotOperationalShadow } from
  "@/lib/promptRefinerVnextOneShotOperationalShadow";
import { verifyPromptRefinerVnextOneShotGateAttestation,
  promptRefinerVnextOneShotSlotBindingDigest,
  promptRefinerVnextOneShotGatePublicKeyDigest,
  type PromptRefinerVnextOneShotGateAttestation } from
  "@/lib/promptRefinerVnextOneShotGateAttestation";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_SOURCE_DIGEST } from
  "@/lib/promptRefinerVnextOneShotGateSource";
import { lockAndReadPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import { readPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import {
  evaluatePromptRefinerVnextOneShotGateSummary,
  type PromptRefinerVnextOneShotGateOutcome,
} from "@/lib/promptRefinerVnextOneShotGateSummary";
import {
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_SLOT_COUNT,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";
import { prisma } from "@/lib/prisma";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";

const STAGE_ID = "prompt-refiner-vnext-one-shot-v1";
const GATE_ACTION = "prompt_refiner.vnext_one_shot.gate_evaluated";
const DISPOSITION_ACTION = "prompt_refiner.vnext_one_shot.disposition_recorded";
const GATE_SUMMARY = "Recorded the content-free one-shot deterministic gate result.";
const DISPOSITION_SUMMARY = "Recorded the owner's separate one-shot disposition.";
const SHA256 = /^[0-9a-f]{64}$/;

function readGateSignerPin() {
  const publicKey = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_PUBLIC_KEY_B64 ?? "";
  const expectedDigest =
    process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_PUBLIC_KEY_DIGEST ?? "";
  try {
    if (!SHA256.test(expectedDigest) ||
        promptRefinerVnextOneShotGatePublicKeyDigest(publicKey) !== expectedDigest) {
      throw new Error("pin_mismatch");
    }
    return Object.freeze({ publicKey, digest: expectedDigest });
  } catch {
    throw new Error("vnext_one_shot_gate_signer_pin_unavailable");
  }
}

export type PromptRefinerVnextOneShotGateTarget = Readonly<{
  stageApprovalAuditLogId: string;
  runApprovalAuditLogId: string;
  shadowAuditLogId: string;
  runtimeDeploymentId: string;
}>;

const targetMatches = (stage: PromptRefinerVnextOneShotStage,
  target: PromptRefinerVnextOneShotGateTarget) =>
  stage.stageApprovalAuditLogId === target.stageApprovalAuditLogId &&
  stage.runApprovalAuditLogId === target.runApprovalAuditLogId &&
  stage.runtimeDeploymentId === target.runtimeDeploymentId;

const gateMetadata = (stage: PromptRefinerVnextOneShotStage,
  attestation: PromptRefinerVnextOneShotGateAttestation,
  evaluated: ReturnType<typeof evaluatePromptRefinerVnextOneShotGateSummary>,
  signer: Readonly<{ publicKey: string; digest: string }>) => ({
  version: "prompt-refiner-vnext-one-shot-gate-evidence-v1",
  attestation,
  gatePublicKeyDerBase64: signer.publicKey,
  gatePublicKeyDigest: signer.digest,
  sourceCommitSha: stage.sourceCommitSha,
  sourceManifestDigest: stage.sourceManifestDigest,
  runnerDigest: stage.runnerDigest,
  runtimeDeploymentId: stage.runtimeDeploymentId,
  runtimeCommitSha: stage.runtimeCommitSha,
  pricePinDigest: stage.pricePinDigest,
  gateOutcome: evaluated.outcome,
  reasonCodes: evaluated.reasonCodes,
});

const dispositionMetadata = (gateAuditLogId: string,
  runApprovalAuditLogId: string,
  gateOutcome: PromptRefinerVnextOneShotGateOutcome,
  decision: PromptRefinerVnextOneShotGateOutcome) => ({
  version: "prompt-refiner-vnext-one-shot-disposition-v1",
  gateAuditLogId, runApprovalAuditLogId, gateOutcome, decision,
});

/** One signed row bound to the current stage; absence, duplicates and drift differ. */
export async function readPromptRefinerVnextOneShotGateEvidence(
  tx: Prisma.TransactionClient,
  stage: PromptRefinerVnextOneShotStage | null,
): Promise<Readonly<{
  present: boolean; valid: boolean; gateAuditLogId: string | null;
  gateOutcome: PromptRefinerVnextOneShotGateOutcome | null;
}>> {
  const rows = await tx.adminAuditLog.findMany({
    where: { action: GATE_ACTION, targetType: "PromptRefinerVnextOneShotStage",
      targetId: STAGE_ID },
  });
  const entry = rows.length === 1 ? rows[0] : null;
  let outcome: PromptRefinerVnextOneShotGateOutcome | null = null;
  if (entry && stage?.id === STAGE_ID && stage.runApprovalAuditLogId &&
      entry.actorUserId === stage.approvedBy && entry.summary === GATE_SUMMARY &&
      entry.metadata && typeof entry.metadata === "object" &&
      !Array.isArray(entry.metadata)) {
    const metadata = entry.metadata as Record<string, unknown>;
    let attestation: PromptRefinerVnextOneShotGateAttestation;
    let evaluated: ReturnType<typeof evaluatePromptRefinerVnextOneShotGateSummary>;
    let signer: Readonly<{ publicKey: string; digest: string }>;
    try {
      if (typeof metadata.gatePublicKeyDerBase64 !== "string" ||
          typeof metadata.gatePublicKeyDigest !== "string" ||
          promptRefinerVnextOneShotGatePublicKeyDigest(
            metadata.gatePublicKeyDerBase64) !== metadata.gatePublicKeyDigest) {
        throw new Error("stored_signer_invalid");
      }
      signer = { publicKey: metadata.gatePublicKeyDerBase64,
        digest: metadata.gatePublicKeyDigest };
      attestation = verifyPromptRefinerVnextOneShotGateAttestation(
        metadata.attestation, signer.publicKey, entry.createdAt);
      evaluated = evaluatePromptRefinerVnextOneShotGateSummary(
        attestation.summary);
    } catch {
      return Object.freeze({ present: true, valid: false,
        gateAuditLogId: null, gateOutcome: null });
    }
    const shadow = await readPromptRefinerVnextOneShotOperationalShadow(tx, stage);
    const slots = await readPromptRefinerVnextOneShotStage(tx);
    const attempted = evaluated.summary.outcomes.suggested +
      evaluated.summary.outcomes.abstained +
      evaluated.summary.outcomes.failed + evaluated.summary.outcomes.unknown;
    if (shadow.valid &&
        attestation.stageApprovalAuditLogId === stage.stageApprovalAuditLogId &&
        attestation.runApprovalAuditLogId === stage.runApprovalAuditLogId &&
        attestation.shadowAuditLogId === shadow.shadowAuditLogId &&
        attestation.runtimeDeploymentId === stage.runtimeDeploymentId &&
        slots.reservationShapeValid && slots.approvalAuditsValid &&
        slots.consumedSlots === attempted &&
        slots.reservedSlots === evaluated.summary.outcomes.not_dispatched &&
        (await verifyConsumedSlotAudits(tx, attempted,
          attestation.runApprovalAuditLogId))?.digest ===
            attestation.slotBindingDigest &&
        canonicalBenchmarkJson(metadata) ===
          canonicalBenchmarkJson(gateMetadata(stage, attestation, evaluated, signer)) &&
        await promptRefinerVnextOneShotAuditReceiptIsValid(tx, entry)) {
      outcome = evaluated.outcome;
    }
  }
  return Object.freeze({ present: rows.length !== 0, valid: outcome !== null,
    gateAuditLogId: outcome === null ? null : entry!.id, gateOutcome: outcome });
}

async function verifyConsumedSlotAudits(
  tx: Prisma.TransactionClient, consumedSlots: number,
  runApprovalAuditLogId: string,
): Promise<Readonly<{ latest: Date; digest: string }> | null> {
  const slots = await tx.promptRefinerVnextOneShotSlot.findMany({
    where: { stageId: STAGE_ID, status: "consumed" },
    select: { id: true, slotIndex: true, requestId: true },
  });
  if (slots.length !== consumedSlots) return null;
  const rows = await tx.adminAuditLog.findMany({
    where: { action: "prompt_refiner.vnext_one_shot.slot_consumed",
      targetType: "PromptRefinerVnextOneShotSlot",
      targetId: { in: slots.map((slot) => slot.id) } },
  });
  if (rows.length !== slots.length) return null;
  const audits = new Map(rows.map((row) => [row.targetId, row]));
  if (audits.size !== rows.length) return null;
  let latest = new Date(0);
  const cumulative = new Set<number>();
  const bindings: Array<{ slotIndex: number; requestId: string;
    slotConsumptionAuditLogId: string }> = [];
  for (const slot of slots) {
    const entry = audits.get(slot.id);
    const metadata = entry?.metadata;
    if (!entry || !slot.requestId || !metadata ||
        typeof metadata !== "object" || Array.isArray(metadata) ||
        metadata.requestId !== slot.requestId ||
        metadata.slotIndex !== slot.slotIndex ||
        metadata.runApprovalAuditLogId !== runApprovalAuditLogId ||
        metadata.reservedCostMicroUsd !==
          PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD ||
        !Number.isSafeInteger(metadata.cumulativeReservedCostMicroUsd) ||
        (metadata.cumulativeReservedCostMicroUsd as number) <
          PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD ||
        (metadata.cumulativeReservedCostMicroUsd as number) >
          consumedSlots * PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD ||
        metadata[SYSTEM_AUDIT_ACTOR_METADATA_KEY] !==
          "prompt-refiner-vnext-one-shot-runner" ||
        !await promptRefinerVnextOneShotAuditReceiptIsValid(tx, entry)) return null;
    cumulative.add(metadata.cumulativeReservedCostMicroUsd as number);
    bindings.push({ slotIndex: slot.slotIndex,
      requestId: slot.requestId, slotConsumptionAuditLogId: entry.id });
    if (entry.createdAt > latest) latest = entry.createdAt;
  }
  if (cumulative.size !== consumedSlots ||
      Array.from({ length: consumedSlots }, (_, index) =>
        (index + 1) * PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD)
        .some((value) => !cumulative.has(value))) return null;
  try {
    return Object.freeze({ latest,
      digest: promptRefinerVnextOneShotSlotBindingDigest(bindings) });
  } catch {
    return null;
  }
}

/** Server rechecks the bound stage, all attempted slots, audit and shadow. */
export async function recordPromptRefinerVnextOneShotGateEvidence(input: {
  session: Session;
  request: Request;
  attestation: unknown;
}) {
  if (!input.session?.user?.id || adminAuditIntegrityKeys(process.env).length === 0) {
    throw new Error("vnext_one_shot_gate_context_invalid");
  }
  const signer = readGateSignerPin();
  const attestation = verifyPromptRefinerVnextOneShotGateAttestation(
    input.attestation, signer.publicKey);
  const evaluated = evaluatePromptRefinerVnextOneShotGateSummary(attestation.summary);
  const root = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_MANIFEST_ROOT;
  const runner = process.env.PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_DIGEST;
  if (!SHA256.test(root ?? "") || !SHA256.test(runner ?? "")) {
    throw new Error("vnext_one_shot_gate_custody_pin_unavailable");
  }
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const snapshot = await lockAndReadPromptRefinerVnextOneShotStage(tx);
    if (!snapshot.stagePresent || !snapshot.reservationShapeValid ||
        !snapshot.approvalAuditsValid ||
        !["run_approved", "closed"].includes(snapshot.stageStatus ?? "") ||
        (snapshot.stageStatus === "run_approved" && snapshot.reservedSlots !== 0) ||
        snapshot.slotCount !== PROMPT_REFINER_VNEXT_SLOT_COUNT) {
      throw new Error("vnext_one_shot_gate_stage_unavailable");
    }
    await readPromptRefinerVnextOneShotCandidateSource(tx);
    const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
      where: { id: STAGE_ID },
    });
    if (!stage || stage.approvedBy !== input.session.user.id ||
        !targetMatches(stage, attestation) ||
        attestation.gateSourceDigest !==
          PROMPT_REFINER_VNEXT_ONE_SHOT_GATE_SOURCE_DIGEST ||
        stage.manifestRoot !== root || stage.runnerDigest !== runner) {
      throw new Error("vnext_one_shot_gate_binding_mismatch");
    }
    const shadow = await readPromptRefinerVnextOneShotOperationalShadow(tx, stage);
    if (!shadow.valid || shadow.shadowAuditLogId !== attestation.shadowAuditLogId) {
      throw new Error("vnext_one_shot_gate_shadow_unavailable");
    }
    const attempted = evaluated.summary.outcomes.suggested +
      evaluated.summary.outcomes.abstained + evaluated.summary.outcomes.failed +
      evaluated.summary.outcomes.unknown;
    const slotAudits = await verifyConsumedSlotAudits(tx, attempted,
      attestation.runApprovalAuditLogId);
    const shadowAudit = await tx.adminAuditLog.findUnique({
      where: { id: attestation.shadowAuditLogId },
      select: { createdAt: true },
    });
    if (snapshot.consumedSlots !== attempted ||
        snapshot.reservedSlots !== evaluated.summary.outcomes.not_dispatched ||
        !slotAudits || slotAudits.digest !== attestation.slotBindingDigest ||
        !shadowAudit ||
        Date.parse(attestation.signedAt) < slotAudits.latest.getTime() ||
        Date.parse(attestation.signedAt) < shadowAudit.createdAt.getTime()) {
      throw new Error("vnext_one_shot_gate_slot_evidence_mismatch");
    }
    const prior = await readPromptRefinerVnextOneShotGateEvidence(tx, stage);
    if (prior.present) throw new Error("vnext_one_shot_gate_duplicate");
    const gateAuditLogId = await writeAdminAuditLog({
      tx, session: input.session, request: input.request,
      action: GATE_ACTION, targetType: "PromptRefinerVnextOneShotStage",
      targetId: STAGE_ID, summary: GATE_SUMMARY,
      metadata: gateMetadata(stage, attestation, evaluated, signer),
    });
    const readback = await readPromptRefinerVnextOneShotGateEvidence(tx, stage);
    if (!readback.valid || readback.gateAuditLogId !== gateAuditLogId ||
        readback.gateOutcome !== evaluated.outcome) {
      throw new Error("vnext_one_shot_gate_readback_invalid");
    }
    return Object.freeze({ gateAuditLogId, gateOutcome: evaluated.outcome,
      reasonCodes: evaluated.reasonCodes, finalDisposition: null,
      dispatchAuthorized: false as const });
  }, { maxWait: 5_000, timeout: 30_000 });
}

export async function readPromptRefinerVnextOneShotDisposition(
  tx: Prisma.TransactionClient, stage: PromptRefinerVnextOneShotStage | null,
) {
  const gate = await readPromptRefinerVnextOneShotGateEvidence(tx, stage);
  const rows = await tx.adminAuditLog.findMany({
    where: { action: DISPOSITION_ACTION,
      targetType: "PromptRefinerVnextOneShotStage", targetId: STAGE_ID },
  });
  const entry = rows.length === 1 ? rows[0] : null;
  let decision: PromptRefinerVnextOneShotGateOutcome | null = null;
  if (entry && stage && gate.valid && gate.gateAuditLogId && gate.gateOutcome &&
      stage.runApprovalAuditLogId && entry.actorUserId === stage.approvedBy &&
      entry.summary === DISPOSITION_SUMMARY && entry.metadata &&
      typeof entry.metadata === "object" && !Array.isArray(entry.metadata)) {
    const candidate = (entry.metadata as Record<string, unknown>).decision;
    if (candidate === "pass" || candidate === "fail" ||
        candidate === "insufficient_evidence") {
      const expected = dispositionMetadata(gate.gateAuditLogId,
        stage.runApprovalAuditLogId, gate.gateOutcome, candidate);
      if (canonicalBenchmarkJson(entry.metadata) === canonicalBenchmarkJson(expected) &&
          canRecordPromptRefinerVnextOneShotDisposition(gate.gateOutcome, candidate) &&
          await promptRefinerVnextOneShotAuditReceiptIsValid(tx, entry)) decision = candidate;
    }
  }
  return Object.freeze({ present: rows.length !== 0, valid: decision !== null,
    dispositionAuditLogId: decision === null ? null : entry!.id,
    finalDisposition: decision });
}

export const canRecordPromptRefinerVnextOneShotDisposition = (
  gateOutcome: PromptRefinerVnextOneShotGateOutcome,
  decision: PromptRefinerVnextOneShotGateOutcome,
) => gateOutcome === "pass" || decision === "fail" ||
  (gateOutcome === "insufficient_evidence" && decision === "insufficient_evidence");

/** The owner decision is a separate signed human action, never inferred from gate pass. */
export async function recordPromptRefinerVnextOneShotDisposition(input: {
  session: Session;
  request: Request;
  target: PromptRefinerVnextOneShotGateTarget & { gateAuditLogId: string };
  decision: PromptRefinerVnextOneShotGateOutcome;
}) {
  if (!input.session?.user?.id || adminAuditIntegrityKeys(process.env).length === 0) {
    throw new Error("vnext_one_shot_disposition_context_invalid");
  }
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const snapshot = await lockAndReadPromptRefinerVnextOneShotStage(tx);
    if (!snapshot.stagePresent || !snapshot.reservationShapeValid ||
        !snapshot.approvalAuditsValid) {
      throw new Error("vnext_one_shot_disposition_stage_unavailable");
    }
    const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
      where: { id: STAGE_ID },
    });
    if (!stage || stage.approvedBy !== input.session.user.id ||
        !targetMatches(stage, input.target)) {
      throw new Error("vnext_one_shot_disposition_binding_mismatch");
    }
    await readPromptRefinerVnextOneShotCandidateSource(tx);
    const shadow = await readPromptRefinerVnextOneShotOperationalShadow(tx, stage);
    if (!shadow.valid || shadow.shadowAuditLogId !== input.target.shadowAuditLogId) {
      throw new Error("vnext_one_shot_disposition_binding_mismatch");
    }
    const gate = await readPromptRefinerVnextOneShotGateEvidence(tx, stage);
    if (!gate.valid || gate.gateAuditLogId !== input.target.gateAuditLogId ||
        !gate.gateOutcome || !stage.runApprovalAuditLogId ||
        !canRecordPromptRefinerVnextOneShotDisposition(gate.gateOutcome,
          input.decision)) {
      throw new Error("vnext_one_shot_disposition_gate_unavailable");
    }
    const prior = await readPromptRefinerVnextOneShotDisposition(tx, stage);
    if (prior.present) throw new Error("vnext_one_shot_disposition_duplicate");
    const dispositionAuditLogId = await writeAdminAuditLog({
      tx, session: input.session, request: input.request,
      action: DISPOSITION_ACTION, targetType: "PromptRefinerVnextOneShotStage",
      targetId: STAGE_ID, summary: DISPOSITION_SUMMARY,
      metadata: dispositionMetadata(gate.gateAuditLogId,
        stage.runApprovalAuditLogId, gate.gateOutcome, input.decision),
    });
    const readback = await readPromptRefinerVnextOneShotDisposition(tx, stage);
    if (!readback.valid ||
        readback.dispositionAuditLogId !== dispositionAuditLogId) {
      throw new Error("vnext_one_shot_disposition_readback_invalid");
    }
    return Object.freeze({ dispositionAuditLogId,
      finalDisposition: input.decision, dispatchAuthorized: false as const });
  }, { maxWait: 5_000, timeout: 15_000 });
}
