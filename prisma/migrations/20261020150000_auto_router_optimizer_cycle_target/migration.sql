-- Which guidance an Auto router optimizer cycle improves: the routing guidance
-- (every cycle so far, so existing rows keep the default) or the rewrite
-- guidance of the Auto router rewrite (docs/ui-contracts/prompt-refiner-suggestion.md
-- §9; lib/autoRewriteOptimizer.ts). Both kinds stay in one table because they
-- share one running cycle at a time and the same day and month spending caps.
-- The closed list is AUTO_LLM_ROUTER_GUIDANCE_KINDS in lib/autoLlmRouterCore.ts
-- (scripts/check-enum-constraints.mjs compares the two).

ALTER TABLE "AutoRouterOptimizerCycle"
    ADD COLUMN "target" TEXT NOT NULL DEFAULT 'routing',
    ADD CONSTRAINT "AutoRouterOptimizerCycle_target_check" CHECK ("target" IN ('routing', 'rewrite'));
