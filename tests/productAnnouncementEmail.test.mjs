import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT,
  buildProductAnnouncementEmail,
  parseProductAnnouncementPayload,
} from "../lib/productAnnouncementEmail.ts";
import {
  PRODUCT_ANNOUNCEMENT_TEMPLATE,
  emailTemplateDefinition,
  templateDefinitionProblems,
} from "../lib/emailTemplateDefinitions.ts";

test("product announcements are consent-gated marketing mail", () => {
  const definition = emailTemplateDefinition(PRODUCT_ANNOUNCEMENT_TEMPLATE);
  assert.equal(definition.classification, "marketing");
  assert.equal(definition.purpose, "product_updates");
  assert.equal(definition.requiresUnsubscribe, true);
  assert.deepEqual(templateDefinitionProblems(definition), []);
});

test("assistant and Knowledge starter copy renders in Korean and English", () => {
  for (const language of ["ko", "en"]) {
    const payload = ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT[language];
    const rendered = buildProductAnnouncementEmail(payload, language);
    assert.equal(rendered.subject, payload.subject);
    assert.match(rendered.html, /Tomverse/);
    assert.match(rendered.html, /role="presentation"/);
    assert.match(rendered.html, /<img /);
    assert.match(rendered.html, /guides\/assistant-knowledge\/poster/);
    assert.ok(rendered.text.includes(payload.ctaUrl));
    assert.ok(rendered.text.includes(payload.media.alt));
    assert.equal(rendered.html.match(/<a /g)?.length, 1);
  }
});

test("authored content and URLs are escaped", () => {
  const payload = {
    ...ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT.en,
    headline: '<script>alert("x")</script>',
    ctaUrl: "https://tomverse.app/settings/assistants?q=one&next=two",
  };
  const rendered = buildProductAnnouncementEmail(payload, "en");
  assert.doesNotMatch(rendered.html, /<script>/i);
  assert.match(rendered.html, /&lt;script&gt;/);
  assert.match(rendered.html, /q=one&amp;next=two/);
});

test("unsafe or incomplete content is refused before a draft exists", () => {
  assert.throws(
    () =>
      parseProductAnnouncementPayload({
        ...ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT.en,
        ctaUrl: "javascript:alert(1)",
      }),
    /HTTPS Tomverse domain/
  );
  assert.throws(
    () =>
      parseProductAnnouncementPayload({
        ...ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT.en,
        features: [],
      }),
    /between one and four/
  );
});

test("product announcement links cannot leave Tomverse", () => {
  for (const ctaUrl of [
    "https://example.test/settings/assistants",
    "https://evil.example@tomverse.app/settings/assistants",
    "https://tomverse.app:444/settings/assistants",
  ]) {
    assert.throws(
      () =>
        buildProductAnnouncementEmail(
          { ...ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT.en, ctaUrl },
          "en"
        ),
      /HTTPS Tomverse domain/
    );
  }
});

test("tutorial poster URLs cannot leave Tomverse", () => {
  assert.throws(
    () =>
      buildProductAnnouncementEmail(
        {
          ...ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT.en,
          media: {
            ...ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT.en.media,
            posterUrl: "https://images.example.test/tutorial.png",
          },
        },
        "en"
      ),
    /media\.posterUrl must use an HTTPS Tomverse domain/
  );
});

test("starter copy teaches three concrete steps before its single CTA", () => {
  for (const language of ["ko", "en"]) {
    const payload = ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT[language];
    assert.equal(payload.features.length, 3);
    assert.deepEqual(
      payload.features.map((feature) => feature.title.slice(0, 2)),
      ["1.", "2.", "3."]
    );
    assert.match(payload.ctaUrl, /\/guides\/assistant-knowledge/);
  }
});

test("the same content renders the same bytes twice", () => {
  assert.deepEqual(
    buildProductAnnouncementEmail(ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT.ko, "ko"),
    buildProductAnnouncementEmail(ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT.ko, "ko")
  );
});
