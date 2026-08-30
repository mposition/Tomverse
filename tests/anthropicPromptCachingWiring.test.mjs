import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
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
 * The only symptom is a provider bill that stops matching the internal ledger
 * some weeks later.
 *
 * ## What this file learned from its own first version
 *
 * The first version derived the files it scanned from a hand-written map, and
 * checked settlement by asking whether the strings `cacheWriteTokens` and
 * `cacheWriteInputTokens` appeared *somewhere* in the file. Both are weaker
 * than they read:
 *
 *   - a new file that passes `promptCachePath` and is not added to the map is
 *     never scanned, so its "completeness" check was completeness over the
 *     files already declared -- which is circular;
 *   - `app/api/chat/route.ts` is thousands of lines with several settlement
 *     call sites, so deleting the write count from one of them leaves the
 *     strings present elsewhere and the check green.
 *
 * So the structural rules below are **repo-wide and per-call**, and do not
 * consult the map at all:
 *
 *   A. every object literal that harvests `cacheReadTokens` also harvests
 *      `cacheWriteTokens` -- wherever the provider's read count is taken, the
 *      write count is taken with it;
 *   B. every `settleChatUsage(...)` call that passes `cachedInputTokens` also
 *      passes `cacheWriteInputTokens`, checked inside that call's own balanced
 *      parentheses.
 *
 * Neither has an allowlist, and neither can be satisfied by a string somewhere
 * else in the same file. The map that remains covers only the two things a
 * scanner genuinely cannot infer: which call a `promptCachePath` belongs to,
 * and which file settles a path dispatched from another one.
 */

const ROOT = join(import.meta.dirname, "..");
const sourceOf = (path) => readFileSync(join(ROOT, path), "utf8");

/** Every source file under the directories that can dispatch a turn. */
const SCANNED_ROOTS = ["app", "lib", "scripts", "components"];
const SKIP_DIRECTORIES = new Set(["node_modules", ".next", "dist", "build"]);

const walk = (directory, out = []) => {
  for (const entry of readdirSync(directory)) {
    if (SKIP_DIRECTORIES.has(entry)) continue;
    const full = join(directory, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mts|mjs)$/.test(entry)) out.push(relative(ROOT, full));
  }
  return out;
};

const ALL_SOURCES = SCANNED_ROOTS.flatMap((root) => walk(join(ROOT, root)));

/**
 * The slice of `source` inside the brackets opened at `openIndex`.
 *
 * Naive about strings and comments, and adequate for what it is used on: the
 * argument list of a call and the body of an object literal in this
 * repository's own code. It exists so a check can say "in *this* call" instead
 * of "somewhere in this file", which is the whole difference between the two
 * versions of this file.
 */
const balancedSlice = (source, openIndex, open = "(", close = ")") => {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    if (source[i] === open) depth += 1;
    else if (source[i] === close) {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex, i + 1);
    }
  }
  return source.slice(openIndex);
};

/** Every `name(` call in a file, as its own balanced argument slice. */
const callsOf = (source, name) => {
  const slices = [];
  const needle = `${name}(`;
  let at = source.indexOf(needle);
  while (at !== -1) {
    slices.push(balancedSlice(source, at + name.length));
    at = source.indexOf(needle, at + needle.length);
  }
  return slices;
};

/** The innermost object literal enclosing `index`, or null. */
const enclosingObjectLiteral = (source, index) => {
  let depth = 0;
  for (let i = index; i >= 0; i -= 1) {
    if (source[i] === "}") depth += 1;
    else if (source[i] === "{") {
      if (depth === 0) return balancedSlice(source, i, "{", "}");
      depth -= 1;
    }
  }
  return null;
};

// ---------------------------------------------------------------------------
// A. Reads and writes are harvested together -- repo-wide, no allowlist
// ---------------------------------------------------------------------------

