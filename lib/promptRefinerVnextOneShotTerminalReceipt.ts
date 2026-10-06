import "server-only";

import type { Prisma } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import { promptRefinerVnextOneShotAuditReceiptIsValid } from
  "@/lib/promptRefinerVnextOneShotAuditReadback";
import {
  guardPromptRefinerVnextBilledUsage,
  PROMPT_REFINER_VNEXT_PRICE_PIN,
  PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD,
  PROMPT_REFINER_VNEXT_SLOT_COUNT,
} from "@/lib/promptRefinerQualityEvaluationVnextExecutionContract";
import { verifyPromptRefinerVnextOneShotConsumedRequest } from
  "@/lib/promptRefinerVnextOneShotOutcomeRecovery";
import { PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST } from
  "@/lib/promptRefinerVnextOneShotPriceBinding";
import {
  isPromptRefinerVnextConfirmedFailureCode,
  type PromptRefinerVnextConfirmedFailureCode,
} from "@/lib/promptRefinerVnextOneShotFailureCodes";
import { readPromptRefinerVnextOneShotStage } from
  "@/lib/promptRefinerVnextOneShotStageReadback";
import { prisma } from "@/lib/prisma";
import { canonicalBenchmarkJson } from "@/lib/routerDevelopmentBenchmark";
import { V4_STAGE_ID, V5_STAGE_ID,
  type PromptRefinerRunnableStageId } from
  "@/lib/promptRefinerVnextOneShotV5Recovery";

const STAGE_ID = V4_STAGE_ID;
const ACTION = "prompt_refiner.vnext_one_shot.terminal_recorded";
const STOP_ACTION = "prompt_refiner.vnext_one_shot.outcome_unknown";
const SUMMARY = "Recorded one content-free one-shot terminal result and billed usage.";
const SYSTEM_ACTOR = "prompt-refiner-vnext-one-shot-runner";
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;
const MAX_COST = PROMPT_REFINER_VNEXT_REQUEST_CEILING_MICRO_USD;

export type PromptRefinerVnextTerminalInput = Readonly<{
  stageId?: PromptRefinerRunnableStageId;
  requestId: string;
  slotIndex: number;
  runApprovalAuditLogId: string;
  slotConsumptionAuditLogId: string;
  resultKind: "suggested" | "abstained" | "failed";
  failureCode?: PromptRefinerVnextConfirmedFailureCode;
  usage: Readonly<{
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    reasoningTokens: number | null;
  }>;
  observedCostMicroUsd: number;
  intentToTerminalLatencyMs: number;
}>;

function checkedInput(input: PromptRefinerVnextTerminalInput): boolean {
  if (!UUID.test(input?.requestId ?? "") ||
      (input.stageId !== undefined && input.stageId !== STAGE_ID &&
        input.stageId !== V5_STAGE_ID) ||
      !Number.isInteger(input.slotIndex) || input.slotIndex < 0 ||
      input.slotIndex >= PROMPT_REFINER_VNEXT_SLOT_COUNT ||
      typeof input.runApprovalAuditLogId !== "string" ||
      input.runApprovalAuditLogId.length < 1 ||
      input.runApprovalAuditLogId.length > 128 ||
      typeof input.slotConsumptionAuditLogId !== "string" ||
      input.slotConsumptionAuditLogId.length < 1 ||
      input.slotConsumptionAuditLogId.length > 128 ||
      !["suggested", "abstained", "failed"].includes(input.resultKind) ||
      (input.resultKind === "failed"
        ? !isPromptRefinerVnextConfirmedFailureCode(input.failureCode)
        : input.failureCode !== undefined) ||
      !Number.isSafeInteger(input.observedCostMicroUsd) ||
      input.observedCostMicroUsd < 0 || input.observedCostMicroUsd > MAX_COST ||
      !Number.isSafeInteger(input.intentToTerminalLatencyMs) ||
      input.intentToTerminalLatencyMs < 0 ||
      input.intentToTerminalLatencyMs > 15_000) return false;
  const price = guardPromptRefinerVnextBilledUsage({
    usage: input.usage, effectivePricePin: PROMPT_REFINER_VNEXT_PRICE_PIN,
  });
  return price.complete && price.costUpperBoundMicroUsd === input.observedCostMicroUsd &&
    input.usage.cacheWriteInputTokens === 0;
}

