import { createHash } from "node:crypto";
import { z } from "zod";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import type { V4TaskCostCeilingReceipt } from "./v4TaskCostCeilingCore.ts";

/** A logical scope, never a hostname or authentication credential. */
export const AMUX_V22_RECOVERY_HOST_SCOPE = "amux-ubuntu" as const;
export const AMUX_V22_TASK_RECOVERY_POLICY_VERSION = 36;
export const AMUX_V22_TASK_RECOVERY_ENABLED_ENV = "TOMVERSE_AMUX_V22_TASK_RECOVERY_ENABLED";
export const amuxV22TaskRecoveryEnabled = (value: string | undefined) => value === "true";
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/);
const revision = z.number().int().nonnegative().max(2_147_483_644);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const money = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= BigInt("9223372036854775807"));
const identity = { taskId: id, expectedRevision: revision, priorAttemptId: id,
  requestId: z.string().uuid() };
export const amuxV22RecoveryAdminSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request_inspection"), ...identity }).strict(),
  z.object({ action: z.literal("approve_attempt"), ...identity,
    inspectionId: z.string().uuid(), evidenceId: z.string().uuid(),
    evidenceDigest: digest, costDigest: digest }).strict(),
]);
export const amuxV22RecoveryWorkerSchema = z.object({ workerName: id }).strict();
export const amuxV22RecoveryEvidenceSchema = z.object({
  inspectionId: z.string().uuid(), evidenceId: z.string().uuid(),
  requestDigest: digest, taskId: id, taskRevision: revision,
  priorAttemptId: id, priorAttemptTaskRevision: revision, workerName: id, workerInstanceId: z.string().uuid(),
  workerGeneration: z.number().int().min(1).max(2_147_483_647),
  targetHost: z.literal(AMUX_V22_RECOVERY_HOST_SCOPE),
  hostInvocationId: z.string().regex(/^[a-f0-9]{32}$/).nullable(),
  proof: z.object({ terminalOutcome: z.enum(["succeeded", "failed", "blocked", "unknown"]),
    sameLiveInvocation: z.boolean(), noActiveExecution: z.boolean(),
    processTreeStopped: z.boolean(), rootOwnedUnit: z.boolean(),
    controlGroupBound: z.boolean(), journalBound: z.boolean(),
    socketTerminal: z.boolean(), externalEffectsKnown: z.boolean(),
    workspaceClean: z.boolean() }).strict(),
  usage: z.object({ status: z.enum(["reported_complete", "unknown"]),
    projectedCostMicroUsd: money.nullable() }).strict().refine((value) =>
      value.status !== "unknown" || value.projectedCostMicroUsd === null),
  reason: z.enum(["stopped_proven", "legacy_invocation_unbound",
    "inspection_unverified", "terminal_success"]),
}).strict();
export type AmuxV22RecoveryEvidenceInput = z.infer<typeof amuxV22RecoveryEvidenceSchema>;
export type AmuxV22RecoveryAdminInput = z.infer<typeof amuxV22RecoveryAdminSchema>;
export type AmuxV22RecoveryCost = { oldHeldMicroUsd: string;
  additionalCapMicroUsd: string; worstExposureMicroUsd: string;
  catalogApprovalId: string; catalogVersion: string; pricingVersion: string;
  costReceiptDigest: string; costDigest: string };
export type AmuxV22RecoveryRead = { taskId: string; requestId: string;
  state: "pending" | "unverified" | "verified" | "approved" | "not_visible";
  inspectionId: string | null; evidenceId: string | null;
  evidenceDigest: string | null; reason: string | null;
  taskRevision: number | null; priorAttemptId: string | null;
  /** Current observation, separate from the immutable approval revision. */
  currentTask?: { revision: number; status: string } | null;
  cost: AmuxV22RecoveryCost | null; approvalId?: string; retryWrite: false };
export const amuxV22RecoveryDigest = (kind: string, value: unknown) =>
  createHash("sha256").update(`amux-v22-task-recovery-${kind}-v1\n`)
    .update(amuxCanonicalJson(value)).digest("hex");

