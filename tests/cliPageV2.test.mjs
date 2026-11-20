import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import { SEO_LOCALES } from "../lib/seo.ts";
import { cliPageContent, cliPageSeo } from "../components/marketing/v2/cli/cliPageContent.ts";

const ko = cliPageContent.ko;
const shape = (value) => Array.isArray(value) ? value.map(shape)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]))
  : typeof value;
const strings = (value) => Array.isArray(value) ? value.flatMap(strings)
  : value && typeof value === "object" ? Object.values(value).flatMap(strings)
  : [value];

test("CLI page copy exists in every locale with the same structure as Korean", () => {
  assert.deepEqual(Object.keys(cliPageContent).sort(), [...SEO_LOCALES].sort());
  for (const locale of SEO_LOCALES) {
    const copy = cliPageContent[locale];
    assert.deepEqual(shape(copy), shape(ko), `${locale}: CLI page copy shape differs from Korean`);
    for (const text of strings(copy)) assert.ok(text.trim(), `${locale}: empty copy string`);
  }
});

test("CLI page keeps the first-run commands and the sections that say it is not published yet", () => {
  for (const locale of SEO_LOCALES) {
    const copy = cliPageContent[locale];
    assert.equal(copy.first.steps.length, 4, locale);
    assert.equal(copy.safe.ticks.length, 4, locale);
    // Commands and answers are not translated; only the task in quotes is.
    assert.deepEqual(copy.first.steps.map((step) => step.cmd).filter((_, i) => i !== 2), ["cd ~/projects/my-app", "tomverse models", "[y/n] y"], locale);
    assert.match(copy.first.steps[2].cmd, /^tomverse ".+"$/, locale);
    // The package is not on npm yet: both install surfaces must say so.
    assert.ok(copy.hero.soon.trim() && copy.hero.soonNote.trim() && copy.install.soonNote.trim(), locale);
    assert.match(copy.install.req.node[1], /22/, `${locale}: Node.js 22 (package.json engines >=22)`);
    assert.match(copy.install.req.plan[1], /Pro/, `${locale}: paid plan required`);
    assert.match(copy.hero.platforms, /Node\.js 22/, locale);
    assert.match(copy.update.removeNote, /~\/\.tomverse/, locale);
  }
});

test("CLI page copy uses the real key prefix and links to no download until a release exists", () => {
  for (const locale of SEO_LOCALES) {
    const text = strings(cliPageContent[locale]).join("\n");
    assert.doesNotMatch(text, /\btv_\.\.\./, `${locale}: API keys start with tvk_`);
    assert.doesNotMatch(text, /github\.com\/mposition/i, `${locale}: no download link until a release exists`);
  }
});

test("the six translated locales are translated, not copies of English", () => {
  for (const locale of SEO_LOCALES.filter((item) => item !== "en" && item !== "ko")) {
    const copy = cliPageContent[locale];
    assert.notEqual(copy.hero.lede, cliPageContent.en.hero.lede, locale);
    assert.notEqual(copy.install.capNote, cliPageContent.en.install.capNote, locale);
    assert.notEqual(copy.safe.ticks[3][1], cliPageContent.en.safe.ticks[3][1], locale);
  }
});

test("CLI page metadata is complete for every locale", () => {
  for (const locale of SEO_LOCALES) {
    const seo = cliPageSeo[locale];
    assert.ok(seo.title.length > 0 && seo.title.length <= 60, `${locale}: title length ${seo.title.length}`);
    assert.ok(seo.description.length >= 40 && seo.description.length <= 220, `${locale}: description length ${seo.description.length}`);
  }
});

const css = readFileSync("components/marketing/v2/cli/cli-page.css", "utf8");
const root = postcss.parse(css);

test("every CLI page rule is scoped under .tv-page and its keyframes are prefixed", () => {
  const unscoped = [];
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
    for (const selector of rule.selectors) {
      if (!/^\.tv-page(?=$|[\s.:[>+~,])/.test(selector.trim())) unscoped.push(selector);
    }
  });
  assert.deepEqual(unscoped, []);
  root.walkAtRules("keyframes", (at) => assert.match(at.params, /^tvl-/, at.params));
  // The copy button must not reuse the split layout's .copy column.
  assert.doesNotMatch(css, /\.tv-page \.copy\b/);
});

test("CLI page text stays at or above the 11px floor and uses the locale font variables", () => {
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

test("CLI page code needs no inline script or innerHTML and keeps its test ids and reduced-motion handling", () => {
  const source = readFileSync("components/marketing/v2/cli/CliPage.tsx", "utf8");
  assert.doesNotMatch(source, /<script|innerHTML|dangerouslySetInnerHTML/);
  assert.match(source, /data-testid="cli-page"/);
  assert.match(source, /data-testid="cli-title"/);
  assert.match(source, /prefers-reduced-motion/);
});
