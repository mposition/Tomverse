import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { amuxCanonicalJson } from "./boardImportCore.ts";
import { checkV4TaskApprovedCeiling,
  type V4TaskCostCeilingReceipt } from "./v4TaskCostCeilingCore.ts";
import { AMUX_V22_READ_ONLY_RETRY_PROTOCOL_VERSION,
  AMUX_V22_READ_ONLY_LAUNCHER_POLICY_VERSION,
  amuxV22ReadOnlyLaunchScopeDigest as amuxV22CliReadOnlyLaunchScopeDigest } from
  "./v22ReadOnlyRetryProtocol.mjs";
import { AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
  AMUX_V22_READ_ONLY_API_EXECUTOR_KIND,
  AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
  AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST,
  amuxV22ReadOnlyApiExecutionFrameDigest,
  amuxV22ReadOnlyApiLaunchScopeDigest,
  matchAmuxV22ReadOnlyApiLaunchScopes,
  parseAmuxV22ReadOnlyApiExecutionFrame,
  type AmuxV22ReadOnlyApiExecutionFrame } from
  "./v22ReadOnlyApiProtocol.mjs";
export { AMUX_V22_READ_ONLY_LAUNCHER_POLICY_VERSION,
  AMUX_V22_READ_ONLY_ALLOWED_TOOLS, amuxV22ReadOnlyLauncherDigests,
  amuxV22ReadOnlyLaunchScope } from
  "./v22ReadOnlyRetryProtocol.mjs";

/** A logical scope, never a hostname or authentication credential. */
export const AMUX_V22_RECOVERY_HOST_SCOPE = "amux-ubuntu" as const;
export const AMUX_V22_TASK_RECOVERY_POLICY_VERSION = 42;
export const AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID =
  "c48886b9-86f8-4631-8db8-c0b288a707af" as const;
export const AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID =
  "97858395-3d66-42fa-9bfb-0e5a6cba39d8" as const;
export const AMUX_V22_UNKNOWN_PRIOR_HELD_MICROUSD = BigInt("3400000");
export const AMUX_V22_READ_ONLY_RETRY_CAP_MICROUSD = BigInt("3400000");
export const AMUX_V22_READ_ONLY_RETRY_EXPOSURE_MICROUSD = BigInt("6800000");
export const AMUX_V22_READ_ONLY_RETRY_TASK_ATTEMPT_LIMIT = 2;
export const AMUX_V22_READ_ONLY_LAUNCH_SCOPE_VERSION =
  AMUX_V22_READ_ONLY_RETRY_PROTOCOL_VERSION;
export const AMUX_V22_TASK_RECOVERY_ENABLED_ENV = "TOMVERSE_AMUX_V22_TASK_RECOVERY_ENABLED";
export const AMUX_V22_LEGACY_SAFE_STOP_ENABLED_ENV =
  "TOMVERSE_AMUX_V22_LEGACY_SAFE_STOP_ENABLED";
export const AMUX_V22_RECOVERY_CONTROLLER_SECRET_ENV =
  "TOMVERSE_AMUX_V22_RECOVERY_CONTROLLER_SECRET";
export const AMUX_V22_RECOVERY_INSPECTOR_SECRET_ENV =
  "TOMVERSE_AMUX_V22_RECOVERY_INSPECTOR_SECRET";
export const AMUX_V22_RECOVERY_PROFILES_ENV =
  "TOMVERSE_AMUX_V22_RECOVERY_PROFILES_JSON";
export const AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED_ENV =
  "TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED";
export const AMUX_V22_READ_ONLY_API_CREDENTIAL_PROFILE_ID_ENV =
  "TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_PROFILE_ID";
export const AMUX_V22_READ_ONLY_API_CREDENTIAL_METADATA_DIGEST_ENV =
  "TOMVERSE_AMUX_V22_READ_ONLY_API_CREDENTIAL_METADATA_DIGEST";
export const AMUX_V22_READ_ONLY_API_EXECUTOR_ARTIFACT_DIGEST_ENV =
  "TOMVERSE_AMUX_V22_READ_ONLY_API_EXECUTOR_ARTIFACT_DIGEST";
export const AMUX_V22_READ_ONLY_API_REPOSITORY_SCOPE_DIGEST_ENV =
  "TOMVERSE_AMUX_V22_READ_ONLY_API_REPOSITORY_SCOPE_DIGEST";
