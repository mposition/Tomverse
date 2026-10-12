import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  getWebSearchCapability,
  WEB_SEARCH_CAPABILITIES,
} from "../lib/webSearchCapability.ts";
import {
  isNameableReplacement,
  nativeSearchProviders,
  parseCatalogue,
  productConsistencyReport,
  REPLACEMENT_CHAIN_LIMIT,
  retiredReplacementFindings,
  RULES,
  webSearchRouteFindings,
} from "../scripts/report-product-consistency-core.mjs";

const model = (id, provider, extra = {}) => ({ id, name: id, provider, enabled: true, ...extra });

const webSearch = (models) =>
  webSearchRouteFindings({
    models,
    register: WEB_SEARCH_CAPABILITIES,
    capabilityOf: getWebSearchCapability,
  });

test("the catalogue is read whole or refused", () => {
  assert.ok(parseCatalogue(null).problems);
  assert.ok(parseCatalogue({ models: {} }).problems);
  assert.ok(parseCatalogue({ models: [] }).problems);
  assert.match(
    parseCatalogue({ models: [model("a", "openai"), model("a", "openai")] }).problems.join(),
    /appears twice/
  );
  assert.match(parseCatalogue({ models: [{ id: "a", provider: "openai" }] }).problems.join(), /enabled/);
  assert.match(
    parseCatalogue({ models: [model("a", "openai", { replacementModelId: 3 })] }).problems.join(),
    /replacementModelId/
  );
  // One bad row refuses the lot rather than reporting on the rows that parsed.
  const mixed = parseCatalogue({ models: [model("a", "openai"), { id: "b" }] });
  assert.equal(mixed.models, undefined);

  const parsed = parseCatalogue({
    models: [model("a", "openai", { icon: "x", replacementModelId: "", webSearchOverride: null })],
  });
  assert.deepEqual(parsed.models, [
    {
      id: "a",
      name: "a",
      provider: "openai",
      enabled: true,
      publiclyListed: undefined,
      catalogDeleted: undefined,
      replacementModelId: undefined,
      webSearchOverride: undefined,
    },
  ]);
});

test("native providers come from the register, and Google is not one of them", () => {
  const providers = nativeSearchProviders(WEB_SEARCH_CAPABILITIES);
  assert.ok(providers.has("openai"));
  assert.ok(providers.has("anthropic"));
  assert.equal(providers.has("google"), false);
  assert.equal(providers.has("perplexity"), false);
});

// Production, 2026-10-12: every enabled Claude model and the GPT-6 family were
// adopted at runtime, so none of them is in the register and all of them search
// through Brave, while the models they replaced searched natively.
test("a runtime successor of a native model is reported with what it replaced", () => {
  const findings = webSearch([
    model("claude-sonnet-5", "anthropic", { enabled: false, replacementModelId: "claude-sonnet-5-5" }),
    model("claude-sonnet-5-5", "anthropic"),
    model("gpt-6-luna", "openai"),
  ]);
  assert.deepEqual(findings, [
    {
      rule: RULES.webSearchNativeProviderOnAppBackend,
      modelId: "claude-sonnet-5-5",
      provider: "anthropic",
      searchBackend: "brave",
      nativePredecessors: ["claude-sonnet-5"],
    },
    {
      rule: RULES.webSearchNativeProviderOnAppBackend,
      modelId: "gpt-6-luna",
      provider: "openai",
      searchBackend: "brave",
      nativePredecessors: [],
    },
  ]);
});

test("models that are on their route by decision are not reported", () => {
  assert.deepEqual(
    webSearch([
      // Registered native.
      model("gpt-5-6-luna", "openai"),
      // Registered on the app backend on purpose.
      model("gpt-5-4-mini", "openai"),
      // Google is on the app backend because grounding has no ceiling.
      model("gemini-pro-latest", "google"),
      // No native tool attached for this provider at all.
      model("deepseek-flash", "deepseek"),
      // An administrator chose the route.
      model("gpt-6-astra", "openai", { webSearchOverride: "app-managed" }),
      model("gpt-6-1-sol", "openai", { webSearchOverride: "off" }),
      // Not reachable.
      model("claude-haiku-5-5", "anthropic", { enabled: false }),
      model("claude-opus-5-5", "anthropic", { catalogDeleted: true }),
    ]),
    []
  );
});

test("a retirement is reported only when the route would not name its replacement", () => {
  const findings = retiredReplacementFindings({
    models: [
      model("ok-old", "openai", { enabled: false, replacementModelId: "ok-new" }),
      model("ok-new", "openai"),
      model("gpt-5-6-sol", "openai", { enabled: false, replacementModelId: "gpt-6-sol" }),
      model("gpt-6-sol", "openai", { enabled: false, replacementModelId: "gpt-6-1-sol" }),
      model("gpt-6-1-sol", "openai"),
      model("gemini-3-5-flash", "google", { enabled: false, replacementModelId: "gemini-3-6-flash" }),
      model("gemini-3-6-flash", "google", { enabled: false }),
      model("to-unlisted", "openai", { enabled: false, replacementModelId: "unlisted" }),
      model("unlisted", "openai", { publiclyListed: false }),
      model("to-deleted", "openai", { enabled: false, replacementModelId: "deleted" }),
      model("deleted", "openai", { catalogDeleted: true }),
      model("to-absent", "openai", { enabled: false, replacementModelId: "nowhere" }),
      // An enabled model's replacement is never shown by that route.
      model("live", "openai", { replacementModelId: "gemini-3-6-flash" }),
    ],
  });
  assert.deepEqual(
    findings.map((finding) => [finding.modelId, finding.replacementState, finding.firstNameableSuccessor]),
    [
      ["gemini-3-5-flash", "disabled", null],
      // gpt-6-sol's own replacement is nameable, so only the first hop fails.
      ["gpt-5-6-sol", "disabled", "gpt-6-1-sol"],
      ["to-absent", "absent", null],
      ["to-deleted", "deleted", null],
      ["to-unlisted", "unlisted", null],
    ]
  );
});

