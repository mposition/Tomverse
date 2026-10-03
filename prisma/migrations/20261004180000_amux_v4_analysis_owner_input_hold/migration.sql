-- A model question is a verified, measured result requiring owner action;
-- it is neither a provider failure nor an approved analysis draft.
ALTER TABLE "AmuxIdeaTransferPreview"
  DROP CONSTRAINT "AmuxIdeaTransferPreview_state_check",
  ADD CONSTRAINT "AmuxIdeaTransferPreview_state_check" CHECK (
    "state" IN ('prepared', 'confirmed', 'in_flight', 'completed',
      'owner_rejected', 'provider_failed', 'expired', 'outcome_unknown', 'owner_input')
  );

ALTER TABLE "AmuxIdeaTransferPreview"
  DROP CONSTRAINT "AmuxIdeaTransferPreview_state_confirm_check",
  ADD CONSTRAINT "AmuxIdeaTransferPreview_state_confirm_check" CHECK (
    "state" NOT IN ('confirmed', 'in_flight', 'completed', 'provider_failed',
      'outcome_unknown', 'owner_input') OR "confirmedAt" IS NOT NULL
  );

ALTER TABLE "AmuxIdeaAnalysisChunk"
  DROP CONSTRAINT "AmuxIdeaAnalysisChunk_state_check",
  ADD CONSTRAINT "AmuxIdeaAnalysisChunk_state_check" CHECK (
    "state" IN ('pending', 'collecting', 'awaiting_preview', 'in_flight',
      'draft_ready', 'partially_decided', 'decided', 'expired', 'cancelled',
      'outcome_unknown', 'owner_input')
  );
