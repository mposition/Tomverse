import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import { SEO_LOCALES } from "../lib/seo.ts";
import { modelsPageContent } from "../components/marketing/v2/models/modelsPageContent.ts";

// The V2 models page (/models). Korean is the approved wording; every other locale
// keeps its shape and its placeholders. The page states no model, provider or credit
// figure of its own: all of them come from the live public catalogue.
const shape = (value) => Array.isArray(value) ? value.map(shape)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]))
  : typeof value;
const tokens = (value, path = "") => Array.isArray(value) || (value && typeof value === "object")
  ? Object.entries(value).flatMap(([key, child]) => tokens(child, `${path}.${key}`))
  : typeof value === "string" ? [...value.matchAll(/\{\w+\}/g)].map((match) => `${path}:${match[0]}`) : [];
const strings = (value) => Array.isArray(value) || (value && typeof value === "object")
  ? Object.values(value).flatMap(strings) : [String(value)];

const page = readFileSync("components/marketing/v2/models/ModelsPage.tsx", "utf8");
const css = readFileSync("components/marketing/v2/models/models-page.css", "utf8");

test("models page copy is complete in every language and keeps its placeholders", () => {
  const ko = modelsPageContent.ko;
  assert.deepEqual(Object.keys(modelsPageContent).sort(), [...SEO_LOCALES].sort());
  for (const locale of SEO_LOCALES) {
    const copy = modelsPageContent[locale];
    assert.deepEqual(shape(copy), shape(ko), `${locale}: models page copy shape differs from Korean`);
    assert.deepEqual(tokens(copy), tokens(ko), `${locale}: placeholders differ from Korean`);
    for (const text of strings(copy)) assert.ok(text.trim(), `${locale}: empty copy string`);
  }
});

test("models page copy states no provider count and no claim the catalogue cannot back", () => {
  // The provider count is the {n} placeholder, never a literal.
  assert.match(modelsPageContent.ko.hero.title[0], /\{n\}/);
  assert.doesNotMatch(JSON.stringify(modelsPageContent.ko), /공급자 \d+곳/);
  assert.doesNotMatch(JSON.stringify(modelsPageContent.en), /from \d+ providers/);
  // A bigger credit number is a bigger base cost, never a stronger answer.
  assert.doesNotMatch(JSON.stringify(modelsPageContent.ko), /클수록 (?:깊|강|뛰어)|가벼운 질문/);
  assert.match(modelsPageContent.ko.credits.body, /성능 순위는 아닙니다/);
  assert.match(modelsPageContent.en.credits.body, /not a performance ranking/);
  // The coding-tool claim is not in the catalogue, so the page does not make it.
  assert.doesNotMatch(JSON.stringify(modelsPageContent.ko), /코딩 도구/);
});

test("the plan, grade and capability filters are described in every language", () => {
  for (const locale of SEO_LOCALES) {
    const { list } = modelsPageContent[locale];
    for (const label of [list.plans.Guest, list.plans.Free, list.plans.Pro, list.features.image, list.features.reasoning, list.features.oneCredit]) {
      assert.ok(label.trim(), `${locale}: filter label`);
    }
    assert.match(list.count, /\{shown\}.*\{total\}/, `${locale}: count shows shown and total`);
  }
});

test("the page reads models from the public catalogue, not from the static list", () => {
  assert.match(page, /const \{ publicModels \} = useModelCatalog\(\)/);
  assert.doesNotMatch(page, /AVAILABLE_MODELS|enabledModels|ENABLED_MODELS|getModel\(/);
  assert.doesNotMatch(page, /ModelsPageContent/);
});

test("filtering is client state with pressed buttons and one live result count", () => {
  assert.equal([...page.matchAll(/role="status"/g)].length, 1, "one live region for the result count");
  assert.match(page, /aria-pressed=\{pressed\}/);
  assert.match(page, /aria-expanded=\{filtersOpen\}/);
  for (const state of ["setPlan", "setGrade", "setProvider", "setCaps", "setQuery"]) {
    assert.match(page, new RegExp(state), `${state} is client state`);
  }
  assert.doesNotMatch(page, /dangerouslySetInnerHTML|innerHTML|<script/);
});

test("model cards show the user-facing name and the catalogue's base credits", () => {
  const start = page.indexOf("<article");
  assert.ok(start > 0, "model card is rendered");
  const card = page.slice(start, page.indexOf("</article>", start));
  assert.match(card, /\{row\.model\.name\}<\/h3>/);
  assert.match(card, /data-testid="model-page-credit-cost"/);
  const visible = card.replace(/(key|data-model-id)=\{row\.model\.id\}/g, "");
  assert.doesNotMatch(visible, /\{row\.model\.id\}/, "the internal model id is not shown");
  // Credits come from the catalogue weight through the shared usage profile.
  assert.match(page, /getModelUsageProfile\(model\)/);
});

test("internal links are localized and the calculator link is /pricing#calc", () => {
  assert.match(page, /localizedPath\(lang, "\/pricing"\)\}#calc/);
  assert.match(page, /localizedPath\(lang, "\/products\/review"\)/);
  assert.match(page, /localizedPath\(lang, "\/products\/chat"\)/);
  assert.doesNotMatch(page, /href="\/(?:pricing|products|models)/);
  // The live status page opens in a new tab and says so.
  assert.match(page, /target="_blank" rel="noopener noreferrer"/);
});

test("both routes render the V2 page and keep their metadata", () => {
  const site = readFileSync("app/(site)/(marketing)/models/page.tsx", "utf8");
  const localized = readFileSync("app/[locale]/models/page.tsx", "utf8");
  for (const source of [site, localized]) {
    assert.match(source, /<ModelsPage \/>/);
    assert.match(source, /from "@\/components\/marketing\/v2\/models\/ModelsPage"/);
  }
  assert.match(site, /publicMarketingPageMetadata\("\/models"\)/);
  assert.match(localized, /localizedPublicPageMetadata\(props, "\/models"\)/);
});

// The stylesheet is a global CSS file imported by ModelsPage, so its only
// isolation is the .tv-page scope (same checks as tests/chatProductPageV2.test.mjs).
const root = postcss.parse(css);

test("every models page rule is scoped under .tv-page", () => {
  const unscoped = [];
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
    for (const selector of rule.selectors) {
      if (!/^\.tv-page(?=$|[\s.:[>+~,])/.test(selector.trim())) unscoped.push(selector);
    }
  });
  assert.deepEqual(unscoped, []);
});

test("models page classes and keyframes are prefixed so they cannot collide with another page's", () => {
  root.walkAtRules("keyframes", (at) => assert.match(at.params, /^tvm-/, at.params));
  const loose = new Set();
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
    for (const selector of rule.selectors) {
      for (const [, name] of selector.matchAll(/\.([a-z][\w-]*)/g)) {
        if (!/^(?:tv-page|m-[\w-]+|chip|btn|blue|green|amber|low|mid|high|mark)$/.test(name)) loose.add(name);
      }
    }
  });
  assert.deepEqual([...loose], []);
});

test("models page text stays at or above the 11px floor and uses the locale font variables", () => {
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

test("models page motion stops for visitors who prefer reduced motion", () => {
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.tv-page \.m-card \{ animation: none; \}/);
});