const receiptMetadata = (input: PromptRefinerVnextTerminalInput) => ({
  version: input.resultKind === "failed"
    ? "prompt-refiner-vnext-one-shot-terminal-v2"
    : "prompt-refiner-vnext-one-shot-terminal-v1",
  stageId: input.stageId ?? STAGE_ID,
  requestId: input.requestId,
  slotIndex: input.slotIndex,
  runApprovalAuditLogId: input.runApprovalAuditLogId,
  slotConsumptionAuditLogId: input.slotConsumptionAuditLogId,
  resultKind: input.resultKind,
  ...(input.resultKind === "failed" ? { failureCode: input.failureCode } : {}),
  usage: input.usage,
  observedCostMicroUsd: input.observedCostMicroUsd,
  reservedCostMicroUsd: MAX_COST,
  intentToTerminalLatencyMs: input.intentToTerminalLatencyMs,
  pricePinDigest: PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST,
  systemActor: SYSTEM_ACTOR,
});

type Tx = Prisma.TransactionClient;
type Slot = { id: string; slotIndex: number; status: string;
  requestId: string | null; reservedCostMicroUsd: bigint };

async function validatedTerminal(
  tx: Tx, slot: Slot, audits: Awaited<ReturnType<Tx["adminAuditLog"]["findMany"]>>,
  runApprovalAuditLogId: string, stageId: PromptRefinerRunnableStageId,
) {
  if (audits.length !== 1 || !slot.requestId) return null;
  const audit = audits[0];
  const data = audit.metadata;
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const input: PromptRefinerVnextTerminalInput = {
    stageId,
    requestId: data.requestId as string,
    slotIndex: data.slotIndex as number,
    runApprovalAuditLogId: data.runApprovalAuditLogId as string,
    slotConsumptionAuditLogId: data.slotConsumptionAuditLogId as string,
    resultKind: data.resultKind as "suggested" | "abstained" | "failed",
    failureCode: data.failureCode as PromptRefinerVnextConfirmedFailureCode | undefined,
    usage: data.usage as PromptRefinerVnextTerminalInput["usage"],
    observedCostMicroUsd: data.observedCostMicroUsd as number,
    intentToTerminalLatencyMs: data.intentToTerminalLatencyMs as number,
  };
  if (!checkedInput(input) || input.requestId !== slot.requestId ||
      input.slotIndex !== slot.slotIndex ||
      input.runApprovalAuditLogId !== runApprovalAuditLogId ||
      audit.action !== ACTION ||
      audit.targetType !== "PromptRefinerVnextOneShotSlot" ||
      audit.targetId !== slot.id || audit.summary !== SUMMARY ||
      audit.actorUserId !== null ||
      canonicalBenchmarkJson(data) !== canonicalBenchmarkJson(receiptMetadata(input)) ||
      !await promptRefinerVnextOneShotAuditReceiptIsValid(tx, audit)) return null;
  try {
    await verifyPromptRefinerVnextOneShotConsumedRequest(tx, {
      stageId,
      requestId: input.requestId, slotIndex: input.slotIndex,
      runApprovalAuditLogId: input.runApprovalAuditLogId,
      slotConsumptionAuditLogId: input.slotConsumptionAuditLogId,
      reason: "response_unverified",
    });
  } catch { return null; }
  return { auditLogId: audit.id, input };
}

