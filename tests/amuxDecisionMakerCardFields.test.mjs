// Stage S2-2b1 (2026-10-18): the card's per-option effect class and paths.
//
// docs/policy/amux-decision-maker.md §4 has the worker declare an effect class
// for every option, with the repository paths a change option would touch
// (1 to 50). Local AMUX records the declaration (stage S2-1,
// vendor/amux/crates/amux-server/src/db/dm_ask.rs), and the bridge relay
// (stage S2-2b2) sends the recorded card to the app's routing route. These
// tests hold the app's card to local AMUX's recording -- the same lists and
// limits, read from the Rust source -- and to the policy's table, and fix what
// the router does with the new fields: it does not route on the class (§4),
// it refuses a form local AMUX never records (§3-7 and §5's path grammar), and
// it scans the paths for secrets (§3-8).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  DM_CARD_TEXT_KEYS,
  DM_CARD_TEXT_MAX_BYTES,
  DM_CHANGE_EFFECT_CLASSES,
  DM_CHANGE_PATHS_MAX,
  DM_CHANGE_PATHS_MIN,
  DM_CONTEXT_PATHS_MAX,
  DM_EFFECT_CLASSES,
  DM_REPOSITORY_PATH_MAX_BYTES,
  DM_RESOLUTIONS,
  dmCardText,
  dmCardTextBytes,
  dmOptionEffectWellFormed,
  parseDmCardText,
  routeDmQuestion,
} from "../lib/amux/decisionMakerCore.ts";
import { dmOptionSetDigest } from "../lib/amux/decisionMakerBodyCore.ts";
import { parseDmCard } from "../lib/amux/decisionMakerRequestCore.ts";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const localDmAsk = read("../vendor/amux/crates/amux-server/src/db/dm_ask.rs");
const policy = read("../docs/policy/amux-decision-maker.md");

const rustStrings = (name) => {
  const match = localDmAsk.match(new RegExp(`const ${name}: \\[&str; (\\d+)\\] = \\[([\\s\\S]*?)\\];`));
  assert.ok(match, `${name} is in dm_ask.rs`);
  const values = [...match[2].matchAll(/"([^"]*)"/g)].map((entry) => entry[1]);
  assert.equal(values.length, Number(match[1]), name);
  return values;
};
const rustUsize = (name) => {
  const match = localDmAsk.match(new RegExp(`pub const ${name}: usize = (\\d+);`));
  assert.ok(match, `${name} is in dm_ask.rs`);
  return Number(match[1]);
};
const policySection = (number) => {
  const start = policy.indexOf(`\n## ${number}. `);
  const end = policy.indexOf(`\n## ${number + 1}. `, start);
  assert.ok(start >= 0 && end > start, `section ${number}`);
  return policy.slice(start, end);
};

const option = (id, label, effect = "choice_only", paths = []) => ({ id, label, effect, paths });

const card = (overrides = {}) => ({
  askType: "decision",
  resolution: null,
  type: "task",
  tags: ["needs:you"],
  title: "Pick a cache key layout",
  question: "Should the cache key include the locale or only the model id?",
  options: [option("a", "Model id only"), option("b", "Model id and locale", "branch_code_change", ["lib/cache.ts"])],
  unblocks: "The cache module can be finished.",
  context: "Both layouts pass the current tests.",
  contextPaths: ["lib/cache.ts"],
  ...overrides,
});

const route = (cardValue) =>
  routeDmQuestion({
    killSwitch: false,
    instanceMode: "proposal",
    card: cardValue,
    askingProvider: "claude",
    throughput: { lastHour: 0, lastDay: 0 },
  });

const PROPOSAL = { route: "dm_proposal", instance: "decision-maker-openai", refusals: [] };

// ---------------------------------------------------------------------------
// The lists and limits: the policy's table and local AMUX's recording
// ---------------------------------------------------------------------------

