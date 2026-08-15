-- Per-conversation selection mode and Auto's sticky state (routing policy §5).
--
-- Expand-only, and defaulted to the behaviour that exists today: every
-- conversation is 'manual' until something deliberately moves it, so this
-- migration changes no user's experience on deploy.

ALTER TABLE "Conversation" ADD COLUMN "selectionMode" TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE "Conversation" ADD COLUMN "routerModelId" TEXT;
ALTER TABLE "Conversation" ADD COLUMN "routerChallengerTurns" INTEGER NOT NULL DEFAULT 0;

-- The allowlist lives here rather than only in application code for the same
-- reason memoryMode's does: a mode nobody enumerated would be read by every
-- later consumer as "not manual", and the safe reading of an unknown mode is
-- not something each of them can be trusted to get right.
ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_selectionMode_check"
    CHECK ("selectionMode" IN ('manual', 'auto'));

-- Sticky state belongs to Auto. A manual conversation carrying a router model
-- or a challenger streak is state nothing will ever clear -- and a streak
-- accumulated under Auto would decide the first switch after Auto is turned
-- back on, using evidence from turns the user did not route.
ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_manual_has_no_sticky_state_check"
    CHECK (
        "selectionMode" = 'auto'
        OR ("routerModelId" IS NULL AND "routerChallengerTurns" = 0)
    );

-- A challenger streak is a count of turns, so it cannot be negative, and a
-- streak with no model to be sticky about is not a streak.
ALTER TABLE "Conversation"
    ADD CONSTRAINT "Conversation_challenger_turns_check"
    CHECK (
        "routerChallengerTurns" >= 0
        AND ("routerChallengerTurns" = 0 OR "routerModelId" IS NOT NULL)
    );
