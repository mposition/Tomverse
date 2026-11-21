import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import { SEO_LOCALES } from "../lib/seo.ts";
import { developersPageContent, developersPageSeo, developersPageSource } from "../components/marketing/v2/developers/developersPageContent.ts";

// Developer page V2 (approved concept 2026-11-20). The stylesheet is a global CSS file
// imported by DevelopersPage, so its only isolation is the .tv-page scope.
const cssPath = "components/marketing/v2/developers/developers-page.css";
const css = readFileSync(cssPath, "utf8");
const root = postcss.parse(css);

const shape = (value) => Array.isArray(value) ? value.map(shape)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]))
  : typeof value;
const placeholders = (value, path = "") => Array.isArray(value) || (value && typeof value === "object")
  ? Object.entries(value).flatMap(([key, child]) => placeholders(child, `${path}.${key}`))
  : typeof value === "string" ? [...value.matchAll(/\{[a-z]+\}/g)].map((match) => `${path}${match[0]}`) : [];

test("developer page copy has the same structure and placeholders in every language", () => {
  const ko = developersPageSource.ko;
  for (const locale of SEO_LOCALES) {
    const copy = developersPageContent[locale];
    assert.deepEqual(shape(copy), shape(ko), `${locale}: developer page copy shape differs from Korean`);
    assert.deepEqual(placeholders(copy), placeholders(ko), `${locale}: placeholders differ from Korean`);
    assert.ok(developersPageSeo[locale].title.trim() && developersPageSeo[locale].description.trim(), `${locale}: missing SEO copy`);
  }
});

test("every language names the provider count with a placeholder, never a number", () => {
  for (const locale of SEO_LOCALES) {
    const text = JSON.stringify(developersPageContent[locale]);
    assert.match(text, /\{n\}/, locale);
    assert.doesNotMatch(text, /(?:\b12\b|12곳|12 家)/, `${locale}: hard-coded provider count`);
    assert.doesNotMatch(JSON.stringify(developersPageSeo[locale]), /\b12\b/, `${locale}: hard-coded provider count in SEO`);
  }
});

test("facts the page states match docs/policy/external-api.md in every language", () => {
  for (const locale of SEO_LOCALES) {
    const copy = developersPageContent[locale];
    const text = JSON.stringify(copy);
    // Paid plans only, ten keys per account, the three protocol paths in the proto cards.
    assert.match(copy.hero.note, /Pro/, `${locale}: Pro-only note`);
    assert.match(JSON.stringify(copy.keys.ticks), /10/, `${locale}: ten keys per account`);
    assert.match(JSON.stringify(copy.faq.items[1]), /Pro/, `${locale}: Free FAQ`);
    // The CLI is released: its block carries no "coming soon" and names the installers (.msi, winget, .pkg,
    // .deb) and npm. The commands themselves live on the install page, so none is written here.
    assert.doesNotMatch(JSON.stringify(copy.cli), /곧 출시|coming soon|即将推出|即將推出|Bientôt|Demnächst|Próximamente|Em breve/i, `${locale}: CLI block still says soon`);
    for (const word of [/\.msi/, /winget/, /\.pkg/, /\.deb/, /npm/]) assert.match(copy.cli.body, word, `${locale}: CLI install ways ${word}`);
    assert.doesNotMatch(text, /npm (?:i|install)\b|npx /, `${locale}: CLI install command`);
    // "Estimated credits before sending" is not a feature.
    assert.doesNotMatch(text, /3\.2/, `${locale}: stale CLI cost example`);
    // Claude Code and Codex stay on their own provider; the hero must say so.
    assert.match(copy.hero.body, /Codex/);
    assert.match(copy.hero.body, /Claude Code/);
    assert.match(copy.adaptive.body.join(""), /OpenAI/);
    assert.match(copy.adaptive.body.join(""), /Anthropic/);
  }
  // The owner wrote the first FAQ answer; its meaning stays.
  assert.match(developersPageSource.ko.faq.items[0].a, /^아니요\. Tomverse는 요청에 담긴 코드와 대화, 모델의 답변을 저장하지 않습니다\./);
  assert.match(developersPageSource.ko.faq.items[0].a, /\{safety\}/);
});

