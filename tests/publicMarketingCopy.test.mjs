import assert from "node:assert/strict";
import test from "node:test";
import { SEO_LOCALES } from "../lib/seo.ts";
import { infoPages, focusedSafetyPages } from "../components/marketing/marketingInfoContent.ts";
import { searchIntentPages } from "../components/marketing/searchIntentContent.ts";
import { launchHomepageContent } from "../components/marketing/launchHomepageContent.ts";
import { chatWorkspaceGuideContent } from "../components/marketing/chatWorkspaceGuideContent.ts";
import { assistantKnowledgeGuideContent } from "../components/marketing/assistantKnowledgeGuideContent.ts";

test("public information and guides have complete localized bodies rather than English fallback", () => {
  const tables = {
    ...Object.fromEntries(["about", "faq", "safety", "helpCentre"].map(key => [key, infoPages[key]])),
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

test("Review illustration quotes are exact excerpts of the displayed answers in every language", () => {
  for (const locale of SEO_LOCALES) {
    const review = launchHomepageContent[locale].review;
    assert.equal(review.answers.length, 3);
    for (const answer of review.answers) {
      assert.ok(answer.quote.trim());
      assert.ok(answer.body.includes(answer.quote), `${locale}: unsupported quote`);
    }
    assert.ok(review.note.trim(), `${locale}: missing illustration disclosure`);
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
