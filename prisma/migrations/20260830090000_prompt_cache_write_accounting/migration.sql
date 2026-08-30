-- Cache-write tokens, as their own line in the provider cost ledger.
--
-- Anthropic prompt caching (docs/policy/anthropic-prompt-caching.md) gave this
-- application its first cache-*write* token count. Until now every input token
-- was one of two things -- uncached at 1.0x or cache-read at 0.1x -- and a
-- write, at 1.25x, had nowhere to go: it arrived inside the SDK's
-- `inputTokens` total and was settled at the uncached rate, understating a
-- cache-creating turn's input cost by 25%.
--
-- Three token columns and one cost column, all additive and all defaulting to
-- what every existing row already means. A row written before this migration
-- had no write count because no request could produce one, so 0 is the true
-- value rather than a placeholder -- which is why the reservation and rollup
-- columns take a DEFAULT and the two audit columns stay nullable, matching
-- the NULL-means-nobody-looked contract their sibling token columns already
-- carry (`ChatAttemptUsage`'s counts are NULL only on a crash-reconciled row).
--
-- Nothing is backfilled and nothing is recomputed. Existing settlements keep
-- their `pricingSnapshot` and their `pricingVersion`; a price is never applied
-- retroactively (docs/policy/credit-and-cost-limits.md section 3).
--
-- Reversible by dropping the four columns: no existing column changes type,
-- nullability or default, and no constraint is added or removed.

ALTER TABLE "ChatCreditReservation"
  ADD COLUMN IF NOT EXISTS "settledCacheWriteInputTokens" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ChatAttemptUsage"
  ADD COLUMN IF NOT EXISTS "cacheWriteInputTokens" INTEGER;

ALTER TABLE "ChatAttemptUsageAdjustment"
  ADD COLUMN IF NOT EXISTS "observedCacheWriteInputTokens" INTEGER;

ALTER TABLE "ProviderDailyUsage"
  ADD COLUMN IF NOT EXISTS "cacheWriteInputTokens" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "ProviderDailyUsage"
  ADD COLUMN IF NOT EXISTS "cacheWriteInputCostMicroUsd" INTEGER NOT NULL DEFAULT 0;
