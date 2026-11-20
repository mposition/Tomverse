import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import { SEO_LOCALES } from "../lib/seo.ts";
import { infoPages } from "../components/marketing/marketingInfoContent.ts";
import { policyPageContent } from "../components/marketing/v2/policy/policyPageContent.ts";
import { AMENDED_DOCUMENT_EVIDENCE } from "../lib/emailPolicyPublication.ts";
import { AMENDED_DOCUMENT_VERIFIERS } from "./support/amendedDocumentVerifiers.mjs";

// The V2 policy pages (/safety, /privacy, /terms, /refund) change the layout
// only. What the documents say still comes from marketingInfoContent.ts and the
// privacyPolicy locale bundles, printed as written.

const source = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

test("each policy route renders the evidence-bearing content it is mapped to", () => {
  assert.match(source("app/(site)/(marketing)/terms/page.tsx"), /<LegalInfoDocument document="terms" content=\{withLegalSectionNav\(infoPages\.terms\)\}/);
  assert.match(source("app/(site)/(marketing)/refund/page.tsx"), /<LegalInfoDocument document="refund" content=\{withLegalSectionNav\(infoPages\.refund\)\}/);
  for (const path of ["app/(site)/(marketing)/safety/page.tsx", "app/[locale]/safety/page.tsx"]) {
    assert.match(source(path), /<SafetyPage(V2)? content=\{infoPages\.safety\}/, path);
  }
  assert.match(source("app/(site)/(marketing)/privacy/page.tsx"), /<PrivacyPolicy \/>/);
});

test("the terms digest is unchanged by the redesign", () => {
  // The digest hashes the copy object, so a layout change must leave it alone.
  assert.equal(AMENDED_DOCUMENT_VERIFIERS["/terms"].digest(), AMENDED_DOCUMENT_EVIDENCE["/terms"].contentSha256);
});

test("the document renderer draws every field the policy sections carry", () => {
  // LegalInfoDocument and SafetyPage print title, body (with its bodyLinks),
  // bullets and links. A section with any other field would lose that part
  // silently, so a new field has to come with renderer support first.
  const drawn = new Set(["id", "lang", "title", "body", "bodyLinks", "bullets", "link", "links"]);
  for (const key of ["terms", "refund", "safety"]) {
    for (const [lang, copy] of Object.entries(infoPages[key])) {
      for (const section of copy.sections) {
        for (const field of Object.keys(section)) assert.ok(drawn.has(field), `${key}.${lang} "${section.title}" has undrawn field ${field}`);
        for (const link of section.bodyLinks ?? []) {
          assert.ok(section.body.includes(link.text), `${key}.${lang}: linked words "${link.text}" are not in the body`);
        }
      }
    }
  }
});

test("the privacy page hands every provider row to the table", () => {
  const policy = source("components/legal/PrivacyPolicy.tsx");
  // Search hides rows in place; it never narrows what is passed in.
  assert.match(policy, /<SearchableProviderTable key=\{lang\} rows=\{destinations\} /);
  assert.match(policy, /<ProviderDestinationTable rows=\{rows\} t=\{t\} \/>/);
  assert.match(policy, /row\.hidden = !match/);
  assert.match(policy, /id=\{sectionId\(bodyKey\)\}/);
  assert.match(policy, /bodyKey === "rights" \? "account-deletion"/);
});

const shape = (value) => Array.isArray(value) ? value.map(shape)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]))
  : typeof value;
const tokens = (value, path = "") => Array.isArray(value) || (value && typeof value === "object")
  ? Object.entries(value).flatMap(([key, child]) => tokens(child, `${path}.${key}`))
  : typeof value === "string" ? [...value.matchAll(/\{\w+\}/g)].map((match) => `${path}:${match[0]}`) : [];

test("policy page interface copy is complete in every language", () => {
  const ko = policyPageContent.ko;
  assert.deepEqual(Object.keys(policyPageContent).sort(), [...SEO_LOCALES].sort());
  for (const locale of SEO_LOCALES) {
    const copy = policyPageContent[locale];
    assert.deepEqual(shape(copy), shape(ko), `${locale}: copy shape differs from Korean`);
    assert.deepEqual(tokens(copy), tokens(ko), `${locale}: placeholders differ from Korean`);
    assert.ok(copy.safety.sampleNote.trim(), `${locale}: the examples must say they are illustrations`);
    // The lock example must not read as encryption, and the share example states expiry and deletion.
    assert.ok(copy.safety.lock.caveat.trim() && copy.safety.share.note.trim(), `${locale}: missing lock or share caveat`);
  }
  assert.match(ko.safety.flowNote, /\{privacy\}/);
});

// The stylesheet is a global CSS file, so its only isolation is the .tv-page scope
// (the same checks as tests/chatProductPageV2.test.mjs).
const css = source("components/marketing/v2/policy/policy-page.css");
const root = postcss.parse(css);

test("every policy page rule is scoped under .tv-page", () => {
  const unscoped = [];
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
    for (const selector of rule.selectors) {
      if (!/^\.tv-page(?=$|[\s.:[>+~,])/.test(selector.trim())) unscoped.push(selector);
    }
  });
  assert.deepEqual(unscoped, []);
});

test("policy page keyframes are prefixed so they cannot collide with another page's", () => {
  root.walkAtRules("keyframes", (at) => assert.match(at.params, /^tvlg-/, at.params));
});

test("policy page text stays at or above the 11px floor and uses the locale font variables", () => {
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

test("policy pages can be paused, and the clauses never fade with the scroll", () => {
  assert.match(css, /\.tv-page\.tv-policy\[data-motion="paused"\]/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.tv-page\.tv-policy \.legal-sec \{ animation: none; \}/);
});