export const amuxV22TaskRecoveryEnabled = (value: string | undefined) => value === "true";
export const amuxV22LegacySafeStopEnabled = (value: string | undefined) => value === "true";
export const amuxV22ReadOnlyApiExecutorEnabled = (value: string | undefined) =>
  value === "true";
export const AMUX_V22_RECOVERY_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
export const AMUX_V22_RECOVERY_MAX_REVISION = 2_147_483_644;
const id = z.string().regex(AMUX_V22_RECOVERY_ID_PATTERN);
const revision = z.number().int().nonnegative().max(AMUX_V22_RECOVERY_MAX_REVISION);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const money = z.string().regex(/^(0|[1-9][0-9]{0,18})$/)
  .refine((value) => BigInt(value) <= BigInt("9223372036854775807"));
const identity = { taskId: id, expectedRevision: revision, priorAttemptId: id,
  requestId: z.string().uuid() };

export type AmuxV22ReadOnlyApiConfiguredMetadata = {
  credentialProfileId: string;
  credentialMetadataDigest: string;
  executorArtifactDigest: string;
  settingsDigest: string;
  repositoryScopeDigest: string;
  brokerPolicyDigest: string;
  toolSchemaDigest: string;
};

/** Non-secret expected identities only. Key bytes, paths and source bytes are
 * deliberately not accepted by this app-side contract. */
export function configuredAmuxV22ReadOnlyApiMetadata(
  env: NodeJS.ProcessEnv = process.env,
): AmuxV22ReadOnlyApiConfiguredMetadata | null {
  const credentialProfileId = env[AMUX_V22_READ_ONLY_API_CREDENTIAL_PROFILE_ID_ENV];
  const values = {
    credentialMetadataDigest:
      env[AMUX_V22_READ_ONLY_API_CREDENTIAL_METADATA_DIGEST_ENV],
    executorArtifactDigest:
      env[AMUX_V22_READ_ONLY_API_EXECUTOR_ARTIFACT_DIGEST_ENV],
    repositoryScopeDigest:
      env[AMUX_V22_READ_ONLY_API_REPOSITORY_SCOPE_DIGEST_ENV],
  };
  if (!credentialProfileId || !AMUX_V22_RECOVERY_ID_PATTERN.test(credentialProfileId) ||
      Object.values(values).some((value) => !value || !/^[a-f0-9]{64}$/.test(value))) {
    return null;
  }
  return { credentialProfileId,
    credentialMetadataDigest: values.credentialMetadataDigest!,
    executorArtifactDigest: values.executorArtifactDigest!,
    settingsDigest: AMUX_V22_READ_ONLY_API_SETTINGS_DIGEST,
    repositoryScopeDigest: values.repositoryScopeDigest!,
    brokerPolicyDigest: AMUX_V22_READ_ONLY_API_BROKER_POLICY_DIGEST,
    toolSchemaDigest: AMUX_V22_READ_ONLY_API_TOOL_SCHEMA_DIGEST };
}

/** Re-check the separately activated, non-secret runtime identities before an
 * approved frame can start or leave the app. Secret key material is never part
 * of this comparison. */
