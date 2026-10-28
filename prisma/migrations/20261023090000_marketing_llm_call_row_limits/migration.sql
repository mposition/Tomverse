-- The marketing generator chooses its model from the Tomverse catalog, whose
-- OpenAI models have 1.05M-token windows. A web-search reservation reads the
-- window once per model pass, so its row needs up to 10M reserved input
-- tokens and up to the monthly cap ceiling (US$100) in micro-USD.
-- One ALTER statement replaces the constraint atomically; no rows are changed.
ALTER TABLE "MarketingLlmCall"
    DROP CONSTRAINT "MarketingLlmCall_shape_check",
    ADD CONSTRAINT "MarketingLlmCall_shape_check"
        CHECK ("generatorRunId" ~ '^[A-Za-z0-9_-]{1,64}$'
            AND "purpose" IN ('draft', 'market_intel', 'brief')
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
