import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AVAILABLE_MODELS } from "../lib/models.ts";
import {
  anthropicPromptCacheApplies,
  ANTHROPIC_PROMPT_CACHE_PATHS,
} from "../lib/anthropicPromptCaching.ts";
import { createChatBudget } from "../lib/chatSecurity.ts";
import { getModelGenerationSettings } from "../lib/modelGenerationCompatibility.ts";

/**
 * A caching path has three parts, and this is the test that they are all
 * present.
 *
 * The three:
 *
 *   1. `createChatBudget(..., { promptCachePath })` -- the provider budget
 *      authorises the 1.25x cache-write premium *before* the request goes out.
 *   2. `getModelGenerationSettings(..., { promptCachePath })` -- the request
 *      carries the marker.
 *   3. `settleChatUsage(..., { cacheWriteInputTokens })`, fed from
 *      `usage.inputTokenDetails.cacheWriteTokens` -- the write is billed at
 *      1.25x rather than falling into the uncached remainder at 1.0x.
 *
 * Why a test and not review: every way of getting this wrong is silent. A path
 * with (2) and not (1) dispatches anyway -- an under-authorised turn is not
 * refused, it is simply spending money the guardrail did not see. A path with
 * (2) and not (3) settles anyway, 25% light, and the figure looks plausible.
 * Neither raises, neither logs, and the only symptom is a provider bill that
 * does not match the internal ledger some weeks later.
 *
 * That is not hypothetical. `comparison_review`, `comparison_review_verify_item`
 * and `compare_summary` shipped as `caches: true` with only part (2), and the
 * suite at the time asserted the three-way agreement for `chat_turn` and
 * `chat_fallback_turn` only -- so the two paths that were wired were the two
 * that were checked, and the coverage gap and the defect had the same shape.
 * This file is keyed on the path table itself, so a new path is covered by
 * existing to be covered.
 */

const ROOT = join(import.meta.dirname, "..");
const sourceOf = (path) => readFileSync(join(ROOT, path), "utf8");

/**
 * Where each path's three parts live.
 *
 * Hand-written rather than discovered, for the reason
 * `PROCESSING_TIER_REQUEST_ALLOWLIST` is: a scanner that infers the mapping
 * would also infer it for a path somebody wired wrongly, and agree with them.
 * Every entry below is a claim a person made, and the completeness check under
 * it fails when the tree stops matching.
 *
 * `settlement` can name a different file from `request`: a fallback attempt is
 * planned in `lib/chatAttemptExecution.ts` and settled by the chat route that
 * dispatched it, and pinning the settlement to the planning file would pass a
 * path whose usage never reaches a ledger.
 */
const PATH_CALL_SITES = {
  chat_turn: {
    budget: ["app/api/chat/route.ts"],
    request: ["app/api/chat/route.ts"],
    settlement: ["app/api/chat/route.ts"],
  },
  chat_fallback_turn: {
    budget: ["lib/chatAttemptExecution.ts"],
    request: ["lib/chatAttemptExecution.ts"],
    // The chat route owns `settleSafely` for every attempt of a turn,
    // including one this plan produced.
    settlement: ["app/api/chat/route.ts"],
  },
  comparison_review: {
    budget: [],
    request: [
      "lib/comparisonReviewService.ts",
      "lib/aiReviewEvalLiveAdapter.ts",
    ],
    settlement: [],
  },
  comparison_review_verify_item: {
    budget: [],
    request: [
      "app/api/conversations/[conversationId]/comparison-reviews/verify-item/route.ts",
    ],
    settlement: [],
  },
  compare_summary: {
    budget: [],
    request: [
      "app/api/chat/compare-summary/route.ts",
      "app/api/conversations/[conversationId]/compare-summary/route.ts",
    ],
    settlement: [],
  },
  conversation_title: { budget: [], request: [], settlement: [] },
  provider_probe: { budget: [], request: [], settlement: [] },
  provider_verification: { budget: [], request: [], settlement: [] },
  memory_extraction: { budget: [], request: [], settlement: [] },
};

/**
 * Which call a `promptCachePath:` literal belongs to.
 *
 * Walks backwards from the literal to whichever of the two call names appears
 * most recently before it. Crude, and enough: the option is passed in an object
 * literal argument, so the call that opened it is the nearest one behind. What
 * this rules out is the failure a plain substring search cannot see -- a path
 * named in a comment, or handed to the request builder while the file's budget
 * call goes without.
 */
