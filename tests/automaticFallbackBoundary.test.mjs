import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { autoFallbackScope } from "../lib/autoFallbackGate.ts";
import { decideFallback } from "../lib/routingFallbackPolicy.ts";

/**
 * FALLBACK-02: "Automatic fallback never starts after a visible token."
 *
 * This file used to prove something stronger and much easier: that there was
 * no automatic model substitution *at all*, so the gate's metric was zero for
 * want of a mechanism. There is a mechanism now — routing policy §7's
 * pre-token provider fallback, in `app/api/chat/route.ts` — so the easy claim
 * is gone and the real one has to be made.
 *
 * What is asserted here, in order of how badly it would hurt to lose it:
 *
 *   1. the second model is dispatched only from a candidate the *Router*
 *      ranked, never from the provider-fallback suggestion table;
 *   2. nothing is substituted once the user has seen a token;
 *   3. a deployment that sets nothing substitutes nothing;
 *   4. the turn shapes outside the first cut's scope are refused by name.
 *
 * (1) and the import allowlist stay source scans for the reason they always
 * were: the claim is about every path through a 3,000-line handler, and a
 * runtime test only reports on the paths it happens to drive. (2) and (3) are
 * assertions against the decision functions themselves, which is where the
 * rule actually lives.
 */

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(root, path), "utf8");

const CHAT_ROUTE = "app/api/chat/route.ts";

/**
 * Every call site of the streaming primitive, with the identifier passed as
 * its `model`.
 */
export const streamModelArguments = (source) => {
  const found = [];
  // Brace-matched rather than indentation-matched: the call sits at whatever
  // depth its enclosing block puts it, and a regex anchored to one indent
  // silently finds nothing at another -- which reads as "no fallback" for the
  // wrong reason.
  for (const match of source.matchAll(/streamText\(\{/g)) {
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < source.length && depth > 0) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") depth -= 1;
      index += 1;
    }
    const options = source.slice(match.index + match[0].length, index - 1);
    // Top level of the options object only: a `model:` nested inside another
    // option is not the model the call runs.
    const model = /(?:^|\n)\s*model:\s*([^,\n]+)/.exec(
      options.replace(/\{[^{}]*\}/g, "{}")
    );
    found.push(model ? model[1].trim() : null);
  }
  return found;
};

/** `const NAME = ...` / `let NAME = ...` / `NAME = ...`, counted. */
export const assignmentCount = (source, name) => {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [
    ...source.matchAll(
      new RegExp(`(?:const|let|var)\\s+${escaped}\\s*=|(?:^|[;{}\\n])\\s*${escaped}\\s*=[^=]`, "g")
    ),
  ].length;
};

const sourceFiles = (dir, found = []) => {
  for (const entry of readdirSync(join(root, dir))) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(join(root, full)).isDirectory()) sourceFiles(full, found);
    else if ([".ts", ".tsx"].includes(extname(entry))) found.push(full);
  }
  return found;
};

test("the chat answer is streamed from exactly two models: the primary and one fallback", () => {
  const models = streamModelArguments(read(CHAT_ROUTE));
  assert.equal(
    models.length,
    2,
    `Expected two streamText calls in ${CHAT_ROUTE}, found ${models.length}. ` +
      "§6's two-build budget is one primary and one fallback; a third call " +
      "site is a third model, whatever the runtime budget says."
  );
});

test("the primary is still a single resolved model, not a choice", () => {
  const source = read(CHAT_ROUTE);
  const [primary] = streamModelArguments(source);
  assert.match(
    primary,
    /^[A-Za-z_$][\w$]*$/,
    `The primary streamText's model is \`${primary}\`. An expression here is ` +
      "where a candidate list would be selected from; it has to be a single " +
      "resolved model, chosen before the stream by the Router or by the user."
  );
  assert.equal(
    assignmentCount(source, primary),
    1,
    `\`${primary}\` is assigned more than once. Reassigning it is how a ` +
      "substitution arrives without a second call site."
  );
});

test("the fallback's model comes from a plan the Router's own filters produced", () => {
  const source = read(CHAT_ROUTE);
  const [, fallback] = streamModelArguments(source);
  assert.equal(
    fallback,
    "plan.activeModel",
    "The fallback must run the model in a plan built by planAttemptExecution, " +
      "which applies the same budget, window and capability checks the primary " +
      "passed (§6)."
  );
  // And the plan's model id has to have come from the Router's ranked
  // candidates, not from anywhere else in scope.
  assert.match(
    source,
    /nextCandidateModelIds: fallbackCandidates,/,
    "decideFallback must be given the Router's own candidate list"
  );
  assert.match(
    source,
    /const fallbackCandidates = autoSelection\.routed\s*\n?\s*\? autoSelection\.fallbackCandidateModelIds/,
    "fallbackCandidates must be the Router's eligible set, not a local list"
  );
});

