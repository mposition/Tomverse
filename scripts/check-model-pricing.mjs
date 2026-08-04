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
  PROCESSING_TIER_REQUEST_ALLOWLIST,
} from "../lib/modelPricing.ts";
import {
  auditProcessingTierMentions,
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
    "-lE",
    PROCESSING_TIER_SELECTOR_PATTERN,
    "--",
    "app",
    "lib",
    "components",
    "scripts",
  ],
  { encoding: "utf8" }
);
const tierFiles = (tierGrep.stdout || "")
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean)
  // These three state the rule; they do not send one. The core module is
  // listed for the same reason as the other two: it holds the pattern itself,
  // so it always matches its own grep.
  .filter(
    (file) =>
      file !== "lib/modelPricing.ts" &&
      file !== "scripts/check-model-pricing.mjs" &&
      file !== "scripts/check-processing-tier-core.mjs"
  );

const tierAudit = auditProcessingTierMentions({
  matchedFiles: tierFiles,
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