test("the page uses no inline script and no raw HTML injection, and keeps its test ids and section ids", () => {
  const source = readFileSync("components/marketing/v2/developers/DevelopersPage.tsx", "utf8");
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML|<script/);
  for (const id of ["developers-page", "developers-title", "developers-primary-cta"]) assert.ok(source.includes(`"${id}"`), id);
  for (const id of ["connect", "keys"]) assert.match(source, new RegExp(`id="${id}"`), id);
  assert.match(source, /useModelCatalog/);
  assert.match(source, /localizedPath\(lang, "\/developers\/cli"\)/);
  assert.doesNotMatch(source, /https:\/\/tomverse\.app\/(?!api)|\.html"/);
});

test("every developer page rule is scoped under .tv-page", () => {
  const unscoped = [];
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
    for (const selector of rule.selectors) {
      if (!/^\.tv-page(?=$|[\s.:[>+~,])/.test(selector.trim())) unscoped.push(selector);
    }
  });
  assert.deepEqual(unscoped, []);
});

test("developer page keyframes are prefixed so they cannot collide with another page's", () => {
  root.walkAtRules("keyframes", (at) => assert.match(at.params, /^tvd-/, at.params));
});

test("developer page text stays at or above the 11px floor and uses the locale font variables", () => {
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

test("developer page stops every animation when motion is paused or reduced", () => {
  assert.match(css, /\.tv-page\[data-motion="paused"\] \*/);
  assert.match(css, /\.tv-page\[data-motion="paused"\] \.hero-media video \{ display: none; \}/);
});

test("coding tool examples point at the coding API and other apps at the general API (docs/policy/external-api.md §1, §10.4)", async () => {
  // The tool console is drawn on the homepage and the developer page from the same shape.
  for (const file of ["components/marketing/v2/developers/DevelopersPage.tsx", "components/marketing/LaunchHomepage.tsx"]) {
    const source = readFileSync(file, "utf8");
    const block = (tool) => {
      const start = source.indexOf(`\n  ${tool}: {`);
      return start < 0 ? "" : source.slice(start, source.indexOf("] },", start));
    };
    assert.match(source, /const CODING_API_BASE = "https:\/\/tomverse\.app\/api\/code\/v1";/, file);
    assert.match(source, /const CODING_ANTHROPIC_BASE = "https:\/\/tomverse\.app\/api\/code\/anthropic";/, file);
    for (const tool of ["codex", "cursor"]) assert.match(block(tool), /CODING_API_BASE\b/, `${file}: ${tool}`);
    assert.match(block("claude"), /ANTHROPIC_BASE_URL=", \["s", `"\$\{CODING_ANTHROPIC_BASE\}"`\]/, `${file}: claude`);
    for (const tool of ["vscode", "aside", "other"]) {
      assert.match(block(tool), /\bAPI_BASE\b/, `${file}: ${tool}`);
      assert.doesNotMatch(block(tool), /CODING_/, `${file}: ${tool} stays on the general API`);
    }
  }
  const developers = readFileSync("components/marketing/v2/developers/DevelopersPage.tsx", "utf8");
  assert.match(developers, /"POST \/api\/code\/v1\/responses"/);
  assert.match(developers, /"POST \/api\/code\/anthropic\/v1\/messages"/);
  assert.match(readFileSync("components/marketing/v2/cli/CliPage.tsx", "utf8"), /\["endpoint", "https:\/\/tomverse\.app\/api\/code\/v1"\]/);
  const { homeV2Content } = await import("../components/marketing/home/homeV2Content.ts");
  for (const locale of SEO_LOCALES) {
    const values = homeV2Content[locale].api.facts.map(([, value]) => value);
    assert.deepEqual(values.slice(0, 2), ["https://tomverse.app/api/code/v1", "https://tomverse.app/api/v1"], locale);
  }
});
