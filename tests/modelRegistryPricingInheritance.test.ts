import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
  const unpriced = getModel("mistral-large-3");
  assert.ok(unpriced);
  const pricing = resolveModelPricing({
    ...unpriced,
    inputUsdPerMillionTokens: undefined,
    outputUsdPerMillionTokens: undefined,
    cachedInputPriceMultiplier: undefined,
  });
  assert.equal(pricing.isFallbackPricing, true);
  assert.equal(pricing.costSource, "conservative_fallback");
});

test("the price-clearing migration is a frozen record of what seeding once wrote", () => {
  const sql = readFileSync(
    join(
      process.cwd(),
      "prisma/migrations/20260802020000_registry_prices_inherit_profile/migration.sql"
    ),
    "utf8"
  );

  // This used to derive the expectation from the current catalogue: for every
  // model, the allowlist had to contain the pair `resolveModelPricing` returns
  // *today*. That inverted the migration's purpose and made it unsafe to
  // maintain.
  //
  // Seeding cannot write a price at all any more. `staticModelRegistrySeedRows`
  // writes `model.inputUsdPerMillionTokens ?? null`, and no catalogue entry
  // carries one, so every seeded row holds NULL and inherits lib/modelPricing.ts
  // (that is what this migration exists to restore). The allowlist is therefore
  // a record of what seeding wrote *before* that change -- history, and a fixed
  // set. A model re-priced afterwards was never seeded at its new price, so the
  // new pair has nothing to clear and does not belong here.
  //
  // Deriving it from the catalogue instead forced an edit to this file every
  // time a profile changed -- and this migration is applied. That does not break
  // a deploy: on Prisma 7 `migrate deploy` (`ApplyMigrations`) never compares
  // checksums of already-applied migrations. It breaks `migrate status`, whose
  // `diagnose_migration_history` reports `modified after it was applied` on
  // every environment that ran the earlier bytes -- and §1 of
  // RELEASE_CHECKLIST.md requires a clean status. It is also not repairable with
  // `prisma migrate resolve`, which is for failed migrations, not successful
  // ones. See §7.6 for how to decide when it has already happened.
  //
  // So the expectation is frozen, and it is the file's SHA-256 rather than a
  // row count: an edit that swaps one allowlist row for another keeps the count
  // identical and would otherwise pass. Prisma hashes these same bytes, so this
  // constant is the checksum a database records when it applies this migration.
  const digest = createHash("sha256").update(sql, "utf8").digest("hex");
  assert.equal(
    digest,
    "a388d8c0345a787d0b60bd742bbdfb59519e8ee1dcf7a4f7738290782a47ea82",
    "this migration is applied; its bytes are history and must not change. " +
      "If it is being restored to its pre-#320 content on purpose, update this " +
      "digest in the same commit and say which environments were checked."
  );

  // Kept as a readable statement of what those bytes have to contain, so a
  // reviewer sees the invariant rather than only a hash.
  const allowlist = [...sql.matchAll(/\('([^']+)', ([0-9.]+), ([0-9.]+),/g)].map(
    (match) => `${match[1]}|${match[2]}|${match[3]}`
  );
  assert.ok(
    allowlist.includes("glm-5.2|0.5|1"),
    "glm-5.2's seeded standard-class fallback must stay listed, or a stale row survives"
  );

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