/** A terminal receipt is one atomic, hash-chained observation, never a spend grant. */
export async function recordPromptRefinerVnextOneShotTerminal(
  input: PromptRefinerVnextTerminalInput,
) {
  if (!checkedInput(input) || adminAuditIntegrityKeys(process.env).length === 0) {
    throw new Error("vnext_one_shot_terminal_input_invalid");
  }
  const stageId = input.stageId ?? STAGE_ID;
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "PromptRefinerVnextOneShotStage"
      WHERE "id" = ${stageId} FOR NO KEY UPDATE NOWAIT
    `;
    if (rows.length !== 1 || rows[0]?.id !== stageId) {
      throw new Error("vnext_one_shot_terminal_stage_unavailable");
    }
    const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
      where: { id: stageId },
    });
    const snapshot = await readPromptRefinerVnextOneShotStage(tx, stageId);
    if (!stage || stage.status !== "run_approved" ||
        stage.runApprovalAuditLogId !== input.runApprovalAuditLogId ||
        stage.pricePinDigest !== PROMPT_REFINER_VNEXT_ONE_SHOT_PRICE_PIN_DIGEST ||
        stage.perRequestCostMicroUsd !== BigInt(MAX_COST) ||
        stage.costCeilingMicroUsd !==
          BigInt(PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD) ||
        !snapshot.reservationShapeValid || !snapshot.approvalAuditsValid) {
      throw new Error("vnext_one_shot_terminal_binding_mismatch");
    }
    // Settlement records an already-consumed request. A later deployment or
    // registry price change must not prevent its bounded usage/cost receipt.
    const { slotId } = await verifyPromptRefinerVnextOneShotConsumedRequest(tx, {
      stageId,
      requestId: input.requestId, slotIndex: input.slotIndex,
      runApprovalAuditLogId: input.runApprovalAuditLogId,
      slotConsumptionAuditLogId: input.slotConsumptionAuditLogId,
      reason: "response_unverified",
    });
    const existing = await tx.adminAuditLog.findMany({
      where: { action: ACTION, targetType: "PromptRefinerVnextOneShotSlot",
        targetId: slotId },
    });
    if (existing.length !== 0) {
      throw new Error("vnext_one_shot_terminal_duplicate");
    }
    const terminalAuditLogId = await writeSystemAuditLog({
      tx, systemActor: SYSTEM_ACTOR, action: ACTION,
      targetType: "PromptRefinerVnextOneShotSlot", targetId: slotId,
      summary: SUMMARY, metadata: (() => {
        const { systemActor: _systemActor, ...metadata } = receiptMetadata(input);
        void _systemActor;
        return metadata;
      })(),
    });
    const audit = await tx.adminAuditLog.findUnique({
      where: { id: terminalAuditLogId },
    });
    const valid = audit && await validatedTerminal(tx, {
      id: slotId, slotIndex: input.slotIndex, status: "consumed",
      requestId: input.requestId, reservedCostMicroUsd: BigInt(MAX_COST),
    }, [audit], stage.runApprovalAuditLogId, stageId);
    if (!valid || valid.auditLogId !== terminalAuditLogId) {
      throw new Error("vnext_one_shot_terminal_readback_invalid");
    }
    return Object.freeze({ terminalAuditLogId,
      requestId: input.requestId, slotIndex: input.slotIndex,
      observedCostMicroUsd: input.observedCostMicroUsd,
      dispatchAuthorized: false as const });
  }, { maxWait: 5_000, timeout: 15_000 });
}

/** All 80 slots are classified without exposing restricted content or root. */
export async function readPromptRefinerVnextOneShotTerminalReceipts(
  tx: Tx, stageId: PromptRefinerRunnableStageId = STAGE_ID,
) {
  const stage = await tx.promptRefinerVnextOneShotStage.findUnique({
    where: { id: stageId },
  });
  const snapshot = await readPromptRefinerVnextOneShotStage(tx, stageId);
  if (!stage || !snapshot.stagePresent) return Object.freeze({
    stageId, stageStatus: null, valid: false,
    reservedSlots: 0, terminalReceipts: 0, unknownReceipts: 0,
    consumedWithoutReceipt: 0, observedCostMicroUsd: 0,
    unresolvedCostUpperBoundMicroUsd: 0, slots: [],
  });
  const slots = await tx.promptRefinerVnextOneShotSlot.findMany({
    where: { stageId }, orderBy: { slotIndex: "asc" },
    select: { id: true, slotIndex: true, status: true, requestId: true,
      reservedCostMicroUsd: true },
  });
  const slotIds = slots.map((slot) => slot.id);
  const terminalAudits = slotIds.length ? await tx.adminAuditLog.findMany({
    where: { action: ACTION, targetType: "PromptRefinerVnextOneShotSlot",
      targetId: { in: slotIds } },
  }) : [];
  const unknownAudits = await tx.adminAuditLog.findMany({
    where: { action: STOP_ACTION, targetType: "PromptRefinerVnextOneShotStage",
      targetId: stageId },
  });
  const bySlot = new Map<string, typeof terminalAudits>();
  for (const audit of terminalAudits) {
    const id = audit.targetId ?? "";
    bySlot.set(id, [...(bySlot.get(id) ?? []), audit]);
  }
  let observedCostMicroUsd = 0;
  let unresolvedCostUpperBoundMicroUsd = 0;
  let terminalReceipts = 0;
  let unknownReceipts = 0;
  let consumedWithoutReceipt = 0;
  const rows = [];
  for (const slot of slots) {
    if (slot.status === "reserved") {
      rows.push({ slotIndex: slot.slotIndex, state: "not_attempted",
        requestId: null, terminalAuditLogId: null,
        observedCostMicroUsd: 0, costUpperBoundMicroUsd: 0 });
      continue;
    }
    const terminal = await validatedTerminal(tx, slot,
      bySlot.get(slot.id) ?? [], stage.runApprovalAuditLogId ?? "", stageId);
    if (terminal) {
      terminalReceipts++;
      observedCostMicroUsd += terminal.input.observedCostMicroUsd;
      rows.push({ slotIndex: slot.slotIndex, state: "terminal",
        requestId: slot.requestId, terminalAuditLogId: terminal.auditLogId,
        resultKind: terminal.input.resultKind, usage: terminal.input.usage,
        ...(terminal.input.resultKind === "failed"
          ? { failureCode: terminal.input.failureCode } : {}),
        intentToTerminalLatencyMs: terminal.input.intentToTerminalLatencyMs,
        observedCostMicroUsd: terminal.input.observedCostMicroUsd,
        costUpperBoundMicroUsd: terminal.input.observedCostMicroUsd });
      continue;
    }
    const stops = unknownAudits.filter((audit) => {
      const data = audit.metadata;
      return data && typeof data === "object" && !Array.isArray(data) &&
        data.requestId === slot.requestId && data.slotIndex === slot.slotIndex;
    });
    const stop = stops.length === 1 ? stops[0] : null;
    const data = stop?.metadata;
    const unknownValid = Boolean(stop && data && typeof data === "object" &&
      !Array.isArray(data) && stage.status === "closed" &&
      stop.action === STOP_ACTION &&
      stop.targetType === "PromptRefinerVnextOneShotStage" &&
      stop.targetId === stageId &&
      stop.summary === "Stopped the one-shot run after an uncertain request outcome." &&
      stop.actorUserId === null &&
      data.runApprovalAuditLogId === stage.runApprovalAuditLogId &&
      typeof data.slotConsumptionAuditLogId === "string" &&
      data.reservedCostMicroUsd === MAX_COST &&
      data.systemActor === SYSTEM_ACTOR &&
      ["timeout", "provider_error", "response_unverified"].includes(
        data.reason as string) &&
      Object.keys(data).sort().join(",") ===
        "reason,requestId,reservedCostMicroUsd,runApprovalAuditLogId,slotConsumptionAuditLogId,slotIndex,systemActor" &&
      await (async () => { try {
        await verifyPromptRefinerVnextOneShotConsumedRequest(tx, {
          stageId,
          requestId: slot.requestId!, slotIndex: slot.slotIndex,
          runApprovalAuditLogId: stage.runApprovalAuditLogId!,
          slotConsumptionAuditLogId: data.slotConsumptionAuditLogId as string,
          reason: data.reason as "timeout" | "provider_error" | "response_unverified",
        });
        return true;
      } catch { return false; } })() &&
      await promptRefinerVnextOneShotAuditReceiptIsValid(tx, stop));
    if (unknownValid) unknownReceipts++;
    else consumedWithoutReceipt++;
    unresolvedCostUpperBoundMicroUsd += MAX_COST;
    rows.push({ slotIndex: slot.slotIndex,
      state: unknownValid ? "outcome_unknown" : "receipt_missing_or_invalid",
      requestId: slot.requestId,
      terminalAuditLogId: unknownValid ? stop!.id : null,
      observedCostMicroUsd: null, costUpperBoundMicroUsd: MAX_COST });
  }
  const valid = snapshot.reservationShapeValid && snapshot.approvalAuditsValid &&
    slots.length === PROMPT_REFINER_VNEXT_SLOT_COUNT &&
    slots.every((slot, index) => slot.slotIndex === index &&
      slot.reservedCostMicroUsd === BigInt(MAX_COST)) &&
    terminalAudits.length === terminalReceipts &&
    unknownAudits.length === unknownReceipts &&
    consumedWithoutReceipt === 0 &&
    observedCostMicroUsd + unresolvedCostUpperBoundMicroUsd <=
      PROMPT_REFINER_VNEXT_RUN_CEILING_MICRO_USD;
  return Object.freeze({ stageId, stageStatus: stage.status,
    valid, reservedSlots: snapshot.reservedSlots, terminalReceipts,
    unknownReceipts, consumedWithoutReceipt, observedCostMicroUsd,
    unresolvedCostUpperBoundMicroUsd, slots: rows });
}

/** No new dispatch while any consumed slot lacks a verified terminal receipt. */
export async function assertPromptRefinerVnextOneShotTerminalsComplete(
  tx: Tx, stageId: PromptRefinerRunnableStageId = STAGE_ID,
) {
  const readback = await readPromptRefinerVnextOneShotTerminalReceipts(tx, stageId);
  if (!readback.valid || readback.consumedWithoutReceipt !== 0 ||
      readback.unknownReceipts !== 0 ||
      readback.terminalReceipts +
        readback.reservedSlots !== PROMPT_REFINER_VNEXT_SLOT_COUNT) {
    throw new Error("vnext_one_shot_prior_terminal_unverified");
  }
}
