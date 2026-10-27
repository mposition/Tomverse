// The worker CLIs' own model names (owner decision 2026-10-27): what the host
// refresh may send, how a name finds the Tomverse model that prices it, the
// chips the screen shows and the choices the editor offers.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  amuxCliModelLinkFor,
  amuxCliModelLinkMap,
  amuxCliModelOptions,
  amuxCliModelStatus,
  amuxTomverseModelAvailability,
  buildAmuxCliModelCatalogAdminView,
  parseAmuxCliModelCatalogAdminView,
  parseAmuxCliModelLinkChange,
  parseAmuxCliModelRefresh,
} from "../lib/amux/cliModelCatalogCore.ts";
import { readCodexModelsCache, readCopilotHelpConfig, readCursorModelList } from "../lib/amux/cliModelListReader.mjs";

const model = (id, overrides = {}) => ({ id, name: id.toUpperCase(), apiModel: id, provider: "anthropic",
  catalogDeleted: false, enabled: true, status: "enabled", replacementModelId: null, ...overrides });
const REGISTRY = [
  model("claude-opus-5-5"),
  model("claude-opus-5", { catalogDeleted: true, replacementModelId: "claude-opus-5-5" }),
  model("gpt-6-1-sol", { apiModel: "gpt-6.1-sol", provider: "openai" }),
  model("gpt-5-6-sol", { apiModel: "gpt-5.6-sol", provider: "openai", enabled: false, replacementModelId: "gpt-6-1-sol" }),
  model("kimi-k3", { provider: "moonshot" }),
];
const AT = "2026-10-27T02:00:00.000Z";
const view = buildAmuxCliModelCatalogAdminView({
  observed: [
    { cli: "cursor", cliModel: "claude-opus-5-5-high", displayName: "Claude Opus 5.5 1M High", listed: true, lastSeenAt: AT },
    { cli: "cursor", cliModel: "composer-2.5", displayName: "Composer 2.5", listed: true, lastSeenAt: AT },
    { cli: "cursor", cliModel: "gpt-5.6-sol-high", displayName: null, listed: false, lastSeenAt: "2026-10-20T00:00:00.000Z" },
    { cli: "copilot", cliModel: "kimi-k3", displayName: null, listed: true, lastSeenAt: AT },
  ],
  links: [
    { cli: "cursor", cliModel: "claude-opus-5-5-high", pricedModelId: "claude-opus-5-5" },
    { cli: "cursor", cliModel: "composer-2.5", pricedModelId: null },
  ],
  registry: REGISTRY,
});

test("a refresh is one CLI's whole list: bounded names, no duplicates, clean display names", () => {
  assert.deepEqual(parseAmuxCliModelRefresh({ cli: "copilot", models: [{ cliModel: "kimi-k3" }, { cliModel: "gpt-6.1-sol", displayName: " GPT​ 6.1 " }] }),
    { cli: "copilot", models: [{ cliModel: "kimi-k3", displayName: null }, { cliModel: "gpt-6.1-sol", displayName: "GPT 6.1" }] });
  for (const bad of [
    null, [], { cli: "devin", models: [{ cliModel: "x" }] }, { cli: "codex", models: [] },
    { cli: "codex", models: [{ cliModel: "a:b" }] }, { cli: "codex", models: [{ cliModel: "x" }, { cliModel: "x" }] },
    { cli: "codex", models: [{ cliModel: "x", displayName: "a\u0007b" }] },
    { cli: "codex", models: [{ cliModel: "x", displayName: "y".repeat(121) }] },
    { cli: "codex", models: Array.from({ length: 501 }, (_, index) => ({ cliModel: `m${index}` })) },
  ]) {
    assert.equal(parseAmuxCliModelRefresh(bad), null, JSON.stringify(bad)?.slice(0, 60));
  }
});

test("a link names an entry or holds the name; with none, the exact name decides", () => {
  const links = amuxCliModelLinkMap([{ cli: "cursor", cliModel: "x", pricedModelId: "kimi-k3" }, { cli: "cursor", cliModel: "y", pricedModelId: null }]);
  assert.deepEqual(amuxCliModelLinkFor(links, "cursor", "x"), { linked: true, pricedModelId: "kimi-k3" });
  assert.deepEqual(amuxCliModelLinkFor(links, "cursor", "y"), { linked: true, pricedModelId: null });
  assert.deepEqual(amuxCliModelLinkFor(links, "copilot", "x"), { linked: false });
  assert.deepEqual(parseAmuxCliModelLinkChange({ cli: "cursor", cliModel: "x", pricedModelId: null }), { cli: "cursor", cliModel: "x", pricedModelId: null });
  for (const bad of [{ cli: "devin", cliModel: "x", pricedModelId: null }, { cli: "cursor", cliModel: "", pricedModelId: null },
    { cli: "cursor", cliModel: "x", pricedModelId: "" }, { cli: "cursor", cliModel: "x", pricedModelId: 7 }]) {
    assert.equal(parseAmuxCliModelLinkChange(bad), null, JSON.stringify(bad));
  }
});

test("Admin › Models' own state decides retired and disabled", () => {
  assert.equal(amuxTomverseModelAvailability({ catalogDeleted: true, enabled: true, status: "enabled" }), "retired");
  assert.equal(amuxTomverseModelAvailability({ catalogDeleted: false, enabled: false, status: "enabled" }), "disabled");
  assert.equal(amuxTomverseModelAvailability({ catalogDeleted: false, enabled: true, status: "coming-soon" }), "disabled");
  assert.equal(amuxTomverseModelAvailability({ catalogDeleted: false, enabled: true, status: "limited" }), "available");
});

