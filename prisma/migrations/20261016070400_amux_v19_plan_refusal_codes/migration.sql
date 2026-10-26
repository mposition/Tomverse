-- Intake v19 item 5: closed, content-free whole-plan refusal reasons.
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
      'plan_schema_invalid',
      'plan_hierarchy_invalid',
      'plan_dependency_invalid',
      'plan_dependency_cycle',
      'plan_score_invalid',
      'plan_duplicate_unresolved'
    )
  );

COMMIT;
