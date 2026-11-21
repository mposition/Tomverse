import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import { SEO_LOCALES } from "../lib/seo.ts";
import { cursorGuideContent, cursorGuideSeo, cursorGuideSource } from "../components/marketing/v2/cursor/cursorGuideContent.ts";
import {
  cursorGuideProviders,
  cursorGuideRenames,
  cursorGuideRows,
  filterCursorGuideRows,
  smartAdaptiveOnlyCount,
} from "../components/marketing/v2/cursor/cursorGuideModels.ts";

// Cursor connection guide (/developers/cursor, Figma draft approved 2026-11-21).
const cssPath = "components/marketing/v2/cursor/cursor-guide.css";
const css = readFileSync(cssPath, "utf8");
const root = postcss.parse(css);
const source = readFileSync("components/marketing/v2/cursor/CursorGuidePage.tsx", "utf8");

const shape = (value) => Array.isArray(value) ? value.map(shape)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]))
  : typeof value;
const placeholders = (value, path = "") => Array.isArray(value) || (value && typeof value === "object")
  ? Object.entries(value).flatMap(([key, child]) => placeholders(child, `${path}.${key}`))
  : typeof value === "string" ? [...value.matchAll(/\{[a-z]+\}/g)].map((match) => `${path}${match[0]}`) : [];

const model = (id, extra = {}) => ({
  id, name: id.toUpperCase(), provider: "openai", apiModel: id, enabled: true, status: "enabled", catalogDeleted: false,
  usageClass: "standard", minimumPlan: "Guest", creditWeight: 1, ...extra,
});

test("guide copy has the same structure and placeholders in every language", () => {
  const ko = cursorGuideSource.ko;
  for (const locale of SEO_LOCALES) {
    const copy = cursorGuideContent[locale];
    assert.ok(copy, `${locale}: missing copy`);
    assert.deepEqual(shape(copy), shape(ko), `${locale}: guide copy shape differs from Korean`);
    // Word order differs by language, so placeholders are compared as a set per string.
    assert.deepEqual(placeholders(copy).sort(), placeholders(ko).sort(), `${locale}: placeholders differ from Korean`);
    assert.ok(cursorGuideSeo[locale].title.trim() && cursorGuideSeo[locale].description.trim(), `${locale}: missing SEO copy`);
  }
});

test("facts the guide states match docs/policy/external-api.md in every language", () => {
  for (const locale of SEO_LOCALES) {
    const copy = cursorGuideContent[locale];
    const text = JSON.stringify(copy);
    assert.match(copy.hero.chips[0], /Pro/, `${locale}: Pro and above`);
    assert.match(text, /smart-adaptive/, `${locale}: names the Smart Adaptive id`);
    assert.match(text, /Override OpenAI Base URL/, `${locale}: Cursor's own setting name`);
    assert.match(text, /model_not_found/, `${locale}: the not-found error code`);
    assert.equal(copy.routing.rows.length, 4, `${locale}: four routing rows`);
    assert.equal(copy.toc.items.length, 8, `${locale}: one entry per section`);
    // Cursor's Tab completion and own models never use the key.
    assert.match(copy.notice.body, /Tab/, `${locale}: Tab is billed by Cursor`);
    // No GPT model in Cursor’s own list is a Tomverse model (owner, 2026-11-21): the
    // notice, the routing row and the not-found answer all say so.
    assert.match(copy.notice.body, /GPT/, `${locale}: notice warns about Cursor’s GPT list`);
    assert.match(copy.routing.rows[1].result, /model_not_found/, `${locale}: Cursor GPT row fails`);
    assert.match(copy.faq.items[2].a, /GPT/, `${locale}: not-found answer names Cursor’s GPT list`);
    // No stale model ids or hard-coded model counts in copy: the table reads the catalogue.
    assert.doesNotMatch(text, /gpt-5-6-luna|\b37\b/, `${locale}: stale id or fixed count`);
  }
});