test("the effect classes are section 4's table, in its order", () => {
  const section = policySection(4);
  assert.deepEqual([...section.matchAll(/^\| `([a-z_]+)` \|/gm)].map((entry) => entry[1]), [...DM_EFFECT_CLASSES]);
  // "변경 등급은 바꿀 저장소 경로 목록(1~50개)을 함께 적는다."
  assert.ok(section.includes("경로 목록(1~50개)"));
  assert.equal(DM_CHANGE_PATHS_MIN, 1);
  assert.equal(DM_CHANGE_PATHS_MAX, 50);
  assert.deepEqual([...DM_CHANGE_EFFECT_CLASSES], ["branch_code_change", "docs_change", "test_change"]);
  // The router does not route on the class because the policy says so; if a
  // later version starts using it, this fails before the router is changed.
  assert.ok(section.includes("v1에서 이 선언은 **라우팅에 쓰지 않는다.**"));
});

test("the lists and limits are local AMUX's, read from its source", () => {
  assert.deepEqual(rustStrings("EFFECT_CLASSES"), [...DM_EFFECT_CLASSES]);
  assert.deepEqual(rustStrings("CHANGE_EFFECT_CLASSES"), [...DM_CHANGE_EFFECT_CLASSES]);
  assert.match(localDmAsk, /pub const EFFECT_OTHER: &str = "other";/);
  assert.equal(rustUsize("CHANGE_PATHS_MIN"), DM_CHANGE_PATHS_MIN);
  assert.equal(rustUsize("CHANGE_PATHS_MAX"), DM_CHANGE_PATHS_MAX);
  assert.equal(rustUsize("CONTEXT_PATHS_MAX"), DM_CONTEXT_PATHS_MAX);
  assert.equal(rustUsize("REPOSITORY_PATH_MAX_BYTES"), DM_REPOSITORY_PATH_MAX_BYTES);
  assert.deepEqual(rustStrings("RESOLUTIONS"), [...DM_RESOLUTIONS]);
});

test("an option has local AMUX's four keys in its order, and the extension's keys map onto the card's", () => {
  // Local AMUX's option keys are the same words in the app, in the same order.
  assert.deepEqual(rustStrings("OPTION_KEYS"), ["id", "label", "effect", "paths"]);
  for (const stored of JSON.parse(dmCardText(card())).options) assert.deepEqual(Object.keys(stored), rustStrings("OPTION_KEYS"));
  // The extension's snake_case keys become the card's camelCase ones; the bridge relay renames them.
  const toCard = { options: "options", resolution: "resolution", context: "context", context_paths: "contextPaths" };
  assert.deepEqual(Object.keys(toCard), rustStrings("TYPED_ASK_KEYS"));
  for (const key of Object.values(toCard)) assert.ok(DM_CARD_TEXT_KEYS.includes(key), key);
});

// ---------------------------------------------------------------------------
// The router
// ---------------------------------------------------------------------------

test("every well-formed declaration routes the same: the router does not route on the class", () => {
  for (const effect of DM_EFFECT_CLASSES) {
    const paths = DM_CHANGE_EFFECT_CLASSES.includes(effect) ? ["lib/cache.ts"] : [];
    assert.deepEqual(route(card({ options: [option("a", "Do it", effect, paths)] })), PROPOSAL, effect);
  }
  // The bounds: one path and fifty.
  const fifty = Array.from({ length: DM_CHANGE_PATHS_MAX }, (_, index) => `src/${index}.rs`);
  for (const effect of DM_CHANGE_EFFECT_CLASSES) {
    assert.deepEqual(route(card({ options: [option("a", "Do it", effect, ["src/0.rs"])] })), PROPOSAL, effect);
    assert.deepEqual(route(card({ options: [option("a", "Do it", effect, fifty)] })), PROPOSAL, effect);
  }
  // No option, and options of different classes side by side.
  assert.deepEqual(route(card({ options: [] })), PROPOSAL);
  assert.deepEqual(
    route(card({ options: [option("a", "Wait"), option("b", "Defer", "wait_or_defer"), option("c", "Other", "other"), option("d", "Test", "test_change", ["tests/a.test.mjs"])] })),
    PROPOSAL,
  );
});

