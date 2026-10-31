export const AMUX_V20_REGISTRATION_REFUSAL_ATTEMPT_KINDS = Object.freeze([
  "prepare", "consume", "whole_plan",
] as const);

export const AMUX_V20_TASK_REGISTRATION_REFUSAL_CODES = Object.freeze([
  "task_expected_paths_missing",
  "task_expected_paths_out_of_range",
  "task_expected_path_invalid",
  "task_expected_paths_duplicate",
  "task_expected_paths_mixed",
  "task_role_review_refused",
  "task_execution_grade_mismatch",
  "task_confirmation_grade_mismatch",
  "task_cost_receipt_grade_mismatch",
  "task_role_not_runnable",
  "task_route_unpriced",
] as const);

export const AMUX_V19_PLAN_REGISTRATION_REFUSAL_CODES = Object.freeze([
  "plan_schema_invalid",
  "plan_hierarchy_invalid",
  "plan_dependency_invalid",
  "plan_dependency_cycle",
  "plan_score_invalid",
  "plan_duplicate_unresolved",
] as const);

export const AMUX_REGISTRATION_REFUSAL_CODES = Object.freeze([
  ...AMUX_V20_TASK_REGISTRATION_REFUSAL_CODES,
  ...AMUX_V19_PLAN_REGISTRATION_REFUSAL_CODES,
] as const);

export const AMUX_V20_REGISTRATION_REFUSAL_ACTION =
  "amux.v20.registration.refuse";
export const AMUX_V20_REGISTRATION_REFUSAL_TARGET =
  "AmuxIdeaRegistrationRefusal";
export const AMUX_V20_REGISTRATION_REFUSAL_SUMMARY =
  "Recorded one deterministic AMUX registration refusal for operator review.";

export type AmuxV20RegistrationRefusalAttemptKind =
  (typeof AMUX_V20_REGISTRATION_REFUSAL_ATTEMPT_KINDS)[number];
export type AmuxV20TaskRegistrationRefusal =
  (typeof AMUX_V20_TASK_REGISTRATION_REFUSAL_CODES)[number];
export type AmuxV19PlanRegistrationRefusal =
  (typeof AMUX_V19_PLAN_REGISTRATION_REFUSAL_CODES)[number];
export type AmuxRegistrationRefusalCode = AmuxV20TaskRegistrationRefusal |
  AmuxV19PlanRegistrationRefusal;
export type AmuxV20RegistrationRefusalGrade =
  "routine" | "advanced" | "frontier";

export type AmuxV20RegistrationRefusalView = {
  state: "awaiting_operator";
  requestId: string;
  attemptKind: AmuxV20RegistrationRefusalAttemptKind;
  refusalCode: AmuxRegistrationRefusalCode;
  draftUnitId: string;
  analysisPreviewId: string;
  sourcePlanRevisionId: string;
  proposedExecutionGrade: AmuxV20RegistrationRefusalGrade | null;
  finalExecutionGrade: AmuxV20RegistrationRefusalGrade | null;
  attemptedAt: string;
};

export type AmuxV20RegistrationRefusalIdentity = {
  ideaId: string;
  draftUnitId: string;
  analysisPreviewId: string;
};

export type AmuxV20RegistrationRefusalRecord = {
  id: string;
  requestId: string;
  attemptKind: string;
  state: string;
  refusalCode: string;
  ideaId: string;
  draftUnitId: string;
  actorUserId: string;
  analysisPreviewId: string;
  sourcePlanRevisionId: string;
  proposedExecutionGrade: string | null;
  finalExecutionGrade: string | null;
  attemptedAt: Date;
};

const GRADES = new Set<AmuxV20RegistrationRefusalGrade>(
  ["routine", "advanced", "frontier"],
);
const ATTEMPT_KINDS = new Set<string>(AMUX_V20_REGISTRATION_REFUSAL_ATTEMPT_KINDS);
const TASK_REFUSAL_CODES = new Set<string>(AMUX_V20_TASK_REGISTRATION_REFUSAL_CODES);
const PLAN_REFUSAL_CODES = new Set<string>(AMUX_V19_PLAN_REGISTRATION_REFUSAL_CODES);
const REFUSAL_CODES = new Set<string>(AMUX_REGISTRATION_REFUSAL_CODES);

export const isAmuxV20RegistrationRefusalAttemptKind = (value: unknown):
  value is AmuxV20RegistrationRefusalAttemptKind =>
  typeof value === "string" && ATTEMPT_KINDS.has(value);

export const isAmuxV20RegistrationRefusalGrade = (value: unknown):
  value is AmuxV20RegistrationRefusalGrade => typeof value === "string" &&
  GRADES.has(value as AmuxV20RegistrationRefusalGrade);

export const isAmuxV20TaskRegistrationRefusal = (value: unknown):
  value is AmuxV20TaskRegistrationRefusal =>
  typeof value === "string" && TASK_REFUSAL_CODES.has(value);

export const isAmuxV19PlanRegistrationRefusal = (value: unknown):
  value is AmuxV19PlanRegistrationRefusal =>
  typeof value === "string" && PLAN_REFUSAL_CODES.has(value);

export const isAmuxRegistrationRefusalCode = (value: unknown):
  value is AmuxRegistrationRefusalCode => typeof value === "string" &&
  REFUSAL_CODES.has(value);

export const amuxV20RegistrationRefusalMetadata = (
  row: AmuxV20RegistrationRefusalRecord,
) => ({
  policyVersion: "20",
  state: row.state,
  requestId: row.requestId,
  attemptKind: row.attemptKind,
  refusalCode: row.refusalCode,
  ideaId: row.ideaId,
  draftUnitId: row.draftUnitId,
  analysisPreviewId: row.analysisPreviewId,
  sourcePlanRevisionId: row.sourcePlanRevisionId,
  proposedExecutionGrade: row.proposedExecutionGrade,
  finalExecutionGrade: row.finalExecutionGrade,
  attemptedAt: row.attemptedAt.toISOString(),
});

export const matchesAmuxV20RegistrationRefusalMetadata = (
  actual: unknown,
  expected: ReturnType<typeof amuxV20RegistrationRefusalMetadata>,
): boolean => {
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
  const keys = Object.keys(expected);
  const value = actual as Record<string, unknown>;
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key) &&
      value[key] === expected[key as keyof typeof expected]);
};

export const amuxV20RegistrationRefusalView = (
  row: AmuxV20RegistrationRefusalRecord,
): AmuxV20RegistrationRefusalView => ({
  state: "awaiting_operator",
  requestId: row.requestId,
  attemptKind: row.attemptKind as AmuxV20RegistrationRefusalAttemptKind,
  refusalCode: row.refusalCode as AmuxRegistrationRefusalCode,
  draftUnitId: row.draftUnitId,
  analysisPreviewId: row.analysisPreviewId,
  sourcePlanRevisionId: row.sourcePlanRevisionId,
  proposedExecutionGrade:
    row.proposedExecutionGrade as AmuxV20RegistrationRefusalGrade | null,
  finalExecutionGrade:
    row.finalExecutionGrade as AmuxV20RegistrationRefusalGrade | null,
  attemptedAt: row.attemptedAt.toISOString(),
});