export function currentAmuxV22ReadOnlyApiExecutionFrame(
  raw: unknown,
  options: { now?: Date; env?: NodeJS.ProcessEnv } = {},
): AmuxV22ReadOnlyApiExecutionFrame | null {
  const env = options.env ?? process.env;
  if (!amuxV22ReadOnlyApiExecutorEnabled(
      env[AMUX_V22_READ_ONLY_API_EXECUTOR_ENABLED_ENV])) return null;
  const metadata = configuredAmuxV22ReadOnlyApiMetadata(env);
  if (!metadata) return null;
  try {
    const frame = parseAmuxV22ReadOnlyApiExecutionFrame(raw,
      { now: options.now });
    return Object.entries(metadata).every(([key, value]) =>
      frame[key as keyof AmuxV22ReadOnlyApiExecutionFrame] === value) ?
      frame : null;
  } catch { return null; }
}
export const amuxV22RecoveryAdminSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request_inspection"), ...identity }).strict(),
  z.object({ action: z.literal("accept_unknown_prior_effects"), ...identity,
    taskId: z.literal(AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID),
    priorAttemptId: z.literal(AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID),
    sourceEvidenceId: z.string().uuid(), sourceEvidenceDigest: digest,
    acceptRisk: z.literal(true) }).strict(),
  z.object({ action: z.literal("request_safe_stop"), ...identity,
    sourceEvidenceId: z.string().uuid(), sourceEvidenceDigest: digest }).strict(),
  z.object({ action: z.literal("approve_attempt"), ...identity,
    inspectionId: z.string().uuid(), evidenceId: z.string().uuid(),
    evidenceDigest: digest, costDigest: digest,
    riskAcceptanceId: z.string().uuid().optional(), riskAcceptanceDigest: digest.optional(),
    launchProofId: z.string().uuid().optional(), launchProofDigest: digest.optional(),
    acceptRetry: z.literal(true).optional() }).strict().superRefine((value, context) => {
      const fields = [value.riskAcceptanceId, value.riskAcceptanceDigest,
        value.launchProofId, value.launchProofDigest, value.acceptRetry];
      if (fields.some((field) => field !== undefined) &&
          fields.some((field) => field === undefined))
        context.addIssue({ code: "custom", message: "retry acceptance binding must be complete" });
    }),
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
const amuxV22CliReadOnlyLaunchScopeSchema = z.object({
  version: z.literal(AMUX_V22_READ_ONLY_LAUNCH_SCOPE_VERSION),
  launcherPolicyVersion: z.literal(AMUX_V22_READ_ONLY_LAUNCHER_POLICY_VERSION),
  launcherConfigDigest: digest, fixedArgvDigest: digest, toolPolicyDigest: digest,
  profileConfigDigest: digest, role: z.literal("investigate"),
  allowedTools: z.tuple([z.literal("Glob"), z.literal("Grep"), z.literal("Read")]),
}).strict();
const amuxV22ApiReadOnlyLaunchScopeSchema = z.object({
  version: z.literal(1), executorKind: z.literal(AMUX_V22_READ_ONLY_API_EXECUTOR_KIND),
  launcherConfigDigest: digest, apiExecutionFrameDigest: digest,
}).strict();
export const amuxV22ReadOnlyLaunchScopeSchema = z.union([
  amuxV22CliReadOnlyLaunchScopeSchema, amuxV22ApiReadOnlyLaunchScopeSchema,
]);
const amuxV22ReadOnlyApiExecutionFrameSchema = z.custom<AmuxV22ReadOnlyApiExecutionFrame>(
  (value) => {
    try { parseAmuxV22ReadOnlyApiExecutionFrame(value); return true; }
    catch { return false; }
  }, "read_only_api_frame_invalid");
const readOnlyLaunchBinding = {
  requestKind: z.literal("read_only_launch_check"), launchCheckId: z.string().uuid(),
  requestDigest: digest, taskId: z.literal(AMUX_V22_UNKNOWN_PRIOR_RISK_TASK_ID),
  taskRevision: revision, priorAttemptId: z.literal(AMUX_V22_UNKNOWN_PRIOR_RISK_ATTEMPT_ID),
  workerName: id, workerInstanceId: z.string().uuid(),
  workerGeneration: z.number().int().min(1).max(2_147_483_647),
  targetHost: z.literal(AMUX_V22_RECOVERY_HOST_SCOPE),
  sourceEvidenceId: z.string().uuid(), sourceEvidenceDigest: digest,
  riskAcceptanceId: z.string().uuid(), riskAcceptanceDigest: digest,
  launchBindingId: z.string().uuid(), briefDigest: digest,
  provider: id, modelId: z.string().min(1).max(160), routeId: id,
  routePolicyDigest: digest, catalogApprovalId: id,
  catalogVersion: z.string().min(1).max(128), pricingVersion: z.string().min(1).max(128),
  costReceiptDigest: digest,
  additionalCapMicroUsd: money.refine((value) =>
    BigInt(value) <= AMUX_V22_READ_ONLY_RETRY_CAP_MICROUSD),
  worstExposureMicroUsd: money.refine((value) =>
    BigInt(value) <= AMUX_V22_READ_ONLY_RETRY_EXPOSURE_MICROUSD),
  launchScope: amuxV22ReadOnlyLaunchScopeSchema,
  apiExecutionFrame: amuxV22ReadOnlyApiExecutionFrameSchema.optional(),
};
function validateReadOnlyApiFrameBinding(value: {
  launchScope: z.infer<typeof amuxV22ReadOnlyLaunchScopeSchema>;
  apiExecutionFrame?: AmuxV22ReadOnlyApiExecutionFrame;
}, context: z.RefinementCtx) {
  if ("executorKind" in value.launchScope) {
    if (!value.apiExecutionFrame ||
        value.launchScope.apiExecutionFrameDigest !==
          amuxV22ReadOnlyApiExecutionFrameDigest(value.apiExecutionFrame)) {
      context.addIssue({ code: "custom", message: "read_only_api_frame_invalid" });
    }
  } else if (value.apiExecutionFrame !== undefined) {
    context.addIssue({ code: "custom", message: "read_only_api_frame_invalid" });
  }
}
export const amuxV22ReadOnlyLaunchCheckSchema = z.object(readOnlyLaunchBinding).strict()
  .superRefine(validateReadOnlyApiFrameBinding);
