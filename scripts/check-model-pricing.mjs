// Fails the build when an enabled premium model has no explicit pricing
// profile.
//
// This is the check that would have caught the original incident: GPT-5.5,
// GPT-5.5 Thinking, Gemini 3.1 Pro and Claude Opus 4.8 were all enabled in
// production with no billing profile, so every one of them was internally
// priced at the generic premium fallback of US$15 input / US$60 output per
// million tokens -- 3x to 7.5x their real cost. Cheaper classes are reported
// as warnings, because their fallback is close enough to real list prices to
// be safe while a profile is written.

import { spawnSync } from "node:child_process";

import { AVAILABLE_MODELS } from "../lib/models.ts";
import {
  daysUntil,
  findPendingPriceRegisterProblems,
  findUnpricedModels,
  MODEL_PRICING,
  PENDING_VERIFIED_PRICE_MODEL_IDS,
  PENDING_VERIFIED_PRICE_REGISTER,
  PROMPT_CACHE_WRITE_5M_PRICE_MULTIPLIER,
} from "../lib/modelPricing.ts";
import { ANTHROPIC_MIN_CACHEABLE_PREFIX_TOKENS } from "../lib/anthropicPromptCaching.ts";
import {
  auditProcessingTierMentions,
  PROCESSING_TIER_REQUEST_ALLOWLIST,
  PROCESSING_TIER_SELECTOR_PATTERN,
} from "./check-processing-tier-core.mjs";

const now = new Date();

// ---------------------------------------------------------------------------
// Request-side price selectors.
//
// `inference_geo` is checked alongside the processing tier because it is the
// same hazard wearing different clothes. On Claude 4.6 and later models --
// which is every Anthropic model this application routes to -- sending
// `inference_geo: "us"` multiplies input, output, cache-write and cache-read
// pricing by 1.1x, while the default global routing is what the profiles
// record. One added request field would put every Anthropic reservation 10%
// under the real cost with nothing failing.
//
// Every profile claims `processingTier: "standard"`, which is only true while
// no request selects a tier: OpenAI treats an omitted `service_tier` as
// `auto`, and flex, batch and priority all price differently from Standard.
// A tier introduced without the matching pricing entry would mis-cost every
// request on it silently, so a request-side selector is a build failure until
// it is added to PROCESSING_TIER_REQUEST_ALLOWLIST.
// ---------------------------------------------------------------------------
// `--untracked` is load-bearing. Without it `git grep` only reads what is
// already tracked, so a brand-new file passes locally and fails in CI after it
// has been committed -- which is exactly what happened to
// scripts/check-openai-model-access.mjs. A guard that answers differently
// before and after `git add` is not a guard.
const tierGrep = spawnSync(
  "git",
  [
    "grep",
    "--untracked",
    // `-n` rather than `-l`: the allowlist pins the lines it covers, not the
    // file, so an allowlisted file cannot quietly gain a line that sets a tier.
    "-nE",
    PROCESSING_TIER_SELECTOR_PATTERN,
    "--",
    "app",
    "lib",
    "components",
    "scripts",
  ],
  { encoding: "utf8" }
);

// These three state the rule; they do not send one. The core module is listed
// for the same reason as the other two: it holds the pattern itself, so it
// always matches its own grep.
const SELF_REFERENTIAL = new Set([
  "lib/modelPricing.ts",
  "scripts/check-model-pricing.mjs",
  "scripts/check-processing-tier-core.mjs",
]);

// `git grep -n` prints `path:line:text`. The text can itself contain colons,
// so only the first two separators are split on.
const tierLines = (tierGrep.stdout || "")
  .split("\n")
  .filter(Boolean)
  .map((row) => {
    const firstColon = row.indexOf(":");
    const secondColon = row.indexOf(":", firstColon + 1);
    return {
      file: row.slice(0, firstColon),
      text: row.slice(secondColon + 1),
    };
  })
  .filter((entry) => !SELF_REFERENTIAL.has(entry.file));

const tierAudit = auditProcessingTierMentions({
  matchedLines: tierLines,
  allowlist: PROCESSING_TIER_REQUEST_ALLOWLIST,
});

if (tierAudit.errors.length > 0) {
  console.error(
    `\n${tierAudit.errors.length} problem(s) with the request-side price selector allowlist:\n` +
      tierAudit.errors.map((message) => `  - ${message}`).join("\n") +
      "\n\nEvery profile in lib/modelPricing.ts records Standard, globally\n" +
      "routed pricing for a request that selects nothing -- an omitted OpenAI\n" +
      "service_tier is served as `auto`, not necessarily as Standard, and\n" +
      "Anthropic's inference_geo: \"us\" costs 1.1x on Claude 4.6 and later.\n" +
      "Flex, batch, priority, regional processing and US-only inference are\n" +
      "priced differently, so a selector can only be introduced together with\n" +
      "the profile entries that price it.\n\n" +
      "A file that only *reads* the selector off a response belongs in\n" +
      "PROCESSING_TIER_REQUEST_ALLOWLIST with sendsATier: false and a reason."
  );
  process.exit(1);
}

const unpriced = findUnpricedModels(AVAILABLE_MODELS);
const errors = unpriced.filter((entry) => entry.severity === "error");
const warnings = unpriced.filter((entry) => entry.severity === "warning");

for (const entry of warnings) {
  const acknowledged = PENDING_VERIFIED_PRICE_MODEL_IDS.includes(entry.modelId);
  console.warn(
    `warning: ${entry.modelId} (${entry.provider}, ${entry.usageClass}) uses the conservative ${entry.costClass} pricing fallback${
      acknowledged ? " (awaiting a verified price source)" : ""
    }.`
  );
}

