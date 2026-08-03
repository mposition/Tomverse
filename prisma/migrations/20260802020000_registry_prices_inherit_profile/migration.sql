-- Restore NULL-means-inherit on ModelRegistryEntry's three price columns.
--
-- ## What was wrong
--
-- Seeding wrote a *resolved* price into every row. STATIC_RUNTIME_MODELS
-- spread getModelBillingProfile(model), which always returns a concrete
-- number -- the explicit profile when there is one, the usage-class fallback
-- when there is not -- so no row ever carried NULL. From then on
-- resolveModelPricing's `model.inputUsdPerMillionTokens ?? <profile>` read
-- that column and the profile in lib/modelPricing.ts stopped being reachable.
--
-- Three separate consequences, all of them live in production:
--
--   1. Long-context tiers were flattened. gemini-3-1-pro prices a prompt over
--      200K tokens at 4/18, but its row holds the flat 2/12 tier, and a
--      stored column cannot express a tier at all. Raising
--      CHAT_USER_MAX_INPUT_TOKENS past 200,000 would have under-charged
--      silently.
--   2. costSource read `model_registry_override` for every model, so the
--      fallback-pricing metrics (GET /api/admin/fallback-pricing) measured a
--      0% fallback share while claude-fable-5, mistral-large-3, qwen3.7-max
--      and perplexity/sonar-deep-research were in fact being reserved at the
--      US$15/US$60 conservative fallback. The register that is supposed to
--      time-box that state had nothing to report against.
--   3. An operator's deliberate price and an inherited default were
--      indistinguishable, so neither the application nor a human could tell
--      which rows were decisions.
--
-- lib/modelRegistryShared.ts now seeds these columns as NULL and leaves them
-- out of reconciliation entirely. This migration clears the rows an earlier
-- seed already stamped.
--
-- ## Why an allowlist and not a blanket UPDATE ... SET NULL
--
-- A blanket clear would also erase every price an administrator set by hand,
-- and those are the only values in this column that are supposed to survive.
-- So each row is cleared only when its stored triple still matches a value
-- seeding is known to have written for that exact model id: either the
-- profile/fallback resolved by the current catalogue, or -- for gpt-5-4-mini
-- -- the US$0.50/US$1.00 standard-class fallback it carried before it was
-- given a profile on 2026-08-01.
--
-- The cached-input multiplier is matched with a tolerance rather than by
-- equality because it is a double (deepseek-v4-pro's is 1/120), and a row
-- whose multiplier an operator has changed on its own keeps all three
-- columns: a partial clear would leave a price that is half inherited and
-- half chosen.
--
-- Nothing else is touched. Past reservations, settlements, usage buckets and
-- billing ledgers keep the pricingVersion and costSource frozen into them at
-- the time -- a price change is never retroactive -- and enabled,
-- publiclyListed, status, creditWeight, maxOutputTokens,
-- reservationOutputTokens and catalogDeleted are all out of scope.
--
-- Idempotent: a second run matches nothing, because the first left NULLs.
WITH seeded(id, input_usd, output_usd, cached_multiplier) AS (
  VALUES
    ('claude-fable-5', 15, 60, 1),
    ('claude-fable-5', 10, 50, 0.1),
    ('claude-haiku-4-5', 0.5, 1, 1),
    ('claude-opus-4-8', 5, 25, 1),
    ('claude-opus-4-8', 5, 25, 0.1),
    ('claude-sonnet-5', 3, 12, 1),
    ('codestral', 3, 12, 0.1),
    ('codestral', 0.3, 0.9, 1),
    ('deepseek-r1', 0.14, 0.28, 0.02),
    ('deepseek-v4-flash', 0.14, 0.28, 0.02),
    ('deepseek-v4-pro', 0.435, 0.87, 0.008333333333333333),
    ('gemini-2-5-flash', 0.3, 2.5, 0.1),
    ('gemini-2-5-pro', 3, 12, 1),
    ('gemini-3-1-pro', 2, 12, 1),
    -- Gemini 3.5 Flash first inherited the Standard fallback, then received
    -- its published profile on 2026-08-03. Both are seed-derived values.
    ('gemini-3-5-flash', 0.5, 1, 1),
    ('gemini-3-5-flash', 1.5, 9, 0.1),
    ('gemini-3-6-flash', 1.5, 7.5, 0.1),
    ('glm-5.2', 0.5, 1, 0.2),
    -- The pre-2026-08-01 standard-class fallback, and the profile that
    -- replaced it. Both are values seeding wrote; neither is a decision.
    ('gpt-5-4-mini', 0.5, 1, 1),
    ('gpt-5-4-mini', 0.75, 4.5, 0.1),
    ('gpt-5-5', 5, 30, 1),
    ('gpt-5-5-thinking', 5, 30, 1),
    ('gpt-5-6-luna', 0.2, 1.2, 0.1),
    ('gpt-5-6-sol', 5, 30, 0.1),
    ('gpt-5-6-terra', 2, 12, 0.1),
    ('grok-3', 3, 12, 1),
    ('grok-3-mini', 0.5, 1, 1),
    ('grok-4', 15, 60, 1),
    ('grok-4-3', 1.25, 2.5, 0.16),
    ('grok-4-5', 2, 6, 0.15),
    ('kimi-k2.7-code', 3, 12, 1),
    ('kimi-k3', 15, 60, 1),
    ('kimi-k3', 3, 15, 0.1),
    ('llama-3-1', 0.5, 1, 1),
    ('llama-3-3', 3, 12, 1),
    ('llama-4-scout', 0.11, 0.34, 1),
    ('mistral-large-3', 15, 60, 0.1),
    ('mistral-medium-3-1', 1.5, 7.5, 1),
    ('mistral-small-4', 0.5, 1, 0.1),
    ('minimax-m3', 0.3, 1.2, 0.2),
    ('perplexity/sonar', 3, 12, 1),
    ('perplexity/sonar-deep-research', 15, 60, 1),
    ('perplexity/sonar-pro', 3, 12, 1),
    ('perplexity/sonar-reasoning-pro', 3, 12, 1),
    ('qwen3.6-flash', 0.5, 1, 1),
    ('qwen3.7-max', 15, 60, 1),
    ('qwen3.7-plus', 3, 12, 1)
)
UPDATE "ModelRegistryEntry" AS entry
SET
  "inputUsdPerMillionTokens" = NULL,
  "outputUsdPerMillionTokens" = NULL,
  "cachedInputPriceMultiplier" = NULL
FROM seeded
WHERE entry."id" = seeded.id
  AND entry."inputUsdPerMillionTokens" IS NOT NULL
  AND entry."outputUsdPerMillionTokens" IS NOT NULL
  AND abs(entry."inputUsdPerMillionTokens" - seeded.input_usd::double precision) < 1e-9
  AND abs(entry."outputUsdPerMillionTokens" - seeded.output_usd::double precision) < 1e-9
  AND (
    entry."cachedInputPriceMultiplier" IS NULL
    OR abs(entry."cachedInputPriceMultiplier" - seeded.cached_multiplier::double precision) < 1e-9
  );
