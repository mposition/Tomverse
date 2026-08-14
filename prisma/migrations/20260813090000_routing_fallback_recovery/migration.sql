-- §8 recovery state: what a hard fallback displaced, so it can be restored.
--
-- Expand-only and nullable throughout. Every existing run and conversation
-- reads as "no fallback happened", which is what did happen.

ALTER TABLE "RoutingRun" ADD COLUMN "switchReason" TEXT;
ALTER TABLE "RoutingRun" ADD COLUMN "recoveryCandidateModelId" TEXT;
ALTER TABLE "RoutingRun" ADD COLUMN "fallbackHealthEvidence" TEXT;

ALTER TABLE "Conversation" ADD COLUMN "routerSwitchReason" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "routerRecoveryModelId" TEXT;

-- §8 grants the hysteresis bypass to `temporary_hard_fallback` and to nothing
-- else. Enumerating it here rather than only in code is the same reasoning as
-- selectionMode's allowlist: a value nobody enumerated would be read by the
-- restoration check as "not temporary_hard_fallback" and silently deny a
-- restoration that should have happened, or -- worse, if the check were ever
-- written the other way round -- grant one that should not.
ALTER TABLE "RoutingRun"
    ADD CONSTRAINT "RoutingRun_switchReason_check"
    CHECK ("switchReason" IS NULL OR "switchReason" IN ('temporary_hard_fallback'));

ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_routerSwitchReason_check"
    CHECK ("routerSwitchReason" IS NULL OR "routerSwitchReason" IN ('temporary_hard_fallback'));

-- A switch reason with no model to go back to is a recovery nobody can act on,
-- and a recovery candidate with no reason is a model kept for no stated cause.
-- Neither half means anything alone.
ALTER TABLE "RoutingRun"
    ADD CONSTRAINT "RoutingRun_recovery_pair_check"
    CHECK (
        ("switchReason" IS NULL AND "recoveryCandidateModelId" IS NULL)
        OR ("switchReason" IS NOT NULL AND "recoveryCandidateModelId" IS NOT NULL)
    );

ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_router_recovery_pair_check"
    CHECK (
        ("routerSwitchReason" IS NULL AND "routerRecoveryModelId" IS NULL)
        OR ("routerSwitchReason" IS NOT NULL AND "routerRecoveryModelId" IS NOT NULL)
    );

-- §8: "Manual intent always wins over fallback recovery." Recovery state is
-- Auto's, so a manual conversation holds none of it -- the same rule the
-- sticky model and the challenger streak already follow. Replaced rather than
-- extended so there is one constraint saying what a manual row may hold,
-- instead of two that could disagree.
ALTER TABLE "Conversation"
    DROP CONSTRAINT "Conversation_manual_has_no_sticky_state_check";

ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_manual_has_no_sticky_state_check"
    CHECK (
        "selectionMode" = 'auto'
        OR (
            "routerModelId" IS NULL
            AND "routerChallengerTurns" = 0
            AND "routerSwitchReason" IS NULL
            AND "routerRecoveryModelId" IS NULL
        )
    );
