/** Strict owner observations. No free text or user content enters the audit. */
export const AMUX_V22_OUTCOME_ACTION = "amux.v22.task.outcome_observed";
export const AMUX_V22_OUTCOME_TARGET = "AmuxWorkItem";
export const AMUX_V22_OUTCOME_WRITE_CODE_LATCH = false;
export const AMUX_V22_OUTCOME_WRITE_ENV = "TOMVERSE_AMUX_V22_OUTCOME_WRITE";
export const amuxV22OutcomeWriteEnabled = (value: string | undefined) =>
  AMUX_V22_OUTCOME_WRITE_CODE_LATCH && value === "enabled";

export function classifyAmuxV22OutcomeError(code: string | undefined) {
  if (code === "task_state_changed" || code === "owner_decision_missing")
    return "stale" as const;
  if (code === "request_id_conflict") return "conflict" as const;
  return "unavailable" as const;
}

export type AmuxV22ObservationKind = "checks" | "independent_review" |
  "post_deploy_regression" | "user_outcome" | "estimate_revision";
export type AmuxV22Observation = {
  kind: AmuxV22ObservationKind;
  outcome: "passed" | "failed" | "none_observed" | "regression_observed" |
    "met" | "mixed" | "not_met" | "revised";
  evidenceDigest: string | null;
  findingCount: number | null;
  revisedEffortPoints: number | null;
  revisedCostMicrousd: string | null;
  reasonCode: "scope_changed" | "actual_usage" | "quality_findings" |
    "capacity_changed" | null;
  observedAt: string;
};

const ID = /^[A-Za-z0-9_-]{1,80}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const exactKeys = (input: Record<string, unknown>, keys: string[]) =>
  Object.keys(input).sort().join("\0") === keys.sort().join("\0");

export function inspectAmuxV22OutcomeRequest(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (!exactKeys(input, ["version", "requestId", "taskId", "revision",
    "kind", "outcome", "evidenceDigest", "findingCount",
    "revisedEffortPoints", "revisedCostMicrousd", "reasonCode"]) ||
    input.version !== 1 ||
    typeof input.requestId !== "string" || !UUID.test(input.requestId) ||
    typeof input.taskId !== "string" || !ID.test(input.taskId) ||
    !Number.isSafeInteger(input.revision) || (input.revision as number) < 0 ||
    (input.evidenceDigest !== null &&
      (typeof input.evidenceDigest !== "string" || !SHA256.test(input.evidenceDigest))))
    return null;
  const findings = input.kind === "checks" || input.kind === "independent_review";
  const estimate = input.kind === "estimate_revision";
  const valid = estimate ?
    input.outcome === "revised" && input.evidenceDigest !== null &&
    Number.isSafeInteger(input.revisedEffortPoints) &&
    (input.revisedEffortPoints as number) >= 1 &&
    (input.revisedEffortPoints as number) <= 1000 &&
    typeof input.revisedCostMicrousd === "string" &&
    /^(0|[1-9][0-9]{0,18})$/.test(input.revisedCostMicrousd) &&
    BigInt(input.revisedCostMicrousd) <= BigInt("9223372036854775807") &&
    ["scope_changed", "actual_usage", "quality_findings",
      "capacity_changed"].includes(input.reasonCode as string) :
    findings ?
    (input.outcome === "passed" || input.outcome === "failed") &&
      Number.isSafeInteger(input.findingCount) &&
      (input.findingCount as number) >= 0 &&
      (input.findingCount as number) <= 1000 &&
      (input.outcome !== "passed" || input.findingCount === 0) &&
      input.evidenceDigest !== null :
    input.kind === "post_deploy_regression" ?
    input.outcome === "none_observed" || input.outcome === "regression_observed" :
    input.kind === "user_outcome" ?
      input.outcome === "met" || input.outcome === "mixed" ||
      input.outcome === "not_met" : false;
  if (!valid || (!findings && input.findingCount !== null) ||
      (!estimate && (input.revisedEffortPoints !== null ||
        input.revisedCostMicrousd !== null || input.reasonCode !== null)) ||
      (estimate && input.findingCount !== null) ||
      (input.outcome === "regression_observed" &&
      input.evidenceDigest === null)) return null;
  return input as { version: 1; requestId: string; taskId: string;
    revision: number; kind: AmuxV22ObservationKind;
    outcome: AmuxV22Observation["outcome"]; evidenceDigest: string | null;
    findingCount: number | null;
    revisedEffortPoints: number | null; revisedCostMicrousd: string | null;
    reasonCode: AmuxV22Observation["reasonCode"] };
}

export function readAmuxV22ObservationMetadata(value: unknown):
  (AmuxV22Observation & { requestId: string; taskRevision: number }) | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const parsed = inspectAmuxV22OutcomeRequest({ version: 1,
    requestId: input.requestId, taskId: "audit-target", revision: input.taskRevision,
    kind: input.kind, outcome: input.outcome,
    evidenceDigest: input.evidenceDigest, findingCount: input.findingCount,
    revisedEffortPoints: input.revisedEffortPoints,
    revisedCostMicrousd: input.revisedCostMicrousd,
    reasonCode: input.reasonCode });
  if (!parsed || typeof input.observedAt !== "string" ||
      !Number.isFinite(Date.parse(input.observedAt))) return null;
  return { kind: parsed.kind, outcome: parsed.outcome,
    evidenceDigest: parsed.evidenceDigest, findingCount: parsed.findingCount,
    revisedEffortPoints: parsed.revisedEffortPoints,
    revisedCostMicrousd: parsed.revisedCostMicrousd,
    reasonCode: parsed.reasonCode,
    observedAt: input.observedAt,
    requestId: parsed.requestId, taskRevision: parsed.revision };
}