test("an option's class and paths are not term-list input; its label still is", () => {
  // Paths that name a term (workflows, migration) do not hit the list, as context paths never did.
  const paths = [".github/workflows/ci.yml", "prisma/migrations/20261018000000_x/migration.sql"];
  assert.deepEqual(route(card({ options: [option("a", "Edit the files", "branch_code_change", paths)] })), PROPOSAL);
  assert.deepEqual(route(card({ contextPaths: paths })), PROPOSAL);
  const labelled = route(card({ options: [option("a", "Edit .github/workflows/ci.yml", "branch_code_change", paths)] }));
  assert.equal(labelled.route, "operator");
  assert.deepEqual(labelled.refusals, ["irreversible_term"]);
});

test("an option outside the form local AMUX records goes to the operator, never rewritten", () => {
  const repeated = ["src/a.rs", "src/a.rs"];
  const fiftyOne = Array.from({ length: DM_CHANGE_PATHS_MAX + 1 }, (_, index) => `src/${index}.rs`);
  // The cases of local AMUX's own test, a_malformed_effect_declaration_is_recorded_as_other_not_refused,
  // each of which local AMUX records as `other` with no paths -- so none of them reaches the app as written.
  const outside = [
    option("a", "x", "ship_it"),
    option("a", "x", ""),
    option("a", "x", "Choice_only"),
    option("a", "x", "choice_only", ["src/0.rs"]),
    option("a", "x", "wait_or_defer", ["src/0.rs"]),
    option("a", "x", "other", ["src/0.rs"]),
    ...DM_CHANGE_EFFECT_CLASSES.flatMap((effect) => [
      option("a", "x", effect, []),
      option("a", "x", effect, fiftyOne),
      option("a", "x", effect, ["src/a.rs", "../b.rs"]),
      option("a", "x", effect, repeated),
    ]),
    // Section 5's path grammar, each refusal of repositoryPathRefusal.
    ...["", "a".repeat(DM_REPOSITORY_PATH_MAX_BYTES + 1), "/etc/passwd", "C:/x", "./a", "a//b", "a/", "a\\b", "a%2e", "a?b", "a#b", "a\nb"].map(
      (path) => option("a", "x", "docs_change", [path]),
    ),
  ];
  for (const malformed of outside) {
    assert.equal(dmOptionEffectWellFormed(malformed), false, JSON.stringify(malformed).slice(0, 80));
    const decision = route(card({ options: [option("b", "Fine"), malformed] }));
    assert.equal(decision.route, "operator", JSON.stringify(malformed).slice(0, 80));
    assert.deepEqual(decision.refusals, ["input_limit_exceeded"], JSON.stringify(malformed).slice(0, 80));
  }
  // A path at the byte limit is in the grammar.
  const atLimit = "a".repeat(DM_REPOSITORY_PATH_MAX_BYTES);
  assert.deepEqual(route(card({ options: [option("a", "x", "docs_change", [atLimit])] })), PROPOSAL);
});

test("the paths count towards section 5's 16 KiB on the card text", () => {
  const longPaths = Array.from({ length: DM_CHANGE_PATHS_MAX }, (_, index) => `${"d".repeat(190)}/${index}`);
  const withPaths = (context) => card({ context, options: [option("a", "Edit", "docs_change", longPaths)] });
  const base = dmCardTextBytes(withPaths(""));
  assert.ok(base > DM_CHANGE_PATHS_MAX * 190);
  const atCap = withPaths("x".repeat(DM_CARD_TEXT_MAX_BYTES - base));
  assert.equal(dmCardTextBytes(atCap), DM_CARD_TEXT_MAX_BYTES);
  assert.deepEqual(route(atCap), PROPOSAL);
  const over = withPaths("x".repeat(DM_CARD_TEXT_MAX_BYTES - base + 1));
  assert.deepEqual(route(over).refusals, ["input_limit_exceeded"]);
  // The same context without the paths is well under the cap.
  assert.ok(dmCardTextBytes(card({ context: over.context })) < DM_CARD_TEXT_MAX_BYTES);
});

