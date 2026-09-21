-- Bound autonomous AMUX retries without rewriting historical attempt order.
--
-- Existing rows intentionally remain NULL. New execution starts allocate a
-- monotonic task-local number while holding the task row lock. PostgreSQL's
-- ordinary UNIQUE semantics allow multiple historical NULLs and enforce every
-- new numbered attempt exactly once.

ALTER TABLE "AmuxExecutionAttempt"
    ADD COLUMN "attemptNumber" INTEGER;

ALTER TABLE "AmuxExecutionAttempt"
    ADD CONSTRAINT "AmuxExecutionAttempt_attempt_number_check"
    CHECK (
      "attemptNumber" IS NULL
      OR "attemptNumber" >= 1
    );

CREATE UNIQUE INDEX "AmuxExecutionAttempt_taskId_attemptNumber_key"
    ON "AmuxExecutionAttempt"("taskId", "attemptNumber");
