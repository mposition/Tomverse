-- Dark v22 section 5 role snapshot for v25 aggregate dimensions. The receipt has no writer yet, so the source
-- table must still be empty. ADD NOT NULL without a default fails closed if
-- any environment received invocation rows before this migration.
ALTER TABLE "AmuxCliUsageInvocation"
  ADD COLUMN "workerRole" VARCHAR(32) NOT NULL;

ALTER TABLE "AmuxCliUsageInvocation"
  ADD CONSTRAINT "AmuxCliUsageInvocation_workerRole_check" CHECK (
    "workerRole" IN ('design', 'implement', 'test', 'review', 'verify',
      'investigate', 'operate', 'idea_analysis')
  );

ALTER TABLE "AmuxCliUsageInvocation"
  ADD CONSTRAINT "AmuxCliUsageInvocation_workerRole_context_check" CHECK (
    ("contextKind" = 'worker' AND "workerRole" <> 'idea_analysis') OR
    ("contextKind" = 'idea_analysis' AND "workerRole" = 'idea_analysis')
  );
