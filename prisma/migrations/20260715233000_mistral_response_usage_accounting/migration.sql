-- Preserve response token details and the request-time price snapshot so
-- cached Mistral input is billed at the rate that applied to the request.
ALTER TABLE "ChatCreditReservation"
ADD COLUMN "settledInputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "settledCachedInputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "settledOutputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "pricingSnapshot" JSONB;

ALTER TABLE "ProviderDailyUsage"
ADD COLUMN "cachedInputTokens" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "uncachedInputCostMicroUsd" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "cachedInputCostMicroUsd" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "outputCostMicroUsd" INTEGER NOT NULL DEFAULT 0;
