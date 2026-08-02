// What price is each model actually billed at, and where did that number come
// from?
//
//   npm run check:model-pricing-db
//   npm run check:model-pricing-db -- --json
//
// Reads ModelRegistryEntry and resolves each row exactly the way the chat path
// does. Writes nothing. Without a DATABASE_URL it reports the compiled
// catalogue instead and says so.
//
// The column that matters is `stored`. NULL there means the row inherits
// lib/modelPricing.ts -- tiers, long-context steps and all -- and a number
// means an administrator overrode this model, which flattens the tiers to that
// one pair. Seeding used to write the resolved price into every row, so every
// model read as an override and Gemini 3.1 Pro's >200K tier stopped existing
// in production; migration 20260802020000 cleared the rows that had been
// stamped that way. This is how to confirm an environment is clean.
//
// Exits non-zero when a row overrides a price that the registry already
// prices identically -- an override that changes no number is not a decision,
// it is a leftover, and it silently disables the tiers underneath it.

import { AVAILABLE_MODELS } from "../lib/models.ts";
import { resolveModelPricing } from "../lib/modelPricing.ts";

const json = process.argv.includes("--json");
const databaseUrl = process.env.DATABASE_URL?.trim();

let source = "compiled_catalogue";
let models = AVAILABLE_MODELS;
let note =
  "No DATABASE_URL: this is the compiled catalogue, which by definition stores no override.";

if (databaseUrl) {
  try {
    const { prisma } = await import("../lib/prisma.ts");
    const { registryRowToModel } = await import("../lib/modelRegistry.ts");
    const rows = await prisma.modelRegistryEntry.findMany({
      orderBy: [{ provider: "asc" }, { sortOrder: "asc" }],
    });
    await prisma.$disconnect().catch(() => undefined);
    if (rows.length > 0) {
      models = rows.map((row) => registryRowToModel(row));
      source = "model_registry";
      note = `Read ${rows.length} ModelRegistryEntry row(s).`;
    } else {
      note = "The registry is empty, so the compiled catalogue is reported instead.";
    }
  } catch (error) {
    const message = String(error?.message || error).replaceAll(
      databaseUrl,
      "[redacted]"
    );
    note = `DATABASE_URL was set but unreadable; reporting the compiled catalogue instead: ${message.slice(0, 200)}`;
  }
}

const entries = models.map((model) => {
  const pricing = resolveModelPricing(model);
  const stored = {
    inputUsdPerMillionTokens: model.inputUsdPerMillionTokens ?? null,
    outputUsdPerMillionTokens: model.outputUsdPerMillionTokens ?? null,
    cachedInputPriceMultiplier: model.cachedInputPriceMultiplier ?? null,
  };
  const hasOverride =
    stored.inputUsdPerMillionTokens !== null ||
    stored.outputUsdPerMillionTokens !== null ||
    stored.cachedInputPriceMultiplier !== null;

  // Resolve the same model with its stored price removed, to see what it
  // would inherit. An override that lands on the same numbers is a leftover
  // that costs nothing today and disables the tiers if a limit ever moves.
  const inherited = resolveModelPricing({
    ...model,
    inputUsdPerMillionTokens: undefined,
    outputUsdPerMillionTokens: undefined,
    cachedInputPriceMultiplier: undefined,
  });
  const redundantOverride =
    hasOverride &&
    pricing.inputUsdPerMillionTokens === inherited.inputUsdPerMillionTokens &&
    pricing.outputUsdPerMillionTokens === inherited.outputUsdPerMillionTokens &&
    pricing.cachedInputPriceMultiplier === inherited.cachedInputPriceMultiplier;

  return {
    modelId: model.id,
    provider: model.provider,
    enabled: model.enabled,
    stored,
    hasOverride,
    redundantOverride,
    effective: {
      inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
      cachedInputPriceMultiplier: pricing.cachedInputPriceMultiplier,
    },
    inheritedIfCleared: {
      inputUsdPerMillionTokens: inherited.inputUsdPerMillionTokens,
      outputUsdPerMillionTokens: inherited.outputUsdPerMillionTokens,
      cachedInputPriceMultiplier: inherited.cachedInputPriceMultiplier,
    },
    costSource: pricing.costSource,
    pricingVersion: pricing.pricingVersion,
    priceSource: pricing.priceSource,
    isFallbackPricing: pricing.isFallbackPricing,
    // A tiered profile hidden behind a flat stored pair. Worth naming
    // separately from "has an override" because this is the one that can
    // under-charge rather than merely mislead.
    tiersDisabledByOverride:
      hasOverride && inherited.costSource === "registry" && !pricing.isFallbackPricing,
  };
});

if (json) {
  console.log(JSON.stringify({ source, note, entries }, null, 2));
} else {
  console.log(`Model pricing (${source})\n  ${note}\n`);
  console.log(
    `  ${"model".padEnd(32)}${"stored".padEnd(24)}${"effective".padEnd(24)}${"costSource".padEnd(28)}pricingVersion`
  );
  for (const entry of entries) {
    const stored = entry.hasOverride
      ? `${entry.stored.inputUsdPerMillionTokens ?? "-"}/${entry.stored.outputUsdPerMillionTokens ?? "-"}@${entry.stored.cachedInputPriceMultiplier ?? "-"}`
      : "NULL (inherits)";
    const effective = `${entry.effective.inputUsdPerMillionTokens}/${entry.effective.outputUsdPerMillionTokens}@${entry.effective.cachedInputPriceMultiplier}`;
    console.log(
      `  ${entry.modelId.padEnd(32)}${stored.padEnd(24)}${effective.padEnd(24)}` +
        `${entry.costSource.padEnd(28)}${entry.pricingVersion}` +
        (entry.enabled ? "" : "   [disabled]")
    );
  }

  const fallback = entries.filter((entry) => entry.isFallbackPricing);
  if (fallback.length > 0) {
    console.log(
      `\n  ${fallback.length} model(s) on the conservative class fallback: ` +
        fallback.map((entry) => entry.modelId).join(", ")
    );
  }
}

const redundant = entries.filter((entry) => entry.redundantOverride);
if (redundant.length > 0) {
  console.error(
    `\n${redundant.length} row(s) override a price with the value they would inherit anyway:\n` +
      redundant
        .map(
          (entry) =>
            `  - ${entry.modelId}: stored ${entry.stored.inputUsdPerMillionTokens}/${entry.stored.outputUsdPerMillionTokens}, ` +
            `inherited ${entry.inheritedIfCleared.inputUsdPerMillionTokens}/${entry.inheritedIfCleared.outputUsdPerMillionTokens}`
        )
        .join("\n") +
      "\n\nThis changes no price today and disables the profile's tiers underneath it,\n" +
      "so a long-context step would stop applying without any number moving. Clear the\n" +
      "columns to NULL with a migration guarded on these exact values -- never a blanket\n" +
      "UPDATE, which would also erase a deliberate override."
  );
  process.exit(1);
}

console.log("\nNo redundant price overrides.");
