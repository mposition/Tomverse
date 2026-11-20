import assert from "node:assert/strict";
import test from "node:test";
import { SEO_LOCALES } from "../lib/seo.ts";
import { infoPages, focusedSafetyPages } from "../components/marketing/marketingInfoContent.ts";
import { searchIntentPages } from "../components/marketing/searchIntentContent.ts";
import { homeV2Content, homeV2SourceCopy } from "../components/marketing/home/homeV2Content.ts";
import { chatWorkspaceGuideContent } from "../components/marketing/chatWorkspaceGuideContent.ts";
import { assistantKnowledgeGuideContent } from "../components/marketing/assistantKnowledgeGuideContent.ts";
import { landingCopy } from "../components/marketing/landingContent.ts";

test("two-reviewer explanation reports quote evidence without promising provider independence or a correct-answer consensus", () => {
  const copy = landingCopy.en.loop;
  assert.doesNotMatch(copy.dualReviewerLabel, /different providers/);
  assert.match(copy.dualReviewer, /quote-match grades/);
  assert.match(copy.dualReviewer, /exact quotes/);
  assert.match(copy.dualReviewer, /does not mean they agree about which answer is correct/);
});

test("public information and guides have complete localized bodies rather than English fallback", () => {
  const tables = {
    ...Object.fromEntries(["about", "faq", "safety"].map(key => [key, infoPages[key]])),
    ...focusedSafetyPages,
    ...searchIntentPages,
    workspace: chatWorkspaceGuideContent,
    knowledge: assistantKnowledgeGuideContent,
  };
  for (const [page, table] of Object.entries(tables)) {
    for (const locale of SEO_LOCALES) {
      const copy = table[locale];
      assert.ok(copy, `${page}: missing ${locale}`);
      assert.ok(copy.title.trim() && copy.description.trim(), `${page}/${locale}: empty introduction`);
      if (locale !== "en") {
        assert.notEqual(copy.description, table.en.description, `${page}/${locale}: English body fallback`);
      }
      if (copy.sections) {
        assert.equal(copy.sections.length, table.en.sections.length, `${page}/${locale}: missing section`);
        copy.sections.forEach(section => assert.ok(section.title.trim() && (section.body ?? section.description).trim()));
      }
    }
  }
});

// Homepage V2: every locale has the same shape as the approved Korean copy, keeps
// the live provider count placeholder where Korean has it, and keeps the notes
// that say the demo screens are illustrations.
test("homepage copy is complete in every language, keeps {n} and its illustration notes", () => {
  const shape = (value) => Array.isArray(value) ? value.map(shape)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]))
    : typeof value;
  const placeholders = (value, path = "") => Array.isArray(value) || (value && typeof value === "object")
    ? Object.entries(value).flatMap(([key, child]) => placeholders(child, `${path}.${key}`))
    : typeof value === "string" && value.includes("{n}") ? [path] : [];
  const ko = homeV2SourceCopy.ko;
  for (const locale of SEO_LOCALES) {
    const copy = homeV2Content[locale];
    assert.deepEqual(shape(copy), shape(ko), `${locale}: homepage copy shape differs from Korean`);
    assert.deepEqual(placeholders(copy), placeholders(ko), `${locale}: {n} placeholders differ from Korean`);
    for (const note of [copy.adaptive.note, copy.continue.note, copy.review.caption, copy.plugins.note]) {
      assert.ok(note.trim(), `${locale}: missing illustration or trademark note`);
    }
  }
});

test("localized FAQ preserves the same product, cost and support topics", () => {
  const en = infoPages.faq.en;
  for (const locale of SEO_LOCALES) {
    const faq = infoPages.faq[locale];
    assert.equal(faq.sections.length, en.sections.length);
    assert.ok(faq.sections.length >= 8);
    assert.match(faq.sections[0].body, /Chat/);
    assert.match(faq.sections[0].body, /Review/);
  }
});

test("Korean FAQ names products like the header menu and gives English names only in parentheses", () => {
  const ko = infoPages.faq.ko;
  const strings = [ko.description, ...ko.sections.flatMap(section => [
    section.title, section.body, ...Object.values(section.guestTrialLinks ?? {}),
  ])];
  for (const text of strings) {
    const bare = text.replace(/\((?:AI )?(?:Chat|Review)\)/g, "");
    assert.doesNotMatch(bare, /\b(?:Chat|Review)\b/, text);
  }
  assert.match(ko.sections[0].title, /채팅과 리뷰/);
});

test("Korean homepage action buttons name products like the header menu", () => {
  const { hero, final } = homeV2Content.ko;
  for (const label of [hero.primary, hero.secondary, final.chat, final.review]) {
    assert.doesNotMatch(label, /\b(?:Chat|Review)\b/, label);
  }
  assert.match(hero.secondary, /^채팅/);
  assert.match(final.chat, /^채팅/);
  assert.match(final.review, /^답변 비교/);
});
