import { activeManifestHashKey } from "@/lib/manifestHashKeyring";
import { dispatchInstrumentationMode } from "@/lib/routingInstrumentationMode";
import {
  AUTO_ROUTER_LIMITED_RELEASE_APPROVAL,
  type AutoRouterLimitedReleaseApprovalRecord,
  type AutoRouterLimitedReleasePlan,
} from "@/lib/autoRouterLimitedReleaseApproval";

export const AUTO_ROUTER_LIMITED_RELEASE_SELECTOR_ENV =
  "AUTO_ROUTER_LIMITED_RELEASE_EXCEPTION";
export const AUTO_ROUTER_LIMITED_RELEASE_COMMIT_ENV =
  "AUTO_ROUTER_LIMITED_RELEASE_COMMIT";
export const AUTO_ROUTER_LIMITED_RELEASE_SELECTOR_VALUE = "v1";

const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APPROVED_PLANS = new Set<AutoRouterLimitedReleasePlan>([
  "Free",
  "Pro",
  "Max",
]);
const EXPECTED_PENDING_GATES = [
  "shadow_report",
  "offline_quality_evaluation",
  "attempt_manifest_boundary",
] as const;

export type AutoRouterLimitedReleaseRefusal =
  | "selector_off"
  | "approval_pending"
  | "approval_invalid"
  | "approval_expired"
  | "target_environment_mismatch"
  | "target_service_mismatch"
  | "serving_commit_mismatch"
  | "instrumentation_not_enforce"
  | "manifest_keyring_unavailable"
  | "fallback_enabled"
  | "rollout_disabled"
  | "rollout_percent_exceeds_approval"
  | "eligible_plans_mismatch";

export type AutoRouterLimitedReleaseAdmission =
  | Readonly<{
      admitted: true;
      exceptionId: AutoRouterLimitedReleaseApprovalRecord["exceptionId"];
      version: AutoRouterLimitedReleaseApprovalRecord["version"];
      evidenceRef: string;
      approvedBy: string;
      approvedAt: string;
      expiresAt: string;
      evaluatedImplementationCommit: string;
      servingCommitSha: string;
      targetEnvironmentId: string;
      targetServiceId: string;
      rolloutPercent: number;
      eligiblePlans: readonly AutoRouterLimitedReleasePlan[];
    }>
  | Readonly<{ admitted: false; reason: AutoRouterLimitedReleaseRefusal }>;

const nonempty = (value: string | null): value is string =>
  typeof value === "string" && value.trim().length > 0;

const sameStringSet = (left: readonly string[], right: readonly string[]) => {
  if (left.length !== right.length || new Set(left).size !== left.length ||
      new Set(right).size !== right.length) return false;
  const expected = new Set(right);
  return left.every((value) => expected.has(value));
};

/** Every reason a checked-in approval record is not an activation authority. */
export function autoRouterLimitedReleaseApprovalProblems(
  record: AutoRouterLimitedReleaseApprovalRecord =
    AUTO_ROUTER_LIMITED_RELEASE_APPROVAL,
  now: () => number = Date.now,
): readonly string[] {
  const problems: string[] = [];
  if (record.version !== "auto-router-limited-release-approval-v1") {
    problems.push("approval version is invalid");
  }
  if (record.exceptionId !== "CHAT-01-AUTO-ROUTER-LIMITED-RELEASE-V1") {
    problems.push("exceptionId is invalid");
  }
  if (record.workId !== "CHAT-01") problems.push("workId is invalid");
  if (record.status !== "approved") problems.push("approval is pending");
  if (!nonempty(record.approvedBy)) problems.push("approvedBy is missing");
  const approvedAt = Date.parse(record.approvedAt ?? "");
  if (!Number.isFinite(approvedAt) || approvedAt > now()) {
    problems.push("approvedAt is missing, invalid, or in the future");
  }
  if (!SHA.test(record.policyCommit ?? "")) problems.push("policyCommit is invalid");
  if (!SHA256.test(record.policySha256 ?? "")) problems.push("policySha256 is invalid");
  if (!SHA.test(record.evaluatedImplementationCommit ?? "")) {
    problems.push("evaluatedImplementationCommit is invalid");
  }
  if (!nonempty(record.targetEnvironmentName)) {
    problems.push("targetEnvironmentName is missing");
  }
  if (!UUID.test(record.targetEnvironmentId ?? "")) {
    problems.push("targetEnvironmentId is invalid");
  }
  if (!UUID.test(record.targetServiceId ?? "")) {
    problems.push("targetServiceId is invalid");
  }
  if (record.maxRolloutPercent === null ||
      !Number.isFinite(record.maxRolloutPercent) ||
      record.maxRolloutPercent <= 0 || record.maxRolloutPercent > 100) {
    problems.push("maxRolloutPercent must be above 0 and at most 100");
  }
  if (record.eligiblePlans.length === 0 ||
      new Set(record.eligiblePlans).size !== record.eligiblePlans.length ||
      record.eligiblePlans.some((plan) => !APPROVED_PLANS.has(plan))) {
    problems.push("eligiblePlans must be a non-empty unique list of account plans");
  }
  const expiresAt = Date.parse(record.expiresAt ?? "");
  if (!Number.isFinite(expiresAt) || expiresAt <= now()) {
    problems.push("expiresAt is missing, invalid, or expired");
  }
  if (!nonempty(record.evidenceRef)) problems.push("evidenceRef is missing");
  if (!nonempty(record.knownLimitations)) problems.push("knownLimitations is missing");
  if (!sameStringSet(record.unmetReadinessGates, EXPECTED_PENDING_GATES)) {
    problems.push("unmetReadinessGates must name the three still-pending gates");
  }
  if (record.requiredDispatchInstrumentation !== "enforce") {
    problems.push("dispatch instrumentation must be enforce");
  }
  if (record.fallbackEnabled !== false ||
      record.maxProviderDispatchesPerLogicalResponse !== 1 ||
      record.additionalProviderDispatchesPerLogicalResponse !== 0) {
    problems.push("limited release must keep automatic fallback off");
  }
  if (record.costAuthority !==
      "existing_chat_entitlement_and_provider_guardrails_only") {
    problems.push("cost authority is invalid");
  }
  if (record.activationAuthority !== "operator_runtime_selector") {
    problems.push("activationAuthority is not granted");
  }
  if (record.paidDispatchAuthority !== "existing_chat_request_only") {
    problems.push("paidDispatchAuthority is not granted");
  }
  return problems;
}