test("each chip says what is wrong with a worker's model, and names the replacement", () => {
  assert.deepEqual(amuxCliModelStatus(view, "cursor", "claude-opus-5-5-high").issues, []);
  assert.equal(amuxCliModelStatus(view, "cursor", "claude-opus-5-5-high").source, "link");
  // Held by the owner: no price, whatever an exact name would say.
  assert.deepEqual(amuxCliModelStatus(view, "cursor", "composer-2.5").issues, ["unpriced"]);
  // An exact name by API model, disabled in Tomverse, no longer listed by Cursor... except Codex has no refresh yet.
  const codex = amuxCliModelStatus(view, "codex", "gpt-5.6-sol");
  assert.deepEqual(codex.issues, ["disabled"]);
  assert.equal(codex.replacement?.id, "gpt-6-1-sol");
  assert.deepEqual(amuxCliModelStatus(view, "claude", "claude-opus-5").issues, ["retired"]);
  assert.equal(amuxCliModelStatus(view, "claude", "claude-opus-5").replacement?.id, "claude-opus-5-5");
  // Cursor was read, and no longer lists this name, which also prices from nothing.
  assert.deepEqual(amuxCliModelStatus(view, "cursor", "gpt-5.6-sol-high").issues, ["unpriced", "unlisted"]);
  assert.deepEqual(amuxCliModelStatus(view, "copilot", "kimi-k3").issues, []);
});

test("the editor offers what the CLI lists, Admin models for Claude and Codex before a refresh, and keeps the current value", () => {
  assert.deepEqual(amuxCliModelOptions(view, "cursor", "").map((option) => option.value), ["claude-opus-5-5-high", "composer-2.5"]);
  assert.deepEqual(amuxCliModelOptions(view, "codex", "").map((option) => option.value), ["gpt-6.1-sol"]);
  assert.deepEqual(amuxCliModelOptions(view, "claude", "claude-opus-5").map((option) => [option.value, option.issues]),
    [["claude-opus-5", ["retired"]], ["claude-opus-5-5", []]]);
  assert.deepEqual(amuxCliModelOptions(view, "copilot", "").map((option) => option.value), ["kimi-k3"]);
});

test("the view survives JSON exactly, and anything else in its place is refused", () => {
  assert.deepEqual(parseAmuxCliModelCatalogAdminView(JSON.parse(JSON.stringify(view))), view);
  assert.equal(view.refreshedAt.cursor, AT);
  assert.equal(view.refreshedAt.codex, null);
  for (const broken of [null, { ...view, entries: "x" }, { ...view, refreshedAt: { ...view.refreshedAt, cursor: "soon" } },
    { ...view, entries: [{ ...view.entries[0], cli: "devin" }] }, { ...view, models: [{ ...view.models[0], availability: "gone" }] }]) {
    assert.equal(parseAmuxCliModelCatalogAdminView(broken), null);
  }
});

test("the host readers take each CLI's own listing and nothing else", () => {
  assert.deepEqual(readCursorModelList("Available models\n\nauto - Auto (current, default)\nclaude-opus-5-5-high - Claude Opus 5.5 1M High\ngrok-4.7-low-fast - Grok 4.7  Low Fast​​\nnot a model line\n"),
    [{ cliModel: "claude-opus-5-5-high", displayName: "Claude Opus 5.5 1M High" }, { cliModel: "grok-4.7-low-fast", displayName: "Grok 4.7 Low Fast" }]);
  assert.deepEqual(readCodexModelsCache(JSON.stringify({ models: [
    { slug: "gpt-6.1-sol", display_name: "GPT-6.1-Sol", visibility: "list" },
    { slug: "gpt-reserve", display_name: "Reserve", visibility: "hide" },
  ] })), [{ cliModel: "gpt-6.1-sol", displayName: "GPT-6.1-Sol" }]);
  assert.deepEqual(readCodexModelsCache("not json"), []);
  assert.deepEqual(readCopilotHelpConfig([
    "  `logLevel`: log level", "", "  `model`: AI model to use", '    - "kimi-k3"', '    - "gpt-6.1-sol"',
    "", "  `contextTier`: context window tier", '    - "long_context"',
  ].join("\n")), [{ cliModel: "kimi-k3", displayName: null }, { cliModel: "gpt-6.1-sol", displayName: null }]);
});

test("the refresh script sends only to an https or loopback Tomverse, with the monitor's credential", () => {
  const source = readFileSync(new URL("../scripts/amux-cli-models-refresh.mjs", import.meta.url), "utf8");
  assert.match(source, /\/api\/internal\/amux\/cli-models/);
  assert.match(source, /TOMVERSE_AMUX_CLI_MONITOR_SECRET/);
  assert.match(source, /url\.protocol !== "https:"/);
  // No model is called: the listing commands and Codex's cache only.
  assert.match(source, /"--list-models"/);
  assert.match(source, /\["help", "config"\]/);
  assert.doesNotMatch(source, /"-p"|--prompt|exec"/);
});

test("a CLI has choices only when it lists names, or Admin › Models has its vendor's", async () => {
  const { amuxCliModelHasChoices } = await import("../lib/amux/cliModelCatalogCore.ts");
  assert.equal(amuxCliModelHasChoices(view, "cursor"), true);
  assert.equal(amuxCliModelHasChoices(view, "copilot"), true);
  assert.equal(amuxCliModelHasChoices(view, "codex"), true);
  const empty = buildAmuxCliModelCatalogAdminView({ observed: [], links: [], registry: REGISTRY });
  assert.equal(amuxCliModelHasChoices(empty, "copilot"), false);
  assert.equal(amuxCliModelHasChoices(empty, "cursor"), false);
  assert.equal(amuxCliModelHasChoices(empty, "claude"), true);
});