const owningCallOf = (source, literalIndex) => {
  const before = source.slice(0, literalIndex);
  const budgetAt = before.lastIndexOf("createChatBudget(");
  const requestAt = before.lastIndexOf("getModelGenerationSettings(");
  if (budgetAt < 0 && requestAt < 0) return null;
  return budgetAt > requestAt ? "budget" : "request";
};

/** Every `promptCachePath: "<name>"` in a file, with the call it belongs to. */
const cachePathCallsIn = (path) => {
  const source = sourceOf(path);
  const calls = [];
  const pattern = /promptCachePath:\s*"([a-z_]+)"/g;
  for (const match of source.matchAll(pattern)) {
    calls.push({
      path: match[1],
      call: owningCallOf(source, match.index),
    });
  }
  return calls;
};

const FILES_THAT_NAME_A_PATH = [
  ...new Set(
    Object.values(PATH_CALL_SITES).flatMap((sites) => [
      ...sites.budget,
      ...sites.request,
    ])
  ),
];

const anthropicModel = () => {
  const found = AVAILABLE_MODELS.find(
    (candidate) => candidate.provider === "anthropic" && candidate.enabled
  );
  assert.ok(found, "the registry has an enabled Anthropic model");
  return found;
};

// ---------------------------------------------------------------------------
// The three-way rule
// ---------------------------------------------------------------------------

test("every caching path is wired for budget, request and settlement", () => {
  const caching = Object.entries(ANTHROPIC_PROMPT_CACHE_PATHS)
    .filter(([, policy]) => policy.caches)
    .map(([path]) => path);
  assert.ok(caching.length > 0, "at least one path caches");

  for (const path of caching) {
    const sites = PATH_CALL_SITES[path];
    assert.ok(sites, `${path} has no entry in PATH_CALL_SITES`);

    for (const part of ["budget", "request", "settlement"]) {
      assert.ok(
        sites[part].length > 0,
        `${path} caches but names no ${part} call site. A caching path needs ` +
          `all three: the budget authorises the write premium, the request ` +
          `carries the marker, and settlement bills the write. Two of three ` +
          `fails silently in both directions.`
      );
    }

    // 1. The budget call really names this path, in the file that claims it.
    for (const file of sites.budget) {
      const calls = cachePathCallsIn(file).filter(
        (entry) => entry.path === path && entry.call === "budget"
      );
      assert.equal(
        calls.length >= 1,
        true,
        `${file} is listed as ${path}'s budget site but no createChatBudget call there passes promptCachePath: "${path}"`
      );
    }

    // 2. The request call likewise.
    for (const file of sites.request) {
      const calls = cachePathCallsIn(file).filter(
        (entry) => entry.path === path && entry.call === "request"
      );
      assert.equal(
        calls.length >= 1,
        true,
        `${file} is listed as ${path}'s request site but no getModelGenerationSettings call there passes promptCachePath: "${path}"`
      );
    }

    // 3. The settlement forwards the provider's write count. Both halves are
    //    named: reading `cacheWriteTokens` and never passing it on is the same
    //    undercount as never reading it.
    for (const file of sites.settlement) {
      const source = sourceOf(file);
      assert.match(
        source,
        /inputTokenDetails\.\s*cacheWriteTokens/,
        `${file} settles ${path} and never reads usage.inputTokenDetails.cacheWriteTokens`
      );
      assert.match(
        source,
        /cacheWriteInputTokens/,
        `${file} settles ${path} and never passes cacheWriteInputTokens to settlement`
      );
    }
  }
});

test("no path is wired for the budget without also being wired for the request", () => {
  // The asymmetry rule, and it holds whether or not the path caches today.
  //
  // A budget site with no request site would reserve a premium for a marker
  // nothing sends: money held on every turn and refunded at settlement, which
  // surfaces as a guardrail refusing requests for spending that never
  // happened. The opposite asymmetry -- a request site with no budget site --
  // is the defect this whole change exists to close, but it is only harmful
  // while the path caches, and the three-way rule above is what refuses it
  // then. So this one is stated in the direction that is wrong at any time.
  for (const [path, sites] of Object.entries(PATH_CALL_SITES)) {
    if (sites.budget.length === 0) continue;
    assert.ok(
      sites.request.length > 0,
      `${path} names a budget call site and no request site, so it would reserve a premium for a marker no request sends`
    );
  }
});

