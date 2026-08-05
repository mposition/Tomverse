// Keeps the declared-context-window set from shrinking, and forces new models
// to declare one.
//
// The chat route's context guard reads:
//
//     if (modelConfig.contextWindowTokens && estimated + maxOutput > limit)
//
// so a model with no declared window is not clamped to a safe default -- it is
// not checked at all. An over-limit request for such a model reaches the
// provider, which is precisely what ESTIMATE-03 ("no over-limit context
// request reaches a provider") forbids at zero tolerance, and what Auto
// routing makes worse: today a person chooses those models deliberately, but a
// router would select them on the user's behalf.
//
// 16 of the 30 enabled catalogue models declare no window today, several of
// them on the Guest tier. Failing on all of them would only turn a real gap
// into a red build, so this is a ratchet rather than a cliff: the list below
// is a measurement of the gap as it stands, it may only shrink, and any model
// added or enabled from now on must declare a window. ESTIMATE-03 is the
// deadline -- the release gate is what these entries block, so they do not
// also need an invented expiry date.
//
// Scope note: ModelRegistryEntry rows can supply a window at runtime
// (lib/modelRegistry.ts merges DB values over the catalogue), so a listed
// model here is not necessarily unguarded in production. This check covers the
// catalogue's own guarantee, which is the floor when no row exists. The
// database side needs its own check, the same way check:model-pricing and
// check:model-pricing-db split that responsibility.

import { AVAILABLE_MODELS } from "../lib/models.ts";

// Measured on 2026-08-05 against develop. Entries may be removed, never added.
// Removing one means the model now declares a window -- that is the point.
const KNOWN_UNDECLARED_CONTEXT_WINDOW = [
  "gpt-5-5",
  "gpt-5-5-thinking",
  "claude-sonnet-5",
  "claude-haiku-4-5",
  "gemini-3-1-pro",
  "mistral-small-4",
  "mistral-large-3",
  "kimi-k2.7-code",
  "qwen3.7-max",
  "qwen3.7-plus",
  "qwen3.6-flash",
  "glm-5.2",
  "perplexity/sonar",
  "perplexity/sonar-pro",
  "perplexity/sonar-reasoning-pro",
  "perplexity/sonar-deep-research",
];

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exitCode = 1;
};

// `publiclyListed: false` models stay resolvable for existing conversations, so
// a request can still reach a provider through them. Reachability, not
// listing, is what the guard cares about.
const guarded = AVAILABLE_MODELS.filter((model) => model.enabled && !model.catalogDeleted);
if (guarded.length === 0) {
  throw new Error("No enabled catalogue models; refusing to validate an empty set.");
}

const known = new Set(KNOWN_UNDECLARED_CONTEXT_WINDOW);
const guardedById = new Map(guarded.map((model) => [model.id, model]));

const undeclared = guarded.filter((model) => !model.contextWindowTokens);

console.log(
  `catalogue: ${guarded.length} enabled models, ${undeclared.length} without a declared context window ` +
    `(${known.size} accepted as the current baseline).`
);

// 1. A new or newly enabled model must declare a window. This is the rule that
//    stops the gap growing.
for (const model of undeclared) {
  if (!known.has(model.id)) {
    fail(
      `${model.id} (${model.provider}, ${model.minimumPlan}) is enabled with no contextWindowTokens. ` +
        "Declare the published window in lib/models.ts. Without it the chat route's context guard is " +
        "skipped for this model and an over-limit request reaches the provider (ESTIMATE-03)."
    );
  }
}

// 2. The baseline may only shrink. An entry that now declares a window has to
//    be removed, or the list stops describing the real gap and quietly grants
//    an exemption nobody is using.
for (const id of KNOWN_UNDECLARED_CONTEXT_WINDOW) {
  const model = guardedById.get(id);
  if (!model) {
    fail(
      `${id} is in the undeclared-window baseline but is no longer an enabled catalogue model. ` +
        "Remove the stale entry from scripts/check-router-context-window.mjs."
    );
    continue;
  }
  if (model.contextWindowTokens) {
    fail(
      `${id} now declares contextWindowTokens (${model.contextWindowTokens.toLocaleString("en-US")}). ` +
        "Remove it from the baseline in scripts/check-router-context-window.mjs -- the list may only shrink."
    );
  }
}

if (process.exitCode) {
  console.error(
    "\nRouter context-window check failed. An undeclared window is an unguarded model, " +
      "not a safe default."
  );
} else if (undeclared.length > 0) {
  console.log(
    `OK: no new undeclared models. ${undeclared.length} remain in the baseline and must be resolved ` +
      "before ESTIMATE-03 can be approved."
  );
} else {
  console.log("OK: every enabled catalogue model declares a context window.");
}
