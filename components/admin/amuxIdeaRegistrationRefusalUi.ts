import type { AdminApiFailure } from "@/lib/adminApiOutcome";

export type AmuxTaskRegistrationRefusalMessageKey =
  | "taskRegistrationExpectedPathsRefused"
  | "taskRegistrationMixedPathsRefused"
  | "taskRegistrationReviewRoleRefused"
  | "taskRegistrationGradeRefused"
  | "taskRegistrationRoleNotRunnable"
  | "taskRegistrationRouteUnpriced";

export type AmuxTaskRegistrationRefusalPresentation = {
  messageKey: AmuxTaskRegistrationRefusalMessageKey;
  clearDuplicateState: true;
};

/** Closed client copy mapping for the stable Admin API refusal codes. */
export function amuxTaskRegistrationRefusalPresentation(
  code: string,
): AmuxTaskRegistrationRefusalPresentation | null {
  switch (code) {
    case "task_expected_paths_missing":
    case "task_expected_paths_out_of_range":
    case "task_expected_path_invalid":
    case "task_expected_paths_duplicate":
      return { messageKey: "taskRegistrationExpectedPathsRefused",
        clearDuplicateState: true };
    case "task_expected_paths_mixed":
      return { messageKey: "taskRegistrationMixedPathsRefused",
        clearDuplicateState: true };
    case "task_role_review_refused":
      return { messageKey: "taskRegistrationReviewRoleRefused",
        clearDuplicateState: true };
    case "task_execution_grade_mismatch":
    case "task_confirmation_grade_mismatch":
    case "task_cost_receipt_grade_mismatch":
      return { messageKey: "taskRegistrationGradeRefused",
        clearDuplicateState: true };
    case "task_role_not_runnable":
      return { messageKey: "taskRegistrationRoleNotRunnable",
        clearDuplicateState: true };
    case "task_route_unpriced":
      return { messageKey: "taskRegistrationRouteUnpriced",
        clearDuplicateState: true };
    default:
      return null;
  }
}

export function amuxTaskRegistrationRefusalFailure(
  code: string,
  messages: Record<AmuxTaskRegistrationRefusalMessageKey, string>,
): AdminApiFailure | null {
  const presentation = amuxTaskRegistrationRefusalPresentation(code);
  return presentation ? {
    message: messages[presentation.messageKey],
    tone: "error",
    requiresReauthentication: false,
    approvalId: null,
  } : null;
}
