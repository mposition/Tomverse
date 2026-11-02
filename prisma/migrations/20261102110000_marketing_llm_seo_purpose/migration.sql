-- The marketing SEO code agent (marketing S5, docs/policy/marketing-automation.md 9.2)
-- spends through the same LLM cost ledger under its own `seo` purpose. It used
-- `brief`, which the ledger refuses while the market analysis switch is off, so
-- the agent could not run unless an unrelated paid feature was also on.
-- The list mirrors MARKETING_LLM_PURPOSES in lib/marketingLlmBudgetCore.ts.
--
-- Additive: every purpose the previous check allowed is still allowed and the
-- other predicates are the 20261102090000_marketing_llm_comment_triage_purpose
-- ones unchanged, so no existing row can fail the validation. No row is read or
-- written. One ALTER TABLE holding the DROP and the ADD, so the constraint is
-- never absent and baseline-check.json can bind the replacement
-- (scripts/baseline-presence-core.mjs).
ALTER TABLE "MarketingLlmCall"
    DROP CONSTRAINT "MarketingLlmCall_shape_check",
    ADD CONSTRAINT "MarketingLlmCall_shape_check"
        CHECK ("generatorRunId" ~ '^[A-Za-z0-9_-]{1,64}$'
            AND "purpose" IN ('draft', 'market_intel', 'brief', 'comment_triage', 'seo')
            AND "provider" = 'openai'
            AND "model" ~ '^[A-Za-z0-9._:/-]{1,128}$'
            AND jsonb_typeof("configSnapshot") = 'object'
            AND octet_length("configSnapshot"::text) <= 4096
            AND "reservedInputTokens" BETWEEN 1 AND 10000000
            AND "reservedOutputTokens" BETWEEN 1 AND 100000
            AND "reservedMicroUsd" BETWEEN 1 AND 100000000
            AND ("reportedModel" IS NULL OR "reportedModel" ~ '^[A-Za-z0-9._:/-]{1,128}$')
            AND ("reportedServiceTier" IS NULL OR "reportedServiceTier" ~ '^[a-z_]{1,32}$')
            AND ("reportedInputTokens" IS NULL OR "reportedInputTokens" >= 0)
            AND ("reportedOutputTokens" IS NULL OR "reportedOutputTokens" >= 0));
