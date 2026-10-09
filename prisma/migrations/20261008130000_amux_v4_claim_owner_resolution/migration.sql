-- Add terminal states for the owner-only read-back resolution path. These do
-- not enable dispatch and remain inside the Agent-only budget namespace.
BEGIN;

ALTER TABLE "AmuxIdeaAnalysisBudgetHold"
    DROP CONSTRAINT "AmuxIdeaAnalysisBudgetHold_status_check",
    ADD CONSTRAINT "AmuxIdeaAnalysisBudgetHold_status_check" CHECK (
        "status" IN ('reserved', 'in_flight', 'succeeded', 'failed',
            'outcome_unknown', 'owner_consumed', 'owner_released_unstarted',
            'released')
    ),
    DROP CONSTRAINT "AmuxIdeaAnalysisBudgetHold_lifecycle_check",
    ADD CONSTRAINT "AmuxIdeaAnalysisBudgetHold_lifecycle_check" CHECK ((
        ("status" = 'reserved' AND "dispatchedAt" IS NULL AND
            "closedAt" IS NULL AND "settledMicroUsd" IS NULL AND
            "inputTokens" IS NULL) OR
        ("status" IN ('in_flight', 'outcome_unknown') AND
            "dispatchedAt" IS NOT NULL AND "closedAt" IS NULL AND
            "settledMicroUsd" IS NULL AND "inputTokens" IS NULL) OR
        ("status" IN ('succeeded', 'failed') AND
            "dispatchedAt" IS NOT NULL AND "closedAt" IS NOT NULL AND
            "closedAt" >= "dispatchedAt" AND "settledMicroUsd" > 0 AND
            "inputTokens" IS NOT NULL) OR
        ("status" = 'owner_consumed' AND "dispatchedAt" IS NOT NULL AND
            "closedAt" IS NOT NULL AND "closedAt" >= "dispatchedAt" AND
            "settledMicroUsd" = "reservedMicroUsd" AND "inputTokens" IS NULL) OR
        ("status" = 'owner_released_unstarted' AND
            "dispatchedAt" IS NOT NULL AND "closedAt" IS NOT NULL AND
            "closedAt" >= "dispatchedAt" AND "settledMicroUsd" = 0 AND
            "inputTokens" IS NULL) OR
        ("status" = 'released' AND "dispatchedAt" IS NULL AND
            "closedAt" IS NOT NULL AND "closedAt" >= "createdAt" AND
            "settledMicroUsd" = 0 AND "inputTokens" IS NULL)
        ) IS TRUE
    );

ALTER TABLE "AmuxIdeaTransferPreview"
    DROP CONSTRAINT "AmuxIdeaTransferPreview_state_check",
    ADD CONSTRAINT "AmuxIdeaTransferPreview_state_check" CHECK (
        "state" IN ('prepared', 'confirmed', 'in_flight', 'completed',
            'owner_rejected', 'provider_failed', 'expired', 'outcome_unknown',
            'owner_resolved')
    ),
    DROP CONSTRAINT "AmuxIdeaTransferPreview_state_confirm_check",
    ADD CONSTRAINT "AmuxIdeaTransferPreview_state_confirm_check" CHECK (
        "state" NOT IN ('confirmed', 'in_flight', 'completed',
            'provider_failed', 'outcome_unknown', 'owner_resolved') OR
        "confirmedAt" IS NOT NULL
    );

COMMIT;
