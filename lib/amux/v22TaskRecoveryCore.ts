import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import type { V4TaskCostCeilingReceipt } from "./v4TaskCostCeilingCore.ts";

/** A logical scope, never a hostname or authentication credential. */
export const AMUX_V22_RECOVERY_HOST_SCOPE = "amux-ubuntu" as const;
export const AMUX_V22_TASK_RECOVERY_POLICY_VERSION = 37;
export const AMUX_V22_TASK_RECOVERY_ENABLED_ENV = "TOMVERSE_AMUX_V22_TASK_RECOVERY_ENABLED";
export const AMUX_V22_LEGACY_SAFE_STOP_ENABLED_ENV =
  "TOMVERSE_AMUX_V22_LEGACY_SAFE_STOP_ENABLED";
export const AMUX_V22_RECOVERY_CONTROLLER_SECRET_ENV =
  "TOMVERSE_AMUX_V22_RECOVERY_CONTROLLER_SECRET";
export const AMUX_V22_RECOVERY_INSPECTOR_SECRET_ENV =
  "TOMVERSE_AMUX_V22_RECOVERY_INSPECTOR_SECRET";
export const AMUX_V22_RECOVERY_PROFILES_ENV =
  "TOMVERSE_AMUX_V22_RECOVERY_PROFILES_JSON";
export const amuxV22TaskRecoveryEnabled = (value: string | undefined) => value === "true";
export const amuxV22LegacySafeStopEnabled = (value: string | undefined) => value === "true";
export const AMUX_V22_RECOVERY_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
export const AMUX_V22_RECOVERY_MAX_REVISION = 2_147_483_644;
const id = z.string().regex(AMUX_V22_RECOVERY_ID_PATTERN);
const revision = z.number().int().nonnegative().max(AMUX_V22_RECOVERY_MAX_REVISION);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const money = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= BigInt("9223372036854775807"));
const identity = { taskId: id, expectedRevision: revision, priorAttemptId: id,
  requestId: z.string().uuid() };
export const amuxV22RecoveryAdminSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request_inspection"), ...identity }).strict(),
  z.object({ action: z.literal("request_safe_stop"), ...identity,
    sourceEvidenceId: z.string().uuid(), sourceEvidenceDigest: digest }).strict(),
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
const profileAlias = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const recoveryProfileConfigSchema = z.object({
  version: z.literal(1),
  profiles: z.array(z.object({ alias: profileAlias,
    workerNames: z.array(profileAlias).min(1).max(16) }).strict()).min(1).max(128),
}).strict().superRefine((value, context) => {
  const aliases = new Set<string>();
  const workers = new Set<string>();
  if (value.profiles.some((profile, index) => index > 0 &&
      value.profiles[index - 1]!.alias >= profile.alias)) {
    context.addIssue({ code: "custom", message: "profiles must be sorted and unique" });
  }
  for (const profile of value.profiles) {
    if (aliases.has(profile.alias)) context.addIssue({ code: "custom",
      message: "profile aliases must be unique" });
    aliases.add(profile.alias);
    if (profile.workerNames.some((worker, index) => index > 0 &&
        profile.workerNames[index - 1]! >= worker)) {
      context.addIssue({ code: "custom", message: "worker names must be sorted and unique" });
    }
    for (const worker of profile.workerNames) {
      if (workers.has(worker)) context.addIssue({ code: "custom",
        message: "each worker must belong to exactly one profile" });
      workers.add(worker);
    }
  }
});
export type AmuxV22RecoveryProfileConfig = z.infer<typeof recoveryProfileConfigSchema>;
export type AmuxV22RecoveryProfile = AmuxV22RecoveryProfileConfig["profiles"][number] & {
  targetUnit: string; profileConfigDigest: string;
};
export function configuredAmuxV22RecoveryProfiles(raw =
  process.env[AMUX_V22_RECOVERY_PROFILES_ENV]): {
    config: AmuxV22RecoveryProfileConfig; profileConfigDigest: string;
  } | null {
  if (!raw?.trim()) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { return null; }
  const parsed = recoveryProfileConfigSchema.safeParse(decoded);
  if (!parsed.success) return null;
  return { config: parsed.data,
    profileConfigDigest: amuxV22RecoveryDigest("worker-profile-config", parsed.data) };
}
export function configuredAmuxV22RecoveryProfile(workerName: string,
  raw = process.env[AMUX_V22_RECOVERY_PROFILES_ENV]): AmuxV22RecoveryProfile | null {
  const configured = configuredAmuxV22RecoveryProfiles(raw);
  const profile = configured?.config.profiles.find((item) =>
    item.workerNames.includes(workerName));
  if (!configured || !profile) return null;
  return { ...profile,
    targetUnit: `tomverse-amux-v22-sidecar@${profile.alias}.service`,
    profileConfigDigest: configured.profileConfigDigest };
}
const stopProofSchema = z.object({
  journalBindingDigest: digest, journalEntryDigest: digest,
  journalDisposition: z.enum(["intent_recorded", "intent_reused", "not_needed_already_gone"]),
  stopAcknowledgement: z.enum(["acknowledged", "outcome_unknown", "not_issued"]),
  processState: z.enum(["gone", "present", "unknown"]),
  fixedUnit: z.boolean(), rootOwnedConfig: z.boolean(), profileUnique: z.boolean(),
  noOtherWork: z.boolean(), restartDisabled: z.boolean(), journalBound: z.boolean(),
  mainPidAbsent: z.boolean(), controlGroupEmpty: z.boolean(), kernelProofFresh: z.boolean(),
}).strict().superRefine((value, context) => {
  const valid = value.journalDisposition === "not_needed_already_gone" ?
    value.stopAcknowledgement === "not_issued" :
    value.stopAcknowledgement === "acknowledged" || value.stopAcknowledgement === "outcome_unknown";
  if (!valid) context.addIssue({ code: "custom", message: "stop acknowledgement is not journal-bound" });
});
export const amuxV22SafeStopEvidenceSchema = z.object({
  inspectionId: z.string().uuid(), evidenceId: z.string().uuid(),
  requestKind: z.literal("safe_stop"), requestDigest: digest,
  taskId: id, taskRevision: revision, priorAttemptId: id,
  priorAttemptTaskRevision: revision, workerName: id,
  workerInstanceId: z.string().uuid(),
  workerGeneration: z.number().int().min(1).max(2_147_483_647),
  targetHost: z.literal(AMUX_V22_RECOVERY_HOST_SCOPE),
  sourceEvidenceId: z.string().uuid(), sourceEvidenceDigest: digest,
  workerProfileAlias: profileAlias,
  profileWorkerNames: z.array(profileAlias).min(1).max(16),
  targetUnit: z.string().min(1).max(128), profileConfigDigest: digest,
  hostInvocationId: z.null(), modelOutcome: z.literal("unknown"),
  stopProof: stopProofSchema,
  usage: z.object({ status: z.literal("unknown"), projectedCostMicroUsd: z.null() }).strict(),
  reason: z.enum(["safe_stop_process_gone", "safe_stop_identity_changed",
    "safe_stop_config_unverified", "safe_stop_profile_not_unique",
    "safe_stop_other_work_present", "safe_stop_journal_unverified",
    "safe_stop_process_present", "safe_stop_process_unknown",
    "safe_stop_kernel_proof_stale"]),
}).strict();
export type AmuxV22RecoveryEvidenceInput = z.infer<typeof amuxV22RecoveryEvidenceSchema>;
export type AmuxV22SafeStopEvidenceInput = z.infer<typeof amuxV22SafeStopEvidenceSchema>;
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
  requestKind?: "inspect" | "safe_stop"; sourceEvidenceId?: string | null;
  sourceEvidenceDigest?: string | null;
  stopAcknowledgement?: "acknowledged" | "outcome_unknown" | "not_issued" | null;
  processState?: "gone" | "present" | "unknown" | null;
  workerProfileAlias?: string | null; profileWorkerNames?: string[];
  targetUnit?: string | null; profileConfigDigest?: string | null;
  /** Current observation, separate from the immutable approval revision. */
  currentTask?: { revision: number; status: string } | null;
  cost: AmuxV22RecoveryCost | null; approvalId?: string; retryWrite: false };
