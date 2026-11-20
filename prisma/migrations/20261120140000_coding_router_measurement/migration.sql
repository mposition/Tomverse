-- Smart Adaptive as a coding router (docs/policy/external-api.md, sections 5.1
-- and 10.6): what each external API request's routing decided, content-free,
-- so the daily coding routing report and the coding optimizer read real
-- traffic without any request text.
--   routedBy           router | continued | default, NULL for a model named directly
--   routedHeld         the router picked a cheaper model and the conversation kept its own
--   routeConversation  a SHA-256 prefix of the conversation's routing key, to count
--                      requests and escalations per conversation; never the key itself
ALTER TABLE "ExternalApiRequest"
    ADD COLUMN "routedBy" TEXT,
    ADD COLUMN "routedHeld" BOOLEAN,
    ADD COLUMN "routeConversation" TEXT;

CREATE INDEX "ExternalApiRequest_createdAt_idx" ON "ExternalApiRequest"("createdAt");

-- A third guidance an optimizer cycle may improve: the coding router guidance
-- (AUTO_LLM_ROUTER_CODING_GUIDANCE, lib/autoCodingRouterOptimizer.ts). It shares
-- the one running cycle at a time and the same day and month caps.
ALTER TABLE "AutoRouterOptimizerCycle"
    DROP CONSTRAINT "AutoRouterOptimizerCycle_target_check",
    ADD CONSTRAINT "AutoRouterOptimizerCycle_target_check" CHECK ("target" IN ('routing', 'rewrite', 'coding'));
