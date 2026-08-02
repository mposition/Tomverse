-- Correct the four incident models' frozen registry prices.
--
-- lib/modelPricing.ts exists because these exact four models were billed
-- internally at the generic premium fallback of USD 15/60 per million tokens
-- -- 2x to 7.5x their real list price -- and, against a per-user cost
-- guardrail, that blocked paying users who still held thousands of credits.
-- The registry gave each of them a verified profile.
--
-- The profile never reached production. Two reasons compound:
--
--   * createMany(skipDuplicates) inserts and never updates, so a row that
--     already existed kept whatever was seeded into it, and
--   * resolveModelPricing reads `model.inputUsdPerMillionTokens ?? ...`, so
--     that stored column wins over the explicit profile it was meant to be
--     superseded by.
--
-- These ids are also absent from STATIC_CATALOG_RECONCILIATION_MODEL_IDS, so
-- no application path corrects them either. Measured against the deployed
-- /api/models/catalog on 2026-08-02, all four still held 15/60.
--
-- Applied values are the standard-API list prices for the routing this
-- application actually uses -- DIRECT_STANDARD, no relay, no priority or fast
-- tier, no US-only inference surcharge:
--
--   gpt-5-5           5/30
--   gpt-5-5-thinking  5/30   (same gpt-5.5 upstream model)
--   claude-opus-4-8   5/25   (standard/global routing; fast mode is 10/50)
--   gemini-3-1-pro    2/12   (the <=200K prompt tier)
--
-- gemini-3-1-pro carries a second, long-context tier at 4/18 above 200K
-- prompt tokens. Storing the flat 2/12 here is correct only while the input
-- ceiling keeps a request under that boundary: CHAT_USER_MAX_INPUT_TOKENS
-- defaults to 128,000 (lib/chatSecurity.ts), so the 4/18 tier is unreachable
-- today. It is also why this row must be cleared rather than edited if that
-- ceiling is ever raised past 200,000 -- a stored column cannot express a
-- tier. tests/modelPricing.test.mjs fails if the ceiling moves without that
-- being dealt with.
--
-- Deliberately narrow:
--   * exactly these four ids, not a general seed-over-registry sync;
--   * guarded on input AND output being exactly the 15/60 fallback pair, so a
--     price an administrator set by hand -- or an environment already
--     corrected -- is left alone;
--   * absolute assignment, never arithmetic, so re-running changes nothing;
--   * prices only. enabled, publiclyListed, status, creditWeight,
--     maxOutputTokens and reservationOutputTokens are untouched.
--
-- Past reservations, settlements and usage snapshots are NOT rewritten: each
-- stores its own pricingVersion and costSource precisely so a price change is
-- never retroactive. Cost buckets already inflated by the old rate are an
-- operational reconciliation against real provider usage, not a migration.
UPDATE "ModelRegistryEntry"
SET "inputUsdPerMillionTokens" = 5, "outputUsdPerMillionTokens" = 30
WHERE "id" IN ('gpt-5-5', 'gpt-5-5-thinking')
  AND "inputUsdPerMillionTokens" = 15
  AND "outputUsdPerMillionTokens" = 60;

UPDATE "ModelRegistryEntry"
SET "inputUsdPerMillionTokens" = 5, "outputUsdPerMillionTokens" = 25
WHERE "id" = 'claude-opus-4-8'
  AND "inputUsdPerMillionTokens" = 15
  AND "outputUsdPerMillionTokens" = 60;

UPDATE "ModelRegistryEntry"
SET "inputUsdPerMillionTokens" = 2, "outputUsdPerMillionTokens" = 12
WHERE "id" = 'gemini-3-1-pro'
  AND "inputUsdPerMillionTokens" = 15
  AND "outputUsdPerMillionTokens" = 60;
