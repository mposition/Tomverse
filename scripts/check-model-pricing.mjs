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

import { AVAILABLE_MODELS } from "../lib/models.ts";
import {
  daysUntil,
  findPendingPriceRegisterProblems,
  findUnpricedModels,
  MODEL_PRICING,
  PENDING_VERIFIED_PRICE_MODEL_IDS,
  PENDING_VERIFIED_PRICE_REGISTER,
} from "../lib/modelPricing.ts";

const now = new Date();
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