test("a replacement cycle or an over-long chain ends without a successor", () => {
  const cycle = retiredReplacementFindings({
    models: [
      model("a", "openai", { enabled: false, replacementModelId: "b" }),
      model("b", "openai", { enabled: false, replacementModelId: "a" }),
    ],
  });
  assert.deepEqual(cycle.map((finding) => finding.firstNameableSuccessor), [null, null]);

  const chain = Array.from({ length: REPLACEMENT_CHAIN_LIMIT + 2 }, (_, index) =>
    model(`m${index}`, "openai", { enabled: false, replacementModelId: `m${index + 1}` })
  );
  chain.push(model(`m${REPLACEMENT_CHAIN_LIMIT + 2}`, "openai"));
  const [first] = retiredReplacementFindings({ models: chain }).filter((finding) => finding.modelId === "m0");
  assert.equal(first.firstNameableSuccessor, null);
});

// The rule restates the chat route's condition rather than importing it, so the
// route is read to keep the two from drifting apart.
test("the nameable-replacement rule matches the chat route's MODEL_RETIRED branch", () => {
  const route = readFileSync("app/api/chat/route.ts", "utf8");
  const start = route.indexOf("const replacementCandidate = catalogModel.replacementModelId");
  assert.notEqual(start, -1, "the MODEL_RETIRED branch moved; re-read it before trusting this report");
  const branch = route.slice(start, route.indexOf('"MODEL_RETIRED"', start));
  assert.match(branch, /runtimeModelMap\.get\(catalogModel\.replacementModelId\)/);
  for (const clause of [
    "replacementCandidate?.enabled",
    "replacementCandidate.publiclyListed !== false",
    "!replacementCandidate.catalogDeleted",
  ]) {
    assert.ok(branch.includes(clause), `the route no longer says ${clause}`);
  }
  assert.equal(isNameableReplacement(model("a", "openai")), true);
  assert.equal(isNameableReplacement(model("a", "openai", { enabled: false })), false);
  assert.equal(isNameableReplacement(model("a", "openai", { publiclyListed: false })), false);
  assert.equal(isNameableReplacement(model("a", "openai", { catalogDeleted: true })), false);
  assert.equal(isNameableReplacement(undefined), false);
});

test("the report counts what it lists", () => {
  const report = productConsistencyReport({
    models: [
      model("claude-sonnet-5-5", "anthropic"),
      model("old", "openai", { enabled: false, replacementModelId: "gone" }),
      model("deleted", "openai", { catalogDeleted: true }),
    ],
    register: WEB_SEARCH_CAPABILITIES,
    capabilityOf: getWebSearchCapability,
  });
  assert.deepEqual(report.catalogue, { models: 3, enabled: 1 });
  assert.deepEqual(report.counts, {
    [RULES.webSearchNativeProviderOnAppBackend]: 1,
    [RULES.retiredModelNamesNoSuccessor]: 1,
  });
  assert.equal(report.findings.length, 2);
});

// Spawned because what matters is what reaches the operator's screen, and the
// script is where the register and the catalogue meet.
const runReport = (args) =>
  spawnSync(
    process.execPath,
    ["--conditions=react-server", "--import", "tsx", "scripts/report-product-consistency.mjs", ...args],
    { cwd: process.cwd(), encoding: "utf8" }
  );

test("the script reads a saved catalogue, prints both rules and exits 0", () => {
  const dir = mkdtempSync(join(tmpdir(), "product-consistency-"));
  try {
    const file = join(dir, "catalog.json");
    writeFileSync(
      file,
      JSON.stringify({
        models: [
          model("claude-sonnet-5", "anthropic", { enabled: false, replacementModelId: "claude-sonnet-5-5" }),
          model("claude-sonnet-5-5", "anthropic"),
          model("gemini-3-5-flash", "google", { enabled: false, replacementModelId: "gemini-3-6-flash" }),
          model("gemini-3-6-flash", "google", { enabled: false }),
        ],
      })
    );
    const text = runReport(["--catalog-file", file]);
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /claude-sonnet-5-5 \(anthropic\) -> brave: not in WEB_SEARCH_CAPABILITIES; replaces claude-sonnet-5, which searches natively/);
    assert.match(text.stdout, /gemini-3-5-flash -> gemini-3-6-flash \(disabled\); no nameable successor/);
    assert.match(text.stdout, /A report, not a gate/);

    const json = runReport(["--catalog-file", file, "--json"]);
    assert.equal(json.status, 0, json.stderr);
    const body = JSON.parse(json.stdout);
    assert.equal(body.source, file);
    assert.deepEqual(body.counts, {
      [RULES.webSearchNativeProviderOnAppBackend]: 1,
      [RULES.retiredModelNamesNoSuccessor]: 1,
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the script refuses a body that is not a catalogue, and a URL that is not one", () => {
  const dir = mkdtempSync(join(tmpdir(), "product-consistency-"));
  try {
    const file = join(dir, "catalog.json");
    writeFileSync(file, JSON.stringify({ models: [{ id: "a" }] }));
    const bad = runReport(["--catalog-file", file]);
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /not a model catalogue/);
    assert.equal(bad.stdout, "");

    const url = runReport(["--catalog-url", "http://localhost:3000/api/models/catalog"]);
    assert.equal(url.status, 1);
    assert.match(url.stderr, /https URL ending in \/api\/models\/catalog/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
