import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import { SEO_LOCALES } from "../lib/seo.ts";
import { chatPageContent, chatPageSeo } from "../components/marketing/v2/chat/chatPageContent.ts";

// The V2 chat introduction page (/products/chat). Korean is the approved wording;
// every other locale keeps its shape, its placeholders and the notes that say the
// demo screens are illustrations.
const shape = (value) => Array.isArray(value) ? value.map(shape)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]))
  : typeof value;
const tokens = (value, path = "") => Array.isArray(value) || (value && typeof value === "object")
  ? Object.entries(value).flatMap(([key, child]) => tokens(child, `${path}.${key}`))
  : typeof value === "string" ? [...value.matchAll(/\{\w+\}/g)].map((match) => `${path}:${match[0]}`) : [];

test("chat page copy is complete in every language and keeps its placeholders", () => {
  const ko = chatPageContent.ko;
  assert.deepEqual(Object.keys(chatPageContent).sort(), [...SEO_LOCALES].sort());
  for (const locale of SEO_LOCALES) {
    const copy = chatPageContent[locale];
    assert.deepEqual(shape(copy), shape(ko), `${locale}: chat page copy shape differs from Korean`);
    assert.deepEqual(tokens(copy), tokens(ko), `${locale}: placeholders differ from Korean`);
    for (const note of [copy.adaptive.note, copy.continue.note, copy.create.note, copy.plugins.note]) {
      assert.ok(note.trim(), `${locale}: missing illustration or trademark note`);
    }
    assert.ok(chatPageSeo[locale].title.trim() && chatPageSeo[locale].description.trim(), `${locale}: missing SEO text`);
  }
});

test("chat page copy states no provider count or unsupported claim", () => {
  // The provider count is the {n} placeholder, never a literal.
  assert.doesNotMatch(JSON.stringify(chatPageContent.ko), /공급자 \d+곳/);
  assert.match(chatPageContent.ko.hero.body, /\{n\}/);
  // No estimate-before-send claim, and the Prompt Refiner is automatic.
  assert.doesNotMatch(JSON.stringify(chatPageContent.ko), /예상 크레딧|확인 후 채택|실행 전에 보여/);
  assert.doesNotMatch(JSON.stringify(chatPageContent.en), /estimated credits|after you confirm|shown before/i);
  // Perplexity import and the mobile apps are announced as coming, not available.
  assert.ok(chatPageContent.ko.continue.soon);
  assert.match(chatPageContent.ko.mobile.eyebrow, /곧 출시/);});

test("Korean chat page names the products like the header menu", () => {
  const ko = chatPageContent.ko;
  for (const label of [ko.hero.primary, ko.cta.chat, ko.cta.review]) {
    assert.doesNotMatch(label, /\b(?:Chat|Review)\b/, label);
  }
  assert.match(ko.hero.primary, /^채팅/);
  assert.match(ko.cta.review, /^답변 비교/);
});

// The stylesheet is a global CSS file imported by ChatProductPage, so its only
// isolation is the .tv-page scope (same checks as tests/homeV2Stylesheet.test.mjs).
const css = readFileSync("components/marketing/v2/chat/chat-page.css", "utf8");
const root = postcss.parse(css);

test("every chat page rule is scoped under .tv-page", () => {
  const unscoped = [];
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
    for (const selector of rule.selectors) {
      if (!/^\.tv-page(?=$|[\s.:[>+~,])/.test(selector.trim())) unscoped.push(selector);
    }
  });
  assert.deepEqual(unscoped, []);
});

test("chat page keyframes are prefixed so they cannot collide with another page's", () => {
  root.walkAtRules("keyframes", (at) => assert.match(at.params, /^tvc-/, at.params));
});

test("chat page text stays at or above the 11px floor and uses the locale font variables", () => {
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

test("chat page can be paused from the page root", () => {
  assert.match(css, /\.tv-page\[data-motion="paused"\]/);
});
