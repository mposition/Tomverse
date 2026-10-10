-- Keep the fail-closed unknown-attempt probe bounded to the current guard
-- generation without scanning product attempt history.
CREATE INDEX "PromptRefinerProductAttempt_state_createdAt_idx"
  ON "PromptRefinerProductAttempt"("state", "createdAt");
