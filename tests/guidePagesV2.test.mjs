import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import postcss from "postcss";
import { SEO_LOCALES } from "../lib/seo.ts";
import { searchIntentPages, SEARCH_INTENT_SLUGS } from "../components/marketing/searchIntentContent.ts";
import { guidesUiCopy } from "../components/marketing/v2/guides/guidesUiCopy.ts";
import { guideHref } from "../components/marketing/v2/guides/guideHref.ts";

// The four V2 usage guides (/compare-ai-models, /ai-answer-review, /chatgpt-vs-claude,
// /ai-for-file-analysis). The wording stays the live wording; the design is one template.
const read = (path) => readFileSync(path, "utf8");

// The example answers live in .tsx modules that import React components, which the node test
// loader cannot evaluate under the react-server condition; a plain child process can.
const loadExampleCopy = () => JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "-e", `
  const [guide, demo] = await Promise.all([
    import("./components/marketing/ChatGptVsClaudeGuide.tsx"),
    import("./components/marketing/AiReviewDemo.tsx"),
  ]);
  const pick = (mod, key) => mod[key] ?? mod.default?.[key];
  process.stdout.write("\\n@@" + JSON.stringify({ guide: pick(guide, "guideCopy"), demo: pick(demo, "aiReviewDemoCopy") }));
`], { encoding: "utf8", cwd: new URL("..", import.meta.url), env: { ...process.env, NODE_OPTIONS: "" }, timeout: 60_000 }).split("\n@@").pop());

const shape = (value) => Array.isArray(value) ? value.map(shape)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]))
  : typeof value;

// ---- Stylesheet: a global CSS file, so its only isolation is the .tv-page scope ----
const css = read("components/marketing/v2/guides/guides-page.css");
const root = postcss.parse(css);