test("every place that harvests cacheReadTokens harvests cacheWriteTokens too", () => {
  // The invariant that makes the 25% undercount unrepresentable rather than
  // merely absent. It holds on paths that do not cache today: the write count
  // is zero there, so taking it costs nothing and a path re-enabled later is
  // already correct.
  const offenders = [];
  for (const file of ALL_SOURCES) {
    const source = sourceOf(file);
    if (!source.includes("cacheReadTokens")) continue;
    let at = source.indexOf("cacheReadTokens");
    while (at !== -1) {
      // A type declaration and a prose mention both name the field; only a
      // harvest -- an object literal reading it off a usage object -- pairs.
      const isTypeDeclaration = /^cacheReadTokens\??\s*:\s*(number|\|)/.test(
        source.slice(at, at + 60)
      );
      const literal = enclosingObjectLiteral(source, at);
      if (literal && !isTypeDeclaration && !literal.includes("cacheWriteTokens")) {
        offenders.push(`${file}: ${source.slice(at, at + 70).split("\n")[0]}`);
      }
      at = source.indexOf("cacheReadTokens", at + 1);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these read the provider's cache-read count with no write count beside it; a settlement built from them bills cache writes at 1.0x instead of 1.25x"
  );
});

test("every settleChatUsage call that settles reads also settles writes", () => {
  // Per call, inside its own parentheses. A file-level version of this passed
  // while one of app/api/chat/route.ts's several settlement sites was missing
  // the field, because another site still mentioned it.
  const offenders = [];
  for (const file of ALL_SOURCES) {
    const source = sourceOf(file);
    if (!source.includes("settleChatUsage(")) continue;
    for (const call of callsOf(source, "settleChatUsage")) {
      if (!call.includes("cachedInputTokens")) continue;
      if (!call.includes("cacheWriteInputTokens")) {
        offenders.push(`${file}: ${call.slice(0, 120).replace(/\s+/g, " ")}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "these settle a cache-read count and no cache-write count"
  );
});

test("the repo-wide checks actually have something to check", () => {
  // A structural rule over zero occurrences passes vacuously and would keep
  // passing if the field were renamed everywhere.
  const harvests = ALL_SOURCES.filter((f) =>
    sourceOf(f).includes("cacheReadTokens")
  );
  const settlements = ALL_SOURCES.filter((f) =>
    sourceOf(f).includes("settleChatUsage(")
  );
  assert.ok(harvests.length >= 4, `only ${harvests.length} harvest sites found`);
  assert.ok(
    settlements.length >= 4,
    `only ${settlements.length} settlement sites found`
  );
  assert.ok(ALL_SOURCES.length > 500, `only ${ALL_SOURCES.length} files scanned`);
});

// ---------------------------------------------------------------------------
// B. Each caching path is wired at a budget and a request call
// ---------------------------------------------------------------------------

/**
 * The two things a scanner cannot infer: which call a `promptCachePath`
 * belongs to, and which file settles a path dispatched from another one.
 *
 * `viaVariable` marks a path chosen from a variable rather than a literal. The
 * chat route picks between `chat_turn` and `chat_turn_native_search` once,
 * from `nativeSearchEnabled`, and hands the same variable to both calls. That
 * indirection is the point: two literals hundreds of lines apart are two
 * readings that can drift.
 */
const PATH_CALL_SITES = {
  chat_turn: {
    budget: ["app/api/chat/route.ts"],
    request: ["app/api/chat/route.ts"],
    settlement: ["app/api/chat/route.ts"],
    viaVariable: true,
  },
  chat_turn_native_search: {
    budget: ["app/api/chat/route.ts"],
    request: ["app/api/chat/route.ts"],
    settlement: ["app/api/chat/route.ts"],
    viaVariable: true,
  },
  chat_fallback_turn: {
    budget: ["lib/chatAttemptExecution.ts"],
    request: ["lib/chatAttemptExecution.ts"],
    // The chat route owns `settleSafely` for every attempt of a turn.
    settlement: ["app/api/chat/route.ts"],
  },
  comparison_review: {
    budget: [],
    request: ["lib/comparisonReviewService.ts", "lib/aiReviewEvalLiveAdapter.ts"],
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
 * Whether a call passes `promptCachePath`, and as what.
 *
 * Three shapes reach these helpers: an explicit literal, the
 * `promptCachePath,` shorthand, and `promptCachePath: someVariable`.
 */
const promptCachePathIn = (callSlice) => {
  const literal = callSlice.match(/promptCachePath:\s*"([a-z_]+)"/);
  if (literal) return { kind: "literal", value: literal[1] };
  if (/promptCachePath\s*[,}]/.test(callSlice)) {
    return { kind: "variable", value: "promptCachePath" };
  }
  const named = callSlice.match(/promptCachePath:\s*([A-Za-z_$][\w$]*)/);
  if (named) return { kind: "variable", value: named[1] };
  return null;
};

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
        `${path} caches but names no ${part} call site. All three are needed: the budget authorises the write premium, the request carries the marker, and settlement bills the write. Two of three fails silently.`
      );
    }
    for (const [part, fn] of [
      ["budget", "createChatBudget"],
      ["request", "getModelGenerationSettings"],
    ]) {
      for (const file of sites[part]) {
        const passing = callsOf(sourceOf(file), fn)
          .map(promptCachePathIn)
          .filter(Boolean)
          .filter((found) =>
            sites.viaVariable
              ? found.kind === "variable"
              : found.kind === "literal" && found.value === path
          );
        assert.ok(
          passing.length >= 1,
          `${file} is listed as ${path}'s ${part} site but no ${fn} call there passes it`
        );
      }
    }
  }
});

test("a path chosen from a variable is chosen once, from the path names", () => {
  // `viaVariable` is a claim that both calls read one value, and an unchecked
  // claim here is exactly the drift it exists to prevent.
  const route = sourceOf("app/api/chat/route.ts");
  const assignment = route.match(
    /const promptCachePath: AnthropicPromptCachePath = ([\s\S]{0,200}?);/
  );
  assert.ok(assignment, "the chat route must choose its path in one place");
  assert.match(assignment[1], /nativeSearchEnabled/);
  assert.match(assignment[1], /"chat_turn_native_search"/);
  assert.match(assignment[1], /"chat_turn"/);
  assert.equal(
    (route.match(/const promptCachePath\b/g) ?? []).length,
    1,
    "one assignment, so both call sites read the same value"
  );
});

test("promptCachePath is not passed from a file the map does not know", () => {
  // The completeness half, now genuinely repo-wide: the scan is over every
  // source file, not over the files the map already lists.
  const OWNERS = new Set([
    "lib/anthropicPromptCaching.ts",
    "lib/modelGenerationCompatibility.ts",
    "lib/chatSecurity.ts",
  ]);
  const declared = new Set(
    Object.entries(PATH_CALL_SITES).flatMap(([, sites]) => [
      ...sites.budget.map((file) => `${file}::budget`),
      ...sites.request.map((file) => `${file}::request`),
    ])
  );
  const seen = new Set();
  for (const file of ALL_SOURCES) {
    if (OWNERS.has(file)) continue;
    const source = sourceOf(file);
    if (!source.includes("promptCachePath")) continue;
    for (const [part, fn] of [
      ["budget", "createChatBudget"],
      ["request", "getModelGenerationSettings"],
    ]) {
      for (const call of callsOf(source, fn)) {
        if (!promptCachePathIn(call)) continue;
        const key = `${file}::${part}`;
        seen.add(key);
        assert.ok(
          declared.has(key),
          `${file} passes promptCachePath to ${fn} and PATH_CALL_SITES does not list it as a ${part} site`
        );
      }
    }
  }
  // And the reverse: a listed site whose call has gone is a stale claim.
  for (const key of declared) {
    assert.ok(
      seen.has(key),
      `PATH_CALL_SITES lists ${key} but no such call exists any more`
    );
  }
});

test("every path in the policy table has a call-site entry, and vice versa", () => {
  assert.deepEqual(
    Object.keys(PATH_CALL_SITES).sort(),
    Object.keys(ANTHROPIC_PROMPT_CACHE_PATHS).sort()
  );
});

test("no path is wired for the budget without also being wired for the request", () => {
  // A budget site with no request site would reserve a premium for a marker
  // nothing sends: money held every turn and refunded at settlement, which
  // surfaces as a guardrail refusing requests for spending that never happened.
  for (const [path, sites] of Object.entries(PATH_CALL_SITES)) {
    if (sites.budget.length === 0) continue;
    assert.ok(
      sites.request.length > 0,
      `${path} names a budget call site and no request site`
    );
  }
});

// ---------------------------------------------------------------------------
// C. The same rules, executed rather than read
// ---------------------------------------------------------------------------

const anthropicModel = () => {
  const found = AVAILABLE_MODELS.find(
    (candidate) => candidate.provider === "anthropic" && candidate.enabled
  );
  assert.ok(found, "the registry has an enabled Anthropic model");
  return found;
};

test("marker and premium agree for every model and every path", () => {
  // The completion criterion, executed over the whole catalogue rather than
  // argued: no (model, path) pair may have a request that carries a marker and
  // a budget that authorises no premium, or the reverse.
  const model = anthropicModel();
  for (const [path, policy] of Object.entries(ANTHROPIC_PROMPT_CACHE_PATHS)) {
    for (const candidate of AVAILABLE_MODELS) {
      let budget;
      try {
        budget = createChatBudget("user", candidate, 20_000, {
          promptCachePath: path,
        });
      } catch {
        // Plan and input-limit refusals are a different question.
        continue;
      }
      const marker = Boolean(
        getModelGenerationSettings(candidate, { promptCachePath: path })
          .providerOptions?.anthropic?.cacheControl
      );
      assert.equal(
        marker,
        budget.promptCacheWriteReservedPremiumMicroUsd > 0,
        `${candidate.id} / ${path}: marker and premium disagree`
      );
    }
    assert.equal(
      anthropicPromptCacheApplies(model, path),
      policy.caches,
      `${path} must apply exactly when the table says it caches`
    );
  }
});

test("the first launch scope is chat_turn alone", () => {
  // Widening this is an edit somebody makes on purpose and defends with the
  // evidence in docs/policy/anthropic-prompt-caching.md section 2.1.
  const caching = Object.entries(ANTHROPIC_PROMPT_CACHE_PATHS)
    .filter(([, policy]) => policy.caches)
    .map(([path]) => path);
  assert.deepEqual(caching, ["chat_turn"]);
});

test("a searching turn is a different path, and it does not cache", () => {
  // Anthropic writes the cache again on every iteration of the agentic loop a
  // server tool runs, and does so *because* the request carries a marker. The
  // reservation bounds one write of the estimated prompt, not N writes of a
  // prompt that grows with each search result, so the searching turn is held
  // out until that ceiling is proven.
  assert.equal(
    ANTHROPIC_PROMPT_CACHE_PATHS.chat_turn_native_search.caches,
    false
  );
  const model = anthropicModel();
  assert.equal(
    getModelGenerationSettings(model, {
      promptCachePath: "chat_turn_native_search",
    }).providerOptions?.anthropic?.cacheControl,
    undefined
  );
  assert.equal(
    createChatBudget("user", model, 20_000, {
      promptCachePath: "chat_turn_native_search",
    }).promptCacheWriteReservedPremiumMicroUsd,
    0
  );
  // The rationale names the mechanism, not a guess about the prefix.
  assert.match(
    ANTHROPIC_PROMPT_CACHE_PATHS.chat_turn_native_search.rationale,
    /agentic loop/
  );
});

test("a review re-run is not evidence for re-enabling comparison_review", () => {
  // The argument that put this path on `true`: "one comparison is reviewed
  // more than once". True, and not about prompt caching -- the second run is
  // answered from the stored row, so the request that would have read the
  // prompt cache never reaches the provider.
  assert.equal(ANTHROPIC_PROMPT_CACHE_PATHS.comparison_review.caches, false);
  assert.match(
    sourceOf("lib/anthropicPromptCaching.ts"),
    /input hash|input-hash/i,
    "the comparison_review rationale must name why a re-run is not evidence"
  );
});