test("a secret in an option's effect or paths is never sent", () => {
  // Built at runtime, so no literal in this file looks like a credential.
  const pat = ["gh", "p_", "a".repeat(36)].join("");
  for (const malformed of [option("a", "x", "docs_change", [`docs/${pat}.md`]), option("a", "x", pat)]) {
    const decision = route(card({ options: [malformed] }));
    assert.equal(decision.route, "operator");
    assert.ok(decision.refusals.includes("card_secret_detected"), JSON.stringify(decision.refusals));
  }
});

// ---------------------------------------------------------------------------
// The card text and the routing input's shape
// ---------------------------------------------------------------------------

test("the card text keeps every option's class and paths, and reads back as the same card", () => {
  const value = card({
    options: [
      option("a", "Wait", "wait_or_defer"),
      option("b", "Edit", "branch_code_change", ["lib/b.ts", "lib/a.ts"]),
      option("c", "Docs", "docs_change", ["docs/한글.md"]),
    ],
  });
  const text = dmCardText(value);
  assert.deepEqual(parseDmCardText(text), value);
  assert.deepEqual(
    JSON.parse(text).options,
    [
      { id: "a", label: "Wait", effect: "wait_or_defer", paths: [] },
      { id: "b", label: "Edit", effect: "branch_code_change", paths: ["lib/b.ts", "lib/a.ts"] },
      { id: "c", label: "Docs", effect: "docs_change", paths: ["docs/한글.md"] },
    ],
  );
  // The card text is a copy: changing the card afterwards does not change it.
  const paths = ["lib/a.ts"];
  const copied = card({ options: [option("a", "Edit", "branch_code_change", paths)] });
  const before = dmCardText(copied);
  paths.push("lib/b.ts");
  assert.notEqual(dmCardText(copied), before);
  assert.deepEqual(JSON.parse(before).options[0].paths, ["lib/a.ts"]);
});

test("the routing input takes an option only with its four keys, checked for shape, not for the class", () => {
  assert.deepEqual(parseDmCard(card()), card());
  // Shape only: a class off the list passes here and the router refuses it.
  const offList = card({ options: [option("a", "x", "ship_it", ["src/a.rs"])] });
  assert.deepEqual(parseDmCard(offList), offList);
  assert.deepEqual(route(parseDmCard(offList)).refusals, ["input_limit_exceeded"]);
  for (const options of [
    [{ id: "a", label: "x" }],
    [{ id: "a", label: "x", effect: "choice_only" }],
    [{ id: "a", label: "x", paths: [] }],
    [{ id: "a", label: "x", effect: "choice_only", paths: [], note: "y" }],
    [{ id: "a", label: "x", effect: null, paths: [] }],
    [{ id: "a", label: "x", effect: 1, paths: [] }],
    [{ id: "a", label: "x", effect: "docs_change", paths: "docs/a.md" }],
    [{ id: "a", label: "x", effect: "docs_change", paths: [1] }],
    [{ id: "a", label: "x", effect: "docs_change", paths: null }],
  ]) {
    assert.equal(parseDmCard(card({ options })), null, JSON.stringify(options));
  }
  // The extension's snake_case key is not the card's.
  const { contextPaths, ...rest } = card();
  assert.equal(parseDmCard({ ...rest, context_paths: contextPaths }), null);
});

test("section 9's option set digest binds ids and labels only; a result names the options by those", () => {
  // A change of class or paths is a new question revision on the local AMUX
  // side (dm_ask.rs, changing_the_extension_while_asking_is_a_new_revision),
  // so a new request; the digest a result is checked against is unchanged.
  const key = Buffer.alloc(32, 7);
  const options = card().options;
  const pairs = options.map(({ id, label }) => ({ id, label }));
  assert.equal(dmOptionSetDigest(key, options), dmOptionSetDigest(key, pairs));
  const reclassed = options.map((entry) => ({ ...entry, effect: "other", paths: [] }));
  assert.equal(dmOptionSetDigest(key, reclassed), dmOptionSetDigest(key, pairs));
  assert.match(localDmAsk, /fn changing_the_extension_while_asking_is_a_new_revision\(\)/);
  // A label is still part of it.
  assert.notEqual(dmOptionSetDigest(key, [{ ...pairs[0], label: "Other" }, pairs[1]]), dmOptionSetDigest(key, pairs));
});