test("every guide rule is scoped under .tv-page", () => {
  const unscoped = [];
  root.walkRules((rule) => {
    if (rule.parent?.type === "atrule" && /keyframes/.test(rule.parent.name)) return;
    for (const selector of rule.selectors) {
      if (!/^\.tv-page(?=$|[\s.:[>+~,])/.test(selector.trim())) unscoped.push(selector);
    }
  });
  assert.deepEqual(unscoped, []);
});

test("guide keyframes, if any, are prefixed so they cannot collide with another page's", () => {
  root.walkAtRules("keyframes", (at) => assert.match(at.params, /^tvg-/, at.params));
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

test("the guides can be paused from the page root", () => {
  assert.match(css, /\.tv-page\[data-motion="paused"\]/);
  const page = read("components/marketing/v2/guides/GuidePage.tsx");
  assert.match(page, /data-motion=\{reduce \? "paused" : "running"\}/);
  assert.match(page, /prefers-reduced-motion|usePrefersReducedMotion/);
  assert.match(page, /guide-motion-toggle/);
  // The 6 second before/after rotation and the video both read the same switch.
  const visuals = read("components/marketing/v2/guides/GuideVisuals.tsx");
  assert.match(visuals, /const running = auto && !reduce/);
  assert.match(visuals, /6000/);
  assert.match(visuals, /video\.pause\(\)/);
});

// ---- CSP: no inline script, no HTML injection ----
test("guide components use no inline script and no raw HTML", () => {
  for (const file of ["GuidePage.tsx", "GuideVisuals.tsx"]) {
    const source = read(`components/marketing/v2/guides/${file}`);
    assert.doesNotMatch(source, /dangerouslySetInnerHTML|innerHTML|<script|document\.write/, file);
  }
});

// ---- Routing: every guide route draws the template and keeps its metadata ----
test("all guide routes render the shared template and keep their metadata", () => {
  for (const slug of SEARCH_INTENT_SLUGS) {
    const route = read(`app/(site)/(marketing)/${slug}/page.tsx`);
    assert.match(route, new RegExp(`<GuidePage slug="${slug}" />`), slug);
    assert.match(route, /createPageMetadata\(/, slug);
    assert.doesNotMatch(route, /MarketingInfoPage/, slug);
  }
  const localized = read("app/[locale]/[intent]/page.tsx");
  assert.match(localized, /<GuidePage slug=\{intent\} \/>/);
  assert.match(localized, /generateMetadata/);
  assert.doesNotMatch(localized, /MarketingInfoPage/);
});

test("the guide template builds every internal link with the locale helpers", () => {
  const page = read("components/marketing/v2/guides/GuidePage.tsx");
  assert.match(page, /localizedPath\(lang, GUIDE_PATH\[/);
  assert.match(page, /guideHref\(/);
  assert.doesNotMatch(page, /href="\/(?:compare|ai-|chatgpt)/);
  // The prepared comparison keeps the model pair of the shared reference list.
  assert.match(page, /CHATGPT_VS_CLAUDE_MODEL_IDS/);
  assert.match(page, /source: "chatgpt-vs-claude"/);
});

test("guideHref keeps the visitor's language on Review links and localizes marketing links", () => {
  assert.equal(guideHref("/review?lang=en", "ko"), "/review?lang=ko");
  assert.equal(guideHref("/chat", "fr"), "/review?lang=fr");
  assert.equal(guideHref("/ai-answer-review", "de"), "/de/ai-answer-review");
  assert.equal(guideHref("/models", "ko"), "/ko/models");
  assert.equal(guideHref("https://arxiv.org/abs/2406.07791", "ko"), "https://arxiv.org/abs/2406.07791");
});

// ---- The outdated wording the owner asked to drop (all eight languages) ----
test("no guide says it shows estimated credits before running", () => {
  const stale = /예상 크레딧|estimated credits|预计积分|預估點數|coût estimé en crédits|Geschätzte Credits|créditos estimados/i;
  for (const slug of SEARCH_INTENT_SLUGS) {
    for (const locale of SEO_LOCALES) {
      assert.doesNotMatch(JSON.stringify(searchIntentPages[slug][locale]), stale, `${slug}/${locale}`);
    }
  }
  // The guide screens must not bring the claim back through another source.
  const exampleCopy = loadExampleCopy();
  assert.doesNotMatch(JSON.stringify(exampleCopy.demo), stale);
  assert.doesNotMatch(JSON.stringify(exampleCopy.guide), stale);
});

test("the review example is labelled plainly instead of 'fictional products, edited answers'", () => {
  const { demo } = loadExampleCopy();
  const stale = /가상 제품 · 편집용 답변 예시|Fictional products|edited example answers|虚构产品|虛構產品|Produits fictifs|Fiktive Produkte|Productos ficticios|Produtos fictícios/;
  for (const locale of SEO_LOCALES) {
    const label = demo[locale].example;
    assert.ok(label.trim() && label.length <= 12, `${locale}: label is short`);
    assert.doesNotMatch(label, stale, locale);
  }
  assert.equal(demo.ko.example, "예시");
});

test("the file analysis lead is not repeated as the first section's body", () => {
  for (const locale of SEO_LOCALES) {
    const page = searchIntentPages["ai-for-file-analysis"][locale];
    for (const section of page.sections) {
      assert.notEqual(section.body, page.description, `${locale}: ${section.title}`);
      assert.ok(!page.description.includes(section.body), `${locale}: ${section.title} repeats the lead`);
    }
    assert.ok(page.sections[0].body.trim(), `${locale}: first section keeps a body`);
  }
});

// ---- Copy kept in the new file ----
test("guide interface copy is complete in every language", () => {
  const ko = guidesUiCopy.ko;
  assert.deepEqual(Object.keys(guidesUiCopy).sort(), [...SEO_LOCALES].sort());
  for (const locale of SEO_LOCALES) {
    assert.deepEqual(shape(guidesUiCopy[locale]), shape(ko), `${locale}: shape differs from Korean`);
    for (const label of [...Object.values(guidesUiCopy[locale].tabs), ...Object.values(guidesUiCopy[locale].blurbs)]) {
      assert.ok(label.trim(), `${locale}: empty label`);
    }
  }
  assert.equal(guidesUiCopy.en.allFormats, "See all formats");
});

test("guide tab names match the footer's guide list", () => {
  const chrome = read("components/marketing/MarketingChrome.tsx");
  for (const locale of SEO_LOCALES) {
    for (const label of Object.values(guidesUiCopy[locale].tabs)) {
      assert.ok(chrome.includes(`label: "${label}"`), `${locale}: "${label}" is not a footer guide name`);
    }
  }
});

test("highlighted facts are phrases of the existing example answers", () => {
  const { guide } = loadExampleCopy();
  for (const locale of SEO_LOCALES) {
    const facts = guidesUiCopy[locale].facts;
    const copy = guide[locale];
    const results = { gpt: copy.gptResult, claude: copy.claudeResult };
    for (const [who, text] of Object.entries(results)) {
      for (const phrase of facts[who]) assert.ok(text.includes(phrase), `${locale}/${who}: "${phrase}" is not in the answer`);
    }
    assert.equal(facts.legend.length, 4);
  }
});

test("the file illustration repeats the notice of each guide's sample prompt", () => {
  const { guide } = loadExampleCopy();
  for (const locale of SEO_LOCALES) {
    const notice = guide[locale].samplePrompt.split("\n\n").at(-1).toLowerCase();
    for (const [before, mark, after] of guidesUiCopy[locale].fileDemo.notice) {
      const sentence = `${before}${mark}${after}`.toLowerCase();
      assert.ok(notice.includes(sentence), `${locale}: "${sentence}" is not in the sample notice`);
      assert.ok(mark.trim(), `${locale}: empty highlight`);
    }
  }
});

test("the model comparison names the pair from the shared reference list", () => {
  const page = read("components/marketing/v2/guides/GuidePage.tsx");
  assert.match(page, /CHATGPT_VS_CLAUDE_MODEL_IDS\.map\(\(id\) => getModel\(id\)\)/);
  // No model name is typed into the template; badges follow the reference list.
  assert.doesNotMatch(page, /GPT[ -]?\d|Claude (?:Haiku|Sonnet|Opus|Fable)/);
  assert.doesNotMatch(read("components/marketing/v2/guides/GuideVisuals.tsx"), /GPT[ -]?\d|Claude (?:Haiku|Sonnet|Opus|Fable)/);
});
