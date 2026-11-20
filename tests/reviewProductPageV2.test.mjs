import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import { SEO_LOCALES } from "../lib/seo.ts";
import { reviewPageContent } from "../components/marketing/v2/review/reviewPageContent.ts";

// The V2 answer comparison page (/products/review). Korean is the approved wording;
// every other locale keeps its shape, its placeholders and the notes that say the
// demo screens are examples. The page's metadata stays in lib/seo.ts.
const shape = (value) => Array.isArray(value) ? value.map(shape)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]))
  : typeof value;
const tokens = (value, path = "") => Array.isArray(value) || (value && typeof value === "object")
  ? Object.entries(value).flatMap(([key, child]) => tokens(child, `${path}.${key}`))
  : typeof value === "string" ? [...value.matchAll(/\{\w+\}/g)].map((match) => `${path}:${match[0]}`) : [];
const strings = (value) => Array.isArray(value) || (value && typeof value === "object")
  ? Object.values(value).flatMap(strings) : typeof value === "string" ? [value] : [];

test("review page copy is complete in every language and keeps its placeholders", () => {
  const ko = reviewPageContent.ko;
  assert.deepEqual(Object.keys(reviewPageContent).sort(), [...SEO_LOCALES].sort());
  for (const locale of SEO_LOCALES) {
    const copy = reviewPageContent[locale];
    assert.deepEqual(shape(copy), shape(ko), `${locale}: review page copy shape differs from Korean`);
    assert.deepEqual(tokens(copy), tokens(ko), `${locale}: placeholders differ from Korean`);
    for (const note of [copy.demo.caption, copy.modes.note, copy.lens.note, copy.after.note]) {
      assert.ok(note.trim(), `${locale}: missing example or demonstration note`);
    }
    assert.equal(copy.modes.findings.length, 3, `${locale}: example review findings`);
    assert.equal(copy.lens.lenses.length, 3, `${locale}: review lenses`);
    assert.equal(copy.trust.cards.length, 4, `${locale}: trust cards`);
    for (const text of strings(copy)) assert.ok(text.trim(), `${locale}: empty string`);
  }
});

test("review page copy states no provider count or unsupported claim", () => {
  const ko = JSON.stringify(reviewPageContent.ko);
  const en = JSON.stringify(reviewPageContent.en);
  // The provider count is the {n} placeholder and the credit figures are placeholders, never literals.
  assert.doesNotMatch(ko, /공급자 \d+곳/);
  assert.match(reviewPageContent.ko.hero.body, /\{n\}/);
  assert.match(reviewPageContent.ko.providers.eyebrow, /\{n\}/);
  assert.match(reviewPageContent.ko.faq.items[1][1], /\{summary\}.*\{review\}.*\{calc\}/);
  // No estimate-before-send claim, no verdict or guarantee, and no em or en dash.
  assert.doesNotMatch(ko, /예상 크레딧|보내기 전|보장|사실 판정|정답을 알려/);
  assert.doesNotMatch(en, /estimated credits|before you send|guarantee|fact-check/i);
  for (const locale of SEO_LOCALES) {
    for (const text of strings(reviewPageContent[locale])) assert.doesNotMatch(text, /[–—]/, `${locale}: ${text}`);
  }
});

test("two-reviewer explanation reports quote evidence without promising provider independence or a correct-answer consensus", () => {
  // This claim lived in the landing copy this page replaced (tests/publicMarketingCopy.test.mjs).
  const card = reviewPageContent.en.trust.cards[1];
  assert.doesNotMatch(`${card.h} ${card.p}`, /different providers/);
  assert.match(card.p, /quote-match grades/);
  assert.match(card.p, /exact quotes/);
  assert.match(card.p, /does not mean they agree about which answer is correct/);
  // Quote matching is not factual accuracy.
  assert.match(reviewPageContent.en.trust.cards[0].f, /not the probability that a claim is true/);
  assert.match(reviewPageContent.ko.trust.cards[0].f, /확률이 아니라/);
});

test("Korean review page names the product like the header menu", () => {
  const ko = reviewPageContent.ko;
  assert.equal(ko.crumb, "답변 비교");
  for (const label of [ko.hero.primary, ko.hero.primarySignedIn, ko.cta.primary, ko.cta.pricing]) {
    assert.doesNotMatch(label, /\b(?:Chat|Review)\b/, label);
  }
  assert.match(ko.hero.primarySignedIn, /^답변 비교/);
});

test("the page keeps its entry rules and has no inline script", () => {
  const source = readFileSync("components/marketing/v2/review/ReviewProductPage.tsx", "utf8");
  // docs/ui-contracts/chat-product-switcher.md section 3: a guest enters Review's preview.
  assert.match(source, /workspaceDestination\(\{ chatSurfaceAvailable: false, lang, isAuthenticated \}\)/);
  assert.match(source, /id="landing-hero-primary" testId="landing-primary-cta"/);
  assert.match(source, /data-testid="launch-motion-toggle"/);
  // CSP: the concept's inline script and innerHTML are rewritten in React.
  assert.doesNotMatch(source, /innerHTML|<script|eval\(/);
  // Links go through localizedPath, never a hard-coded locale.
  assert.doesNotMatch(source, /href="\/(?:ko|en|zh|fr|de|es|pt)\b/);
});

// The stylesheet is a global CSS file imported by ReviewProductPage, so its only
// isolation is the .tv-page scope (same checks as tests/homeV2Stylesheet.test.mjs).
const css = readFileSync("components/marketing/v2/review/review-page.css", "utf8");
const root = postcss.parse(css);

test("every review page rule is scoped under .tv-page", () => {
  const unscoped = [];
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
    for (const selector of rule.selectors) {
      if (!/^\.tv-page(?=$|[\s.:[>+~,])/.test(selector.trim())) unscoped.push(selector);
    }
  });
  assert.deepEqual(unscoped, []);
});

test("review page keyframes are prefixed so they cannot collide with another page's", () => {
  root.walkAtRules("keyframes", (at) => assert.match(at.params, /^tvr-/, at.params));
});

test("review page text stays at or above the 11px floor and uses the locale font variables", () => {
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

test("review page can be paused from the page root", () => {
  assert.match(css, /\.tv-page\[data-motion="paused"\]/);
});