const runtimePlans = (
  environment: Record<string, string | undefined>,
): readonly string[] => (environment.AUTO_ROUTER_ELIGIBLE_PLANS ?? "")
  .split(",")
  .map((plan) => plan.trim())
  .filter(Boolean);

/**
 * Resolves the narrow readiness exception. It does not decide a cohort: the
 * ordinary plan, bucket, guest and kill-switch checks still run afterwards.
 */
export function resolveAutoRouterLimitedRelease(input: {
  environment?: Record<string, string | undefined>;
  approval?: AutoRouterLimitedReleaseApprovalRecord;
  now?: () => number;
} = {}): AutoRouterLimitedReleaseAdmission {
  const environment = input.environment ?? process.env;
  const approval = input.approval ?? AUTO_ROUTER_LIMITED_RELEASE_APPROVAL;
  const now = input.now ?? Date.now;

  if (environment[AUTO_ROUTER_LIMITED_RELEASE_SELECTOR_ENV] !==
      AUTO_ROUTER_LIMITED_RELEASE_SELECTOR_VALUE) {
    return Object.freeze({ admitted: false, reason: "selector_off" });
  }
  if (approval.status !== "approved") {
    return Object.freeze({ admitted: false, reason: "approval_pending" });
  }
  const approvalProblems = autoRouterLimitedReleaseApprovalProblems(approval, now);
  if (approvalProblems.some((problem) => problem.startsWith("expiresAt"))) {
    return Object.freeze({ admitted: false, reason: "approval_expired" });
  }
  if (approvalProblems.length !== 0) {
    return Object.freeze({ admitted: false, reason: "approval_invalid" });
  }
  if (environment.RAILWAY_ENVIRONMENT_NAME !== approval.targetEnvironmentName ||
      environment.RAILWAY_ENVIRONMENT_ID?.toLowerCase() !==
        approval.targetEnvironmentId!.toLowerCase()) {
    return Object.freeze({ admitted: false, reason: "target_environment_mismatch" });
  }
  if (environment.RAILWAY_SERVICE_ID?.toLowerCase() !==
      approval.targetServiceId!.toLowerCase()) {
    return Object.freeze({ admitted: false, reason: "target_service_mismatch" });
  }
  const servingCommit = environment.RAILWAY_GIT_COMMIT_SHA?.trim().toLowerCase();
  const approvedServingCommit = environment[
    AUTO_ROUTER_LIMITED_RELEASE_COMMIT_ENV
  ]?.trim().toLowerCase();
  if (!SHA.test(servingCommit ?? "") || !SHA.test(approvedServingCommit ?? "") ||
      servingCommit !== approvedServingCommit) {
    return Object.freeze({ admitted: false, reason: "serving_commit_mismatch" });
  }
  if (dispatchInstrumentationMode(environment) !== "enforce") {
    return Object.freeze({ admitted: false, reason: "instrumentation_not_enforce" });
  }
  try {
    activeManifestHashKey(environment);
  } catch {
    return Object.freeze({ admitted: false, reason: "manifest_keyring_unavailable" });
  }
  if (environment.AUTO_ROUTER_FALLBACK_ENABLED === "on") {
    return Object.freeze({ admitted: false, reason: "fallback_enabled" });
  }
  const rolloutPercent = Number(environment.AUTO_ROUTER_ROLLOUT_PERCENT);
  const plans = runtimePlans(environment);
  if (!Number.isFinite(rolloutPercent) || rolloutPercent <= 0 ||
      rolloutPercent > 100 || plans.length === 0 ||
      !nonempty(environment.AUTO_ROUTER_COHORT_SALT ?? null) ||
      environment.AUTO_ROUTER_COHORT_SALT === "unset") {
    return Object.freeze({ admitted: false, reason: "rollout_disabled" });
  }
  if (rolloutPercent > approval.maxRolloutPercent!) {
    return Object.freeze({
      admitted: false,
      reason: "rollout_percent_exceeds_approval",
    });
  }
  if (!sameStringSet(plans, approval.eligiblePlans)) {
    return Object.freeze({ admitted: false, reason: "eligible_plans_mismatch" });
  }

  return Object.freeze({
    admitted: true,
    exceptionId: approval.exceptionId,
    version: approval.version,
    evidenceRef: approval.evidenceRef!,
    approvedBy: approval.approvedBy!,
    approvedAt: approval.approvedAt!,
    expiresAt: approval.expiresAt!,
    evaluatedImplementationCommit: approval.evaluatedImplementationCommit!,
    servingCommitSha: servingCommit!,
    targetEnvironmentId: approval.targetEnvironmentId!,
    targetServiceId: approval.targetServiceId!,
    rolloutPercent,
    eligiblePlans: Object.freeze([...approval.eligiblePlans]),
  });
}