test("a disabled path with wiring still sends no marker and reserves nothing", () => {
  // `chat_fallback_turn` is fully wired and switched off in the table. That is
  // a deliberate state -- the wiring is what a re-enable would need, and the
  // table is what withholds it -- and it is safe only because both halves read
  // the *same* table. This pins that they do: neither the marker nor the
  // premium may appear while the entry says `caches: false`.
  const model = anthropicModel();
  for (const [path, policy] of Object.entries(ANTHROPIC_PROMPT_CACHE_PATHS)) {
    if (policy.caches) continue;
    const wired =
      PATH_CALL_SITES[path].budget.length > 0 ||
      PATH_CALL_SITES[path].request.length > 0;
    if (!wired) continue;
    const settings = getModelGenerationSettings(model, {
      promptCachePath: path,
    });
    assert.equal(
      settings.providerOptions?.anthropic?.cacheControl,
      undefined,
      `${path} is disabled but its request would still carry a cache marker`
    );
    assert.equal(
      createChatBudget("user", model, 20_000, { promptCachePath: path })
        .promptCacheWriteReservedPremiumMicroUsd,
      0,
      `${path} is disabled but its budget would still reserve a premium`
    );
  }
});

test("PATH_CALL_SITES accounts for every promptCachePath literal in the tree", () => {
  // The completeness half. Without it a new call site could name a caching
  // path from a file nobody listed, and every assertion above would still
  // pass -- they check the sites that are claimed, not the ones that exist.
  const declared = new Set(
    Object.entries(PATH_CALL_SITES).flatMap(([path, sites]) => [
      ...sites.budget.map((file) => `${file}::${path}::budget`),
      ...sites.request.map((file) => `${file}::${path}::request`),
    ])
  );

  for (const file of FILES_THAT_NAME_A_PATH) {
    for (const entry of cachePathCallsIn(file)) {
      assert.ok(
        entry.call,
        `${file} names promptCachePath: "${entry.path}" outside any recognised call`
      );
      assert.ok(
        declared.has(`${file}::${entry.path}::${entry.call}`),
        `${file} passes promptCachePath: "${entry.path}" to the ${entry.call} call and PATH_CALL_SITES does not say so`
      );
    }
  }
});

test("every path in the policy table has a call-site entry, and vice versa", () => {
  assert.deepEqual(
    Object.keys(PATH_CALL_SITES).sort(),
    Object.keys(ANTHROPIC_PROMPT_CACHE_PATHS).sort(),
    "the call-site map and the policy table must name the same paths"
  );
});

// ---------------------------------------------------------------------------
// The same rule, executed rather than read
// ---------------------------------------------------------------------------

test("a caching path reserves a premium and a non-caching one does not", () => {
  // The text checks above prove the wiring exists; this proves it does
  // something. Run against a real Anthropic model, because the premium is zero
  // for every other provider whatever the path says.
  const model = anthropicModel();
  for (const [path, policy] of Object.entries(ANTHROPIC_PROMPT_CACHE_PATHS)) {
    const budget = createChatBudget("user", model, 20_000, {
      promptCachePath: path,
    });
    if (policy.caches) {
      assert.ok(
        budget.promptCacheWriteReservedPremiumMicroUsd > 0,
        `${path} caches, so its budget must authorise the write premium`
      );
      assert.equal(anthropicPromptCacheApplies(model, path), true);
    } else {
      assert.equal(
        budget.promptCacheWriteReservedPremiumMicroUsd,
        0,
        `${path} does not cache, so its budget must authorise no premium`
      );
      assert.equal(anthropicPromptCacheApplies(model, path), false);
    }
  }
});

test("the first launch scope is chat_turn alone", () => {
  // A deliberate pin on the scope itself, so widening it is an edit somebody
  // makes on purpose and defends with the evidence in
  // docs/policy/anthropic-prompt-caching.md section 2.1 -- rather than a line
  // that drifts back to `true` because the rationale field still reads as an
  // argument for caching.
  const caching = Object.entries(ANTHROPIC_PROMPT_CACHE_PATHS)
    .filter(([, policy]) => policy.caches)
    .map(([path]) => path);
  assert.deepEqual(caching, ["chat_turn"]);
});

test("a review re-run is not evidence for re-enabling comparison_review", () => {
  // Recorded as a test because it is the specific argument that put this path
  // on `true` in the first place: "one comparison is reviewed more than once".
  // It is true and it is not about prompt caching -- the second run is
  // answered from the stored row, so the request that would have read the
  // prompt cache is the one that never reaches the provider.
  const source = sourceOf("lib/anthropicPromptCaching.ts");
  assert.equal(ANTHROPIC_PROMPT_CACHE_PATHS.comparison_review.caches, false);
  assert.match(
    source,
    /input hash|input-hash/i,
    "the comparison_review rationale must name why a re-run is not evidence"
  );
});
