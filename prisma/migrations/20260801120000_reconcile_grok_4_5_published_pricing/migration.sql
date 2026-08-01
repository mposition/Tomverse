-- Correct Grok 4.5's frozen token prices in the runtime registry.
--
-- lib/modelRegistry.ts seeds a row from STATIC_RUNTIME_MODELS, which spreads
-- getModelBillingProfile(model) -- the *resolved* profile, not the catalogue's
-- raw optional fields. A model with no explicit price in the pricing registry
-- therefore has its usage-class fallback written into the row as a concrete
-- number, and from then on that column wins over the catalogue
-- (`model.inputUsdPerMillionTokens ?? <fallback>`). createMany(skipDuplicates)
-- never updates an existing row, so adding the real price to lib/modelPricing
-- does not reach any environment that has already seeded.
--
-- grok-4-5 was seeded while it had no explicit price, so its row holds the
-- "premium" cost-class fallback of USD 15/60 per million against a model xAI
-- publishes at USD 2/6 (cached input USD 0.30, stored as a multiple of the
-- input price: 0.30 / 2.00 = 0.15).
--
-- This matters beyond reporting: consolidating xAI onto Grok 4.5 also made it
-- the provider probe's target, and recordProbeUsage books probe cost from this
-- profile against a daily cap shared by every provider. At the fallback rate a
-- worst-case xAI probe cycle cost USD 0.00267 and 144 cycles a day came to
-- USD 0.3845 -- 38% of the whole USD 1 cap from one provider. Real Grok
-- traffic was inflated against the xAI monthly spend ceiling the same way.
--
-- Deliberately narrow:
--   * one model id, not a general seed-over-registry sync, so admin-tuned
--     values on every other row are untouched;
--   * guarded on the exact fallback values, so an operator who has already
--     set a price by hand keeps it;
--   * absolute assignment, so re-running changes nothing (idempotent).
UPDATE "ModelRegistryEntry"
SET
  "inputUsdPerMillionTokens" = 2,
  "outputUsdPerMillionTokens" = 6,
  "cachedInputPriceMultiplier" = 0.15
WHERE
  "id" = 'grok-4-5'
  AND "inputUsdPerMillionTokens" = 15
  AND "outputUsdPerMillionTokens" = 60;