test("the table lists the models a paid key can name, Smart Adaptive-only and research classes excluded", () => {
  const models = [
    model("gpt-6-luna"),
    model("gpt-6-2-sol", { usageClass: "premium-reasoning", creditWeight: 16, minimumPlan: "Pro" }),
    model("claude-opus-5-5", { provider: "anthropic", usageClass: "frontier", creditWeight: 32 }),
    model("gpt-6-2-astra", { usageClass: "apex", creditWeight: 80 }),
    model("sonar", { provider: "perplexity", usageClass: "research", creditWeight: 20 }),
    model("claude-haiku-5-5", { provider: "anthropic" }),
    model("gemini-flash-latest", { provider: "google", usageClass: "advanced", creditWeight: 4 }),
    model("off", { enabled: false }),
    model("deleted", { catalogDeleted: true }),
    model("disabled", { status: "disabled" }),
    model("mistral-small-4", { provider: "mistral" }),
  ];
  const rows = cursorGuideRows(models);
  assert.deepEqual(rows.map((row) => row.id), ["gpt-6-luna", "gpt-6-2-sol", "claude-haiku-5-5", "gemini-flash-latest", "mistral-small-4"]);
  assert.deepEqual(rows[1], { id: "gpt-6-2-sol", name: "GPT-6-2-SOL", provider: "openai", credits: 16 });
  assert.equal(smartAdaptiveOnlyCount(models), 2, "frontier and apex are counted, not listed");
  assert.deepEqual(cursorGuideProviders(rows), [{ provider: "openai", count: 2 }, { provider: "anthropic", count: 1 }, { provider: "google", count: 1 }, { provider: "mistral", count: 1 }]);
  assert.deepEqual(filterCursorGuideRows(rows, "HAIKU", null).map((row) => row.id), ["claude-haiku-5-5"]);
  assert.deepEqual(filterCursorGuideRows(rows, "", "google").map((row) => row.id), ["gemini-flash-latest"]);
  assert.deepEqual(filterCursorGuideRows(rows, "luna", "google"), []);
});

test("renamed ids follow the catalogue's replacement chain to a listed model", () => {
  const models = [
    model("gpt-6-luna"),
    model("gpt-5-6-luna", { enabled: false, replacementModelId: "gpt-6-luna" }),
    model("gemini-3-7-flash", { provider: "google", enabled: false, replacementModelId: "gemini-3-8-flash" }),
    model("gemini-3-8-flash", { provider: "google", enabled: false, replacementModelId: "gemini-flash-latest" }),
    model("gemini-flash-latest", { provider: "google" }),
    model("to-nowhere", { enabled: false, replacementModelId: "missing" }),
    model("loop-a", { enabled: false, replacementModelId: "loop-b" }),
    model("loop-b", { enabled: false, replacementModelId: "loop-a" }),
    model("still-listed", { replacementModelId: "gpt-6-luna" }),
  ];
  assert.deepEqual(cursorGuideRenames(models), [
    { from: "gemini-3-7-flash", to: "gemini-flash-latest" },
    { from: "gemini-3-8-flash", to: "gemini-flash-latest" },
    { from: "gpt-5-6-luna", to: "gpt-6-luna" },
  ]);
});

test("the page reads the live catalogue, keeps its ids and test ids, and injects no HTML", () => {
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML|<script/);
  assert.match(source, /useModelCatalog/);
  assert.match(source, /catalogLoaded/);
  for (const id of ["cursor-guide-page", "cursor-guide-title", "cursor-guide-primary-cta", "cursor-guide-models", "cursor-guide-model-search"]) assert.ok(source.includes(`"${id}"`), id);
  for (const id of ["before", "step-key", "step-cursor", "step-model", "routing", "models", "verify", "troubleshooting"]) assert.ok(source.includes(`"${id}"`), id);
  assert.doesNotMatch(source, /https:\/\/tomverse\.app\/(?!api\/v1)/);
});

test("every guide rule is scoped under .tv-page and uses the cg- prefix", () => {
  const unscoped = [];
  root.walkRules((rule) => {
    for (const selector of rule.selectors) {
      if (!/^\.tv-page(?=$|[\s.:[>+~,])/.test(selector.trim())) unscoped.push(selector);
    }
  });
  assert.deepEqual(unscoped, []);
  root.walkAtRules("keyframes", (at) => assert.fail(`no keyframes expected, found ${at.params}`));
});

test("guide text stays at or above the 11px floor and uses the locale font variables", () => {
  const small = [];
  root.walkDecls(/^font(-size)?$/, (decl) => {
    for (const [, value, unit] of decl.value.matchAll(/(?:^|[\s/(,])(\d*\.?\d+)(rem|px)\b/g)) {
      const px = Number(value) * (unit === "rem" ? 16 : 1);
      if (px > 0 && px < 11) small.push(`${decl.parent.selector} { ${decl.prop}: ${decl.value} }`);
    }
  });
  assert.deepEqual(small, []);
  assert.doesNotMatch(css, /font-family:\s*["']?Geist/);
});

test("the guide is a registered, localized marketing route in the sitemap", () => {
  const routes = readFileSync("lib/marketingRoutes.ts", "utf8");
  assert.equal((routes.match(/"\/developers\/cursor"/g) ?? []).length, 3, "exact path, localized base path and the constant");
  assert.match(readFileSync("app/sitemap.ts", "utf8"), /path: "\/developers\/cursor"/);
  assert.match(readFileSync("components/marketing/v2/developers/DevelopersPage.tsx", "utf8"), /CURSOR_GUIDE_PATH/);
  assert.match(readFileSync("components/settings/ExternalApiSettings.tsx", "utf8"), /external-api-cursor-guide/);
});