/** Unknown spend remains held; process or external-effect uncertainty does not. */
export function amuxV22RecoveryProofReason(input: AmuxV22RecoveryEvidenceInput,
  role: string) {
  if (input.proof.terminalOutcome === "succeeded") return "terminal_success";
  if (!input.hostInvocationId || !input.proof.sameLiveInvocation ||
      input.reason === "legacy_invocation_unbound") return "legacy_invocation_unbound";
  if (!input.proof.noActiveExecution || !input.proof.processTreeStopped ||
      !input.proof.rootOwnedUnit || !input.proof.controlGroupBound ||
      !input.proof.journalBound || !input.proof.socketTerminal ||
      input.reason !== "stopped_proven") return "inspection_unverified";
  if (!input.proof.externalEffectsKnown) return "external_effects_unknown";
  if (role === "implement" && !input.proof.workspaceClean) return "workspace_unverified";
  return null;
}

export function amuxV22RecoveryCost(input: { priorReservedMicroUsd: bigint;
  catalogApprovalId: string; receipt: V4TaskCostCeilingReceipt }): AmuxV22RecoveryCost {
  const amounts = input.receipt.routes.map((route) => BigInt(route.perAttemptMicroUsd));
  const cap = amounts.reduce((max, amount) => amount > max ? amount : max, BigInt(0));
  const worst = input.priorReservedMicroUsd + cap;
  if (input.priorReservedMicroUsd <= BigInt(0) || cap <= BigInt(0) ||
      worst > BigInt("9223372036854775807")) throw new Error("cost_unverified");
  const basis = { role: input.receipt.role, grade: input.receipt.grade,
    catalogVersion: input.receipt.catalogVersion, catalogDigest: input.receipt.catalogDigest,
    pricingVersion: input.receipt.pricingVersion, gradeRulesVersion: input.receipt.gradeRulesVersion,
    caps: input.receipt.caps, routes: input.receipt.routes, ceilingMicroUsd: input.receipt.ceilingMicroUsd };
  const cost = { oldHeldMicroUsd: input.priorReservedMicroUsd.toString(),
    additionalCapMicroUsd: cap.toString(), worstExposureMicroUsd: worst.toString(),
    catalogApprovalId: input.catalogApprovalId,
    catalogVersion: input.receipt.catalogVersion,
    pricingVersion: input.receipt.pricingVersion,
    costReceiptDigest: input.receipt.receiptDigest };
  return { ...cost, costDigest: amuxV22RecoveryDigest("cost", {
    oldHeldMicroUsd: cost.oldHeldMicroUsd, additionalCapMicroUsd: cost.additionalCapMicroUsd,
    catalogApprovalId: cost.catalogApprovalId, basis }) };
}

/** This authorization binds one exact next attempt; the generic ceiling still applies. */
export function amuxV22RecoveryStartAllowed(input: {
  approval: { taskId: string; afterRevision: number; historicalAttempts: number;
    nextAttemptNumber: number; oldHeldMicroUsd: bigint; additionalCapMicroUsd: bigint;
    catalogApprovalId: string; costDigest: string };
  taskId: string; assignmentRevision: number; historicalAttempts: number;
  nextAttemptNumber: number; priorReservedMicroUsd: bigint; assignedMicroUsd: bigint;
  catalogApprovalId: string; costDigest: string;
}) {
  const a = input.approval;
  return a.taskId === input.taskId && a.afterRevision === input.assignmentRevision &&
    a.historicalAttempts === input.historicalAttempts &&
    a.nextAttemptNumber === input.nextAttemptNumber &&
    a.oldHeldMicroUsd === input.priorReservedMicroUsd &&
    input.assignedMicroUsd > BigInt(0) && input.assignedMicroUsd <= a.additionalCapMicroUsd &&
    a.catalogApprovalId === input.catalogApprovalId && a.costDigest === input.costDigest;
}