// The register itself: who owns each pending price, and how long it has left
// before the warning above becomes a failure.
if (PENDING_VERIFIED_PRICE_REGISTER.length > 0) {
  console.log("\nPending verified prices:");
  for (const entry of PENDING_VERIFIED_PRICE_REGISTER) {
    const remaining = daysUntil(entry.expiresAt, now);
    const deadline =
      remaining === null
        ? "invalid expiry"
        : remaining > 0
          ? `${remaining}d left`
          : `${-remaining}d overdue`;
    console.log(
      `  ${entry.modelId.padEnd(32)} owner=${entry.owner ?? "UNASSIGNED"} ` +
        `ticket=${entry.verificationTicket ?? "NONE"} ` +
        `approval=${entry.productionApproval?.approvedBy ?? "NONE"} ` +
        `registered=${entry.registeredAt} expires=${entry.expiresAt} (${deadline}) ` +
        `settles=${entry.settlementSource}`
    );
  }
}

/**
 * Every declared cache-write rate must be its own tier's input rate times the
 * published 5-minute multiplier.
 *
 * A gate rather than a test because a cache-write rate is now *billed*
 * (`CACHE_WRITE_PRICING_IS_BILLED_WHERE_MEASURED`), and a transcription slip
 * here is a wrong charge on every cache-creating turn -- silently, because the
 * number is plausible either way. The multiplier checks the rates; it does not
 * compute them. Each figure is still read off Anthropic's published table, so a
 * change Anthropic makes to the multiplier itself shows up here as a
 * disagreement rather than being absorbed.
 *
 * Also enforces the other half of the caching contract: every model this
 * application actually caches for must carry a rate. A cached model with no
 * rate bills its writes at nothing, which is the undercount the whole change
 * exists to remove.
 */
const cacheWriteProblems = [];
for (const profile of MODEL_PRICING) {
  for (const [index, tier] of profile.tiers.entries()) {
    const rate = tier.cacheWriteUsdPerMillionTokens;
    if (rate === undefined) continue;
    const expected =
      tier.inputUsdPerMillionTokens * PROMPT_CACHE_WRITE_5M_PRICE_MULTIPLIER;
    // Luna's published rate is 2x its input rate, not 1.25x -- OpenAI prices
    // its cache writes on its own schedule. The multiplier check applies to
    // the models this application caches for, which is Anthropic today; any
    // other provider's rate is recorded and is not asserted against
    // Anthropic's table.
    if (profile.provider !== "anthropic") continue;
    if (Math.abs(rate - expected) > 1e-9) {
      cacheWriteProblems.push(
        `${profile.modelId} tier ${index}: cache-write rate ${rate} is not ` +
          `${PROMPT_CACHE_WRITE_5M_PRICE_MULTIPLIER}x its input rate ` +
          `${tier.inputUsdPerMillionTokens} (expected ${expected}).`
      );
    }
  }
}
for (const modelId of Object.keys(ANTHROPIC_MIN_CACHEABLE_PREFIX_TOKENS)) {
  const profile = MODEL_PRICING.find((entry) => entry.modelId === modelId);
  if (!profile) continue;
  for (const [index, tier] of profile.tiers.entries()) {
    if (tier.cacheWriteUsdPerMillionTokens === undefined) {
      cacheWriteProblems.push(
        `${modelId} tier ${index}: this application caches for it and it ` +
          `carries no verified cache-write rate, so its writes would bill at ` +
          `nothing. See docs/policy/anthropic-prompt-caching.md section 4.`
      );
    }
  }
}
if (cacheWriteProblems.length > 0) {
  console.error(
    `\n${cacheWriteProblems.length} cache-write pricing problem(s):`
  );
  for (const problem of cacheWriteProblems) console.error(`  - ${problem}`);
  console.error(
    "\nSee docs/policy/anthropic-prompt-caching.md section 4 and\n" +
      "docs/policy/credit-and-cost-limits.md, the cache-write section."
  );
  process.exit(1);
}

const registerProblems = findPendingPriceRegisterProblems({
  models: AVAILABLE_MODELS,
  now,
});
const registerWarnings = registerProblems.filter(
  (problem) => problem.severity === "warning"
);
const registerErrors = registerProblems.filter(
  (problem) => problem.severity === "error"
);

for (const problem of registerWarnings) {
  console.warn(`warning: ${problem.message}`);
}

if (registerErrors.length > 0) {
  console.error(
    `\n${registerErrors.length} pending-price register problem(s):`
  );
  for (const problem of registerErrors) {
    console.error(`  - ${problem.message}`);
  }
  console.error(
    "\nSee docs/policy/credit-and-cost-limits.md, the pending price section."
  );
  process.exit(1);
}

if (errors.length > 0) {
  console.error(
    `\n${errors.length} enabled premium model(s) have no explicit billing profile:`
  );
  for (const entry of errors) {
    console.error(`  - ${entry.modelId} (${entry.provider}, ${entry.usageClass})`);
  }
  console.error(
    "\nAdd each one to MODEL_PRICING in lib/modelPricing.ts with its provider,\n" +
      "API model ID, routing path, processing tier, input/output prices,\n" +
      "long-context tiers, price source, pricing version and effective date."
  );
  process.exit(1);
}

console.log(
  `\nModel pricing check passed: ${MODEL_PRICING.length} explicit profiles, ` +
    `${warnings.length} model(s) on a conservative fallback, 0 unpriced premium models, ` +
    `${registerWarnings.length} register warning(s), 0 expired pending prices.`
);
