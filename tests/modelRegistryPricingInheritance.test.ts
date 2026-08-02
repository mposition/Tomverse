import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  STATIC_RUNTIME_MODELS,
  staticModelRegistrySeedRows,
  staticModelRegistryReconciliationRows,
} from "@/lib/modelRegistryShared";
import { AVAILABLE_MODELS, getModel } from "@/lib/models";
import { resolveModelPricing } from "@/lib/modelPricing";

// The pricing contract for ModelRegistryEntry, from the database's side:
//
//   stored NULL   -> inherit lib/modelPricing.ts, tiers and all
//   stored number -> an administrator overrode this model
//
// Seeding used to write the *resolved* price into every row, which collapsed
// the two into one and made three things go quiet at once: Gemini 3.1 Pro's
// >200K tier stopped existing in production, every model reported
// costSource "model_registry_override", and no human could tell an inherited
// default from a decision. These tests are what keeps the two apart.

const PRICE_COLUMNS = [
  "inputUsdPerMillionTokens",
  "outputUsdPerMillionTokens",
  "cachedInputPriceMultiplier",
] as const;

test("the static runtime catalogue carries no resolved prices", () => {
  // The checked-in catalogue declares no price at all today, so the assertion
  // is read through a permissive lookup rather than a typed property: what
  // matters is that the runtime copy did not gain one on the way through
  // staticModelWithRuntimeDefaults.
  const priceOf = (model: unknown, column: string) =>
    (model as Record<string, unknown>)[column];

  for (const model of STATIC_RUNTIME_MODELS) {
    const declared = AVAILABLE_MODELS.find((entry) => entry.id === model.id);
    assert.ok(declared, model.id);
    for (const column of PRICE_COLUMNS) {
      assert.equal(
        priceOf(model, column),
        priceOf(declared, column),
        `${model.id}.${column} must stay exactly as the catalogue declared it, not the price resolved from it`
      );
    }
  }
});

test("seed rows leave every price column NULL", () => {
  const rows = staticModelRegistrySeedRows();
  assert.ok(rows.length > 0);
  for (const row of rows) {
    for (const column of PRICE_COLUMNS) {
      assert.equal(
        row[column],
        null,
        `${row.id}.${column} must be seeded NULL so the row inherits lib/modelPricing.ts`
      );
    }
  }
});

test("reconciliation never writes a price column at all", () => {
  // Distinct from seeding NULL: reconciliation re-runs on every boot, so
  // writing NULL here would silently delete an administrator's override on
  // the next deploy.
  for (const { id, data } of staticModelRegistryReconciliationRows()) {
    for (const column of PRICE_COLUMNS) {
      assert.equal(
        column in data,
        false,
        `${id}: reconciliation must not carry ${column} -- it would overwrite an operator override every boot`
      );
    }
  }
});

test("an inherited row resolves the profile, including its long-context tier", () => {
  const gemini = getModel("gemini-3-1-pro");
  assert.ok(gemini);
  const inherited = {
    ...gemini,
    inputUsdPerMillionTokens: undefined,
    outputUsdPerMillionTokens: undefined,
    cachedInputPriceMultiplier: undefined,
  };

  const short = resolveModelPricing(inherited, { estimatedPromptTokens: 1_000 });
  assert.equal(short.inputUsdPerMillionTokens, 2);
  assert.equal(short.outputUsdPerMillionTokens, 12);
  assert.equal(short.costSource, "registry");

  const long = resolveModelPricing(inherited, {
    estimatedPromptTokens: 250_000,
  });
  assert.equal(long.inputUsdPerMillionTokens, 4);
  assert.equal(long.outputUsdPerMillionTokens, 18);
  assert.equal(long.costSource, "registry_long_context");
  assert.equal(long.longContextThresholdTokens, 200_000);
});

test("a stored price is reported as an override and flattens the tiers", () => {
  // Not a bug to fix, but the reason a stored number must only ever be an
  // administrator's decision: a column cannot express a tier, so overriding
  // Gemini 3.1 Pro prices a 250K prompt at the short-prompt rate.
  const gemini = getModel("gemini-3-1-pro");
  assert.ok(gemini);
  const overridden = {
    ...gemini,
    inputUsdPerMillionTokens: 2,
    outputUsdPerMillionTokens: 12,
    cachedInputPriceMultiplier: 1,
  };

  const long = resolveModelPricing(overridden, {
    estimatedPromptTokens: 250_000,
  });
  assert.equal(long.inputUsdPerMillionTokens, 2);
  assert.equal(long.outputUsdPerMillionTokens, 12);
  assert.equal(long.costSource, "model_registry_override");
});

test("an unpriced model on an inherited row still reports as fallback-priced", () => {
  // GET /api/admin/fallback-pricing and PENDING_VERIFIED_PRICE_REGISTER both
  // depend on this: when the fallback price was stored in the row, the
  // fallback share measured 0% while models were in fact reserved at
  // US$15/US$60.
  const fable = getModel("claude-fable-5");
  assert.ok(fable);
  const pricing = resolveModelPricing({
    ...fable,
    inputUsdPerMillionTokens: undefined,
    outputUsdPerMillionTokens: undefined,
    cachedInputPriceMultiplier: undefined,
  });
  assert.equal(pricing.isFallbackPricing, true);
  assert.equal(pricing.costSource, "conservative_fallback");
});

test("the price-clearing migration covers every value seeding could have written", () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      "prisma/migrations/20260802020000_registry_prices_inherit_profile/migration.sql"
    ),
    "utf8"
  );

  // The allowlist is what stops the migration from erasing an operator's
  // price, so a model missing from it keeps a stale seeded number forever.
  for (const model of AVAILABLE_MODELS) {
    assert.ok(
      sql.includes(`('${model.id}',`),
      `${model.id} is not in the migration's seeded-value allowlist`
    );
    const resolved = resolveModelPricing(model);
    assert.ok(
      new RegExp(
        `\\('${model.id.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}', ${resolved.inputUsdPerMillionTokens}, ${resolved.outputUsdPerMillionTokens},`
      ).test(sql),
      `${model.id}: the migration must list the ${resolved.inputUsdPerMillionTokens}/${resolved.outputUsdPerMillionTokens} pair seeding writes today`
    );
  }

  assert.ok(
    sql.includes("abs(entry.\"cachedInputPriceMultiplier\""),
    "the cached multiplier must be matched with a tolerance, not by float equality"
  );
  assert.ok(
    !/UPDATE "ModelRegistryEntry"[\s\S]*SET[\s\S]*NULL[\s\S]*;\s*$/.test(
      sql.replace(/FROM seeded[\s\S]*/, "")
    ) || sql.includes("FROM seeded"),
    "the clear must be joined to the allowlist, never a blanket UPDATE"
  );
});
