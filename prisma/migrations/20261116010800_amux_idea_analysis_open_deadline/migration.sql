-- Owner direction 2026-11-15: an internal development idea is never stopped by
-- its age. A new idea's analysis deadline is 36,500 days (a hundred years)
-- after its submission, so it ends only when its analysis completes or is
-- cancelled. Every idea submitted before keeps its seven days, and
-- TOMVERSE_AMUX_INTAKE_LEGACY_LIMITS writes seven days again. The deadline
-- stays derived from the submission time and immutable (identity guard); no
-- row is rewritten, and no purge clock moves earlier.
ALTER TABLE "AmuxIdeaSubmission"
  DROP CONSTRAINT "AmuxIdeaSubmission_analysis_deadline_check",
  ADD CONSTRAINT "AmuxIdeaSubmission_analysis_deadline_check" CHECK (
    "analysisDeadlineAt" = "submittedAt" + INTERVAL '7 days' OR
    "analysisDeadlineAt" = "submittedAt" + INTERVAL '36500 days'
  );
