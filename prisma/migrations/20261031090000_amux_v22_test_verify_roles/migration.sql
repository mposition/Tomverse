-- Owner decision 2026-10-30: two closed refusal codes record a Task role no
-- one-shot execution runs (operate) and a Task no priced worker can take, where
-- the unattended registrar used to end with an unknown outcome. CHECK only; the
-- registration receipt guard change is the next migration, so this file stays
-- in the grammar its baseline-check.json sidecar can prove.
BEGIN;

ALTER TABLE "AmuxIdeaRegistrationRefusal"
  DROP CONSTRAINT "AmuxIdeaRegistrationRefusal_code_check",
  ADD CONSTRAINT "AmuxIdeaRegistrationRefusal_code_check" CHECK (
    "refusalCode" IN (
      'task_expected_paths_missing',
      'task_expected_paths_out_of_range',
      'task_expected_path_invalid',
      'task_expected_paths_duplicate',
      'task_expected_paths_mixed',
      'task_role_review_refused',
      'task_execution_grade_mismatch',
      'task_confirmation_grade_mismatch',
      'task_cost_receipt_grade_mismatch',
      'task_role_not_runnable',
      'task_route_unpriced',
      'plan_schema_invalid',
      'plan_hierarchy_invalid',
      'plan_dependency_invalid',
      'plan_dependency_cycle',
      'plan_score_invalid',
      'plan_duplicate_unresolved'
    )
  );

COMMIT;