export const amuxV22ReadOnlyLaunchProofSchema = z.object({
  ...readOnlyLaunchBinding, launchProofId: z.string().uuid(),
  observation: z.enum(["current", "worker_identity_changed",
    "launcher_config_mismatch", "profile_config_mismatch", "scope_mismatch"]),
}).strict().superRefine(validateReadOnlyApiFrameBinding);
export function amuxV22ReadOnlyLaunchProofScope(value: unknown) {
  const parsed = amuxV22ReadOnlyLaunchProofSchema.safeParse(value);
  if (!parsed.success) return null;
  return { report: parsed.data, launchScope: parsed.data.launchScope,
    launchScopeDigest: amuxV22ReadOnlyLaunchScopeDigest(parsed.data.launchScope) };
}
export function amuxV22ReadOnlyLaunchScopeMatchesIntent(nominal: unknown, actual: unknown) {
  const expected = amuxV22ReadOnlyLaunchScopeSchema.safeParse(nominal);
  const observed = amuxV22ReadOnlyLaunchScopeSchema.safeParse(actual);
  if (!expected.success || !observed.success) return false;
  if ("executorKind" in expected.data || "executorKind" in observed.data)
    return matchAmuxV22ReadOnlyApiLaunchScopes(expected.data, observed.data);
  return amuxCanonicalJson(expected.data) === amuxCanonicalJson({ ...observed.data,
    launcherConfigDigest: expected.data.launcherConfigDigest });
}
export function amuxV22ReadOnlyLaunchScopeDigest(scope: unknown) {
  const parsed = amuxV22ReadOnlyLaunchScopeSchema.parse(scope);
  return "executorKind" in parsed ? amuxV22ReadOnlyApiLaunchScopeDigest(parsed) :
    amuxV22CliReadOnlyLaunchScopeDigest(parsed);
}
export function amuxV22ReadOnlyLaunchExecutorKind(scope: unknown) {
  const parsed = amuxV22ReadOnlyLaunchScopeSchema.safeParse(scope);
  if (!parsed.success) return null;
  return "executorKind" in parsed.data ? parsed.data.executorKind : "read_only_retry_v1";
}
export const amuxV22RecoveryControllerReportSchema = z.discriminatedUnion("requestKind", [
  amuxV22SafeStopEvidenceSchema, amuxV22ReadOnlyLaunchProofSchema,
]);
export type AmuxV22ReadOnlyLaunchCheck = z.infer<typeof amuxV22ReadOnlyLaunchCheckSchema>;
export type AmuxV22ReadOnlyLaunchProofInput = z.infer<typeof amuxV22ReadOnlyLaunchProofSchema>;
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
  cost: AmuxV22RecoveryCost | null; quote: AmuxV22RecoveryCost | null;
  riskAcceptance: null | { id: string; digest: string; ownerRequestId: string;
    sourceEvidenceId: string; sourceEvidenceDigest: string; acceptedAt: string;
    oldHeldMicroUsd: string; additionalCapMicroUsd: string;
    worstExposureMicroUsd: string; executionStarted: false; reservationCreated: false };
  launchProof: null | { id: string; digest: string; launchBindingId: string;
    state: "current" | "stale" | "mismatch"; workerName: string;
    provider: string; modelId: string; routeId: string; role: "investigate";
    briefDigest: string; pricingVersion: string; costReceiptDigest: string;
    launchScopeVersion: 1 };
  apiModelAccess?: { state: "required" | "verified" | "stale" |
      "unavailable" | "unknown" | "catalog_mismatch";
    selectedModelId: string; canonicalModelId: string | null;
    balanceKnown: false; maximumCostMicroUsd: "3400000";
    worstExposureMicroUsd: "6800000"; recordedAt: string | null };
  eligibility: { acceptUnknownPriorEffects: boolean; requestSafeStop: boolean;
    approveAttempt: boolean; reason: null | "exact_target_only" |
      "risk_acceptance_required" | "safe_stop_required" | "safe_stop_stale" |
      "launch_proof_required" | "launch_proof_stale" | "binding_changed" |
      "api_model_access_required" | "api_model_access_stale" |
      "api_model_access_unverified" | "canonical_catalog_approval_required" |
      "already_approved" };
  guards: { priorEffects: "unknown"; oldCost: "held";
    readOnlyLaunch: "required"; taskAttemptLimit: 2 };
  approvalId?: string; retryWrite: false };
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