export const amuxV22RecoveryDigest = (kind: string, value: unknown) =>
  createHash("sha256").update(`amux-v22-task-recovery-${kind}-v1\n`)
    .update(amuxCanonicalJson(value)).digest("hex");

export function isAmuxV22RecoveryControllerAuthorized(request: Request,
  env: NodeJS.ProcessEnv = process.env) {
  const configured = env[AMUX_V22_RECOVERY_CONTROLLER_SECRET_ENV] ?? "";
  const broad = env.TOMVERSE_AMUX_SYNC_SECRET ?? "";
  const inspector = env[AMUX_V22_RECOVERY_INSPECTOR_SECRET_ENV] ?? "";
  if (configured.length < 32 || configured === broad || configured === inspector) return false;
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!provided) return false;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(configured), hash(provided));
}

export function isAmuxV22RecoveryInspectorAuthorized(request: Request,
  env: NodeJS.ProcessEnv = process.env) {
  const configured = env[AMUX_V22_RECOVERY_INSPECTOR_SECRET_ENV] ?? "";
  const broad = env.TOMVERSE_AMUX_SYNC_SECRET ?? "";
  const controller = env[AMUX_V22_RECOVERY_CONTROLLER_SECRET_ENV] ?? "";
  if (configured.length < 32 || configured === broad || configured === controller) return false;
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  if (!provided) return false;
  const hash = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(hash(configured), hash(provided));
}

export function amuxV22SafeStopJournalBinding(input: {
  taskId: string; priorAttemptId: string; workerProfileAlias: string; targetUnit: string;
}) {
  return amuxV22RecoveryDigest("stop-journal-binding", {
    taskId: input.taskId, priorAttemptId: input.priorAttemptId,
    workerProfileAlias: input.workerProfileAlias, targetUnit: input.targetUnit,
  });
}

export function amuxV22SafeStopProofReason(input: AmuxV22SafeStopEvidenceInput) {
  const proof = input.stopProof;
  if (!proof.fixedUnit || !proof.rootOwnedConfig || !proof.restartDisabled)
    return "safe_stop_config_unverified" as const;
  if (!proof.profileUnique) return "safe_stop_profile_not_unique" as const;
  if (!proof.noOtherWork) return "safe_stop_other_work_present" as const;
  if (!proof.journalBound) return "safe_stop_journal_unverified" as const;
  if (proof.processState === "present") return "safe_stop_process_present" as const;
  if (proof.processState === "unknown") return "safe_stop_process_unknown" as const;
  if (!proof.mainPidAbsent || !proof.controlGroupEmpty || !proof.kernelProofFresh)
    return "safe_stop_kernel_proof_stale" as const;
  return null;
}

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
