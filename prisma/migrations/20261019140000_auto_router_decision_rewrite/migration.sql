-- The rewrite the Auto LLM router produced for a turn, when Admin › Routing
-- turned rewriting on (docs/ui-contracts/prompt-refiner-suggestion.md,
-- "Auto router rewrite"). Like routerInput it is derived from the user's own
-- message, so it lives on the same row and is deleted with the conversation
-- and the account. Null when no rewrite was asked for or none was kept.

ALTER TABLE "AutoRouterDecision" ADD COLUMN "rewrite" TEXT;