export function amuxV22ReadOnlyRetryRouteCost(input: {
  priorReservedMicroUsd: bigint; catalogApprovalId: string;
  receipt: V4TaskCostCeilingReceipt; routeId: string; workerName: string;
  provider: string; modelId: string;
}): AmuxV22RecoveryCost {
  const route = input.receipt.routes.find((candidate) =>
    candidate.routeId === input.routeId && candidate.workerName === input.workerName &&
    candidate.provider === input.provider && candidate.modelId === input.modelId);
  if (!route || input.priorReservedMicroUsd !== AMUX_V22_UNKNOWN_PRIOR_HELD_MICROUSD)
    throw new Error("cost_unverified");
  const cap = BigInt(route.perAttemptMicroUsd);
  const worst = input.priorReservedMicroUsd + cap;
  if (cap <= BigInt(0) || cap > AMUX_V22_READ_ONLY_RETRY_CAP_MICROUSD ||
      worst > AMUX_V22_READ_ONLY_RETRY_EXPOSURE_MICROUSD)
    throw new Error("cost_unverified");
  const cost = { oldHeldMicroUsd: input.priorReservedMicroUsd.toString(),
    additionalCapMicroUsd: cap.toString(), worstExposureMicroUsd: worst.toString(),
    catalogApprovalId: input.catalogApprovalId,
    catalogVersion: input.receipt.catalogVersion,
    pricingVersion: input.receipt.pricingVersion,
    costReceiptDigest: input.receipt.receiptDigest };
  return { ...cost, costDigest: amuxV22RecoveryDigest("read-only-route-cost", {
    ...cost, routeId: route.routeId, workerName: route.workerName,
    provider: route.provider, modelId: route.modelId,
    routePolicyDigest: route.routePolicyDigest, perAttemptMicroUsd: route.perAttemptMicroUsd }) };
}

/** Policy v48. The FIRST Task read-only retry can only run on a route its v4
 * catalog added after the Task was registered, and an added route alone makes
 * the generic check ask for a cost reconfirmation. The owner's final consent
 * binds that exact route, model and cap, so it stands in for that
 * reconfirmation. Only the added route is excused: with the added routes left
 * out the Task must still pass the generic check unchanged, so a changed or
 * removed existing route, raised token bounds or a raised ceiling still refuse,
 * and the selected route must be one the current catalog actually lists. */
export function amuxV22RecoveryAddedRouteConsented(approved: unknown,
  current: V4TaskCostCeilingReceipt, selectedRouteId: string) {
  const whole = checkV4TaskApprovedCeiling(approved, { ok: true, receipt: current });
  if (whole.decision === "allow") return true;
  if (whole.decision !== "reconfirm" || whole.reason !== "task_route_changed" ||
      !approved || typeof approved !== "object" ||
      !Array.isArray((approved as { routes?: unknown }).routes) ||
      !current.routes.some((route) => route.routeId === selectedRouteId)) return false;
  const approvedIds = new Set(((approved as { routes: { routeId?: unknown }[] }).routes)
    .map((route) => route.routeId));
  if (approvedIds.has(selectedRouteId)) return false;
  const existing = current.routes.filter((route) => approvedIds.has(route.routeId));
  if (!existing.length) return false;
  return checkV4TaskApprovedCeiling(approved, { ok: true,
    receipt: { ...current, routes: existing } }).decision === "allow";
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