test("the route never reaches for the provider-fallback suggestion table", () => {
  // The table names models to *offer* a user during an incident. Dispatching
  // from it would substitute a model that passed none of the Router's filters.
  const source = read(CHAT_ROUTE);
  for (const forbidden of [
    "PROVIDER_FALLBACKS",
    "selectFallbackCandidates",
    "findAlternativeModelsForBlockedProvider",
    "providerFallbackCandidates",
  ]) {
    assert.equal(
      source.includes(forbidden),
      false,
      `${CHAT_ROUTE} reads ${forbidden}. That table is a suggestion surface; ` +
        "the dispatched fallback comes from the Router."
    );
  }
});

test("only the surfaces that offer a choice import the fallback table", () => {
  /**
   * Each entry is a place that may name an alternative model, and what it does
   * with the name. None of them may dispatch it. A new importer is not
   * automatically wrong -- it is a decision that has to be made here, in the
   * open, with the reason written down.
   */
  const ALLOWED = {
    "lib/providerFallbackCandidates.ts": "the table itself",
    "lib/providerMonitoring.ts":
      "records provider health and the candidates an incident offers",
    "app/api/models/status/route.ts":
      "builds the incident banner's candidate list; returns `none` rather than substituting",
    "lib/chatSecurity.ts":
      "names models still reachable in a provider-budget refusal, before any stream exists",
    "components/chat/ProviderStatusBanner.tsx":
      "renders those candidates for the user to pick from",
  };

  const importers = [...sourceFiles("app"), ...sourceFiles("lib"), ...sourceFiles("components")]
    .filter((file) => read(file).includes("providerFallbackCandidates"))
    .map((file) => relative(".", file));

  const unexpected = importers.filter((file) => !(file in ALLOWED));
  assert.deepEqual(
    unexpected,
    [],
    "New importer(s) of the provider fallback table:\n" +
      unexpected.join("\n") +
      "\n\nThe table names models to *offer*. If a new caller acts on one instead " +
      "of showing it, FALLBACK-02 stops holding. Add it here with what it does."
  );

  const stale = Object.keys(ALLOWED).filter((file) => !importers.includes(file));
  assert.deepEqual(stale, [], "Allowlist entries that no longer import the table");
});

// The gate's own invariant, asserted where the rule lives rather than by
// reading the handler.
test("nothing is substituted once the user has seen a token", () => {
  for (const attempt of [
    { outcome: "failed_pre_token", failureLayer: "provider" },
    { outcome: "failed_post_token", failureLayer: "provider" },
  ]) {
    const decision = decideFallback({
      attempt: { modelId: "gpt-5-6-luna", ...attempt },
      run: { passThroughUsed: false, rerouteCount: 0, visibleTokenEmitted: true },
      nextCandidateModelIds: ["deepseek-v4-flash"],
    });
    assert.equal(decision.action, "terminate", JSON.stringify(attempt));
    assert.equal(decision.reason, "visible_token_emitted");
  }
});

test("the route asks about a visible token with what it actually emitted", () => {
  // The decision above is only as good as the value handed to it. Both the
  // classification and the run state must read the emitted text, not a flag
  // that could drift from it.
  const source = read(CHAT_ROUTE);
  const occurrences = [
    ...source.matchAll(/visibleTokenEmitted: generatedText\.length > 0/g),
  ];
  assert.equal(
    occurrences.length,
    2,
    "Both classifyStreamFailure and decideFallback must be told about the " +
      "visible token from `generatedText`, which is what was enqueued."
  );
});

test("a deployment that sets nothing substitutes nothing", () => {
  const scope = autoFallbackScope({
    routed: true,
    isGuest: false,
    toolsOffered: false,
    nativeSearchEnabled: false,
    deepResearch: false,
    hasAttachments: false,
    candidateCount: 2,
    environment: {},
  });
  assert.deepEqual(scope, { allowed: false, reason: "flag_off" });
});

test("the scan can tell a resolved model from a chosen one", () => {
  // A negative control for the scan itself, on inputs rather than on the tree:
  // if these did not discriminate, the assertions above would pass against a
  // handler that had started choosing from a list.
  const single = `const result = await streamText({\n        model: activeModel,\n        messages,\n    });`;
  assert.deepEqual(streamModelArguments(single), ["activeModel"]);

  const fromList = `const result = await streamText({\n        model: candidates[attempt],\n        messages,\n    });`;
  assert.deepEqual(streamModelArguments(fromList), ["candidates[attempt]"]);
  assert.equal(/^[A-Za-z_$][\w$]*$/.test("candidates[attempt]"), false);

  const three =
    `const a = await streamText({\n        model: one,\n    });\n` +
    `const b = await streamText({\n        model: two,\n    });\n` +
    `const c = await streamText({\n        model: three,\n    });`;
  assert.equal(streamModelArguments(three).length, 3);

  assert.equal(assignmentCount("const m = one;", "m"), 1);
  assert.equal(assignmentCount("let m = one;\n  m = two;", "m"), 2);
  // `===` is a comparison, not an assignment, and must not be counted as one.
  assert.equal(assignmentCount("const m = one;\n  if (m === two) {}", "m"), 1);
});
