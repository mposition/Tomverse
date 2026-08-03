// Fails the build when the image generation price list violates its policy.
//
// The text-model check (check-model-pricing.mjs) cannot see gpt-image-2:
// image models live outside AVAILABLE_MODELS by design
// (lib/providerModelCatalogCore.ts filters them from catalogue sync), so
// without this script the "every enabled model has an explicit verified
// price" release contract would silently exclude images. Same contract,
// separate fail-closed net. Policy: docs/policy/image-generation.md.

import {
  IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD,
  IMAGE_GENERATION_PRICING,
  IMAGE_PRICING_VERSION,
  IMAGE_PROMPT_BUDGET_MICRO_USD,
  listEnabledImagePricingEntries,
  maxRequestCostMicroUsd,
  PRICE_VERIFICATION,
} from "../lib/imageGenerationPricing.ts";

const failures = [];
const warnings = [];

const QUALITIES = ["low", "medium", "high"];
const SIZES = ["1024x1024", "1536x1024", "1024x1536"];

// Every advertised quality x size combination must have exactly one enabled
// entry. A missing entry means a UI preset without a price -- fail closed.
for (const quality of QUALITIES) {
  for (const size of SIZES) {
    const entries = IMAGE_GENERATION_PRICING.filter(
      (entry) => entry.quality === quality && entry.size === size
    );
    if (entries.length !== 1) {
      failures.push(
        `${quality} ${size}: expected exactly 1 pricing entry, found ${entries.length}`
      );
    }
  }
}

for (const entry of IMAGE_GENERATION_PRICING) {
  const label = `${entry.quality} ${entry.size}`;
  if (!Number.isSafeInteger(entry.credits) || entry.credits <= 0) {
    failures.push(`${label}: credits must be a positive integer, got ${entry.credits}`);
  }
  if (!Number.isSafeInteger(entry.outputCostMicroUsd) || entry.outputCostMicroUsd <= 0) {
    failures.push(
      `${label}: outputCostMicroUsd must be a positive integer, got ${entry.outputCostMicroUsd}`
    );
  }
}

// The per-credit ceiling, prompt budget included. This is the tripwire that
// forces an explicit product decision (raise credits, disable the preset, or
// re-approve the ceiling with a new pricing version) instead of a silent
// margin erosion when provider prices move.
for (const entry of listEnabledImagePricingEntries()) {
  const perCredit = maxRequestCostMicroUsd(entry) / entry.credits;
  if (perCredit > IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD) {
    failures.push(
      `${entry.quality} ${entry.size}: ${perCredit.toFixed(1)} microUSD/credit exceeds the ` +
        `${IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD} ceiling ` +
        `(output ${entry.outputCostMicroUsd} + prompt budget ${IMAGE_PROMPT_BUDGET_MICRO_USD} over ${entry.credits} credits). ` +
        `See docs/policy/image-generation.md for the change procedure.`
    );
  }
}

if (!IMAGE_PRICING_VERSION || typeof IMAGE_PRICING_VERSION !== "string") {
  failures.push("IMAGE_PRICING_VERSION must be a non-empty string");
}

// External price drift guard. check scripts cannot see openai.com, so the
// substitute is a hard staleness window on the recorded verification date:
// the feature does not keep running on a price list nobody has re-checked.
const verifiedAt = new Date(`${PRICE_VERIFICATION.verifiedAt}T00:00:00Z`);
if (Number.isNaN(verifiedAt.getTime())) {
  failures.push(
    `PRICE_VERIFICATION.verifiedAt (${PRICE_VERIFICATION.verifiedAt}) is not a parseable date`
  );
} else {
  const ageDays = Math.floor((Date.now() - verifiedAt.getTime()) / 86_400_000);
  if (ageDays > 180) {
    failures.push(
      `official price verification is ${ageDays} days old (limit 180). Re-verify against ` +
        `${PRICE_VERIFICATION.sources.join(", ")} and update PRICE_VERIFICATION.verifiedAt.`
    );
  } else if (ageDays > 90) {
    warnings.push(
      `official price verification is ${ageDays} days old (warning at 90, failure at 180).`
    );
  }
}

if (PRICE_VERIFICATION.sources.length === 0) {
  failures.push("PRICE_VERIFICATION.sources must list at least one official URL");
}

for (const warning of warnings) console.warn(`WARNING: ${warning}`);

if (failures.length > 0) {
  console.error("Image pricing check failed:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}

console.log(
  `Image pricing check passed (${listEnabledImagePricingEntries().length} enabled entries, ` +
    `ceiling ${IMAGE_COST_PER_CREDIT_CEILING_MICRO_USD} microUSD/credit, version ${IMAGE_PRICING_VERSION}).`
);
