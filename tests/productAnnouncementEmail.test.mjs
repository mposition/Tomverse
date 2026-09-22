import assert from "node:assert/strict";
import test from "node:test";

import {
  ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT,
  assistantKnowledgeCampaignContent,
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

test("assistant and Knowledge starter copy renders in Korean, English, and Chinese", () => {
  for (const language of ["ko", "en", "zh"]) {
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
  for (const language of ["ko", "en", "zh"]) {
    const payload = ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT[language];
    assert.equal(payload.features.length, 3);
    assert.deepEqual(
      payload.features.map((feature) => feature.title.slice(0, 2)),
      ["1.", "2.", "3."]
    );
    assert.match(payload.ctaUrl, /\/guides\/assistant-knowledge/);
  }
});

test("package import is only added to composer copy when its rollout flag is on", () => {
  const unavailable = assistantKnowledgeCampaignContent({
    includePackageImport: false,
  });
  const available = assistantKnowledgeCampaignContent({
    includePackageImport: true,
  });

  for (const language of ["ko", "en", "zh"]) {
    assert.equal(unavailable[language].features.length, 3);
    assert.equal(available[language].features.length, 4);
    assert.match(available[language].features[3].title, /^4\./);
  }
});

test("the same content renders the same bytes twice", () => {
  assert.deepEqual(
    buildProductAnnouncementEmail(ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT.ko, "ko"),
    buildProductAnnouncementEmail(ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT.ko, "ko")
  );
});

// Draft section 8: a feature's destination is a product path id, chosen from a
// fixed table, and the pricing, billing and upgrade paths are not in it.

/** The starter copy, which is a valid payload, with its features replaced. */
const withFeatures = (features) => ({
  ...ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT.en,
  features,
});

test("a feature may carry a destination, and it is an id", () => {
  const payload = parseProductAnnouncementPayload(
    withFeatures([
      {
        title: "Compare answers",
        body: "Ask several models the same question.",
        linkId: "release.compare-models",
        linkLabel: "See how it works",
      },
    ])
  );

  assert.equal(
    payload.features[0].link.url,
    "https://tomverse.app/compare-ai-models"
  );
  assert.equal(payload.features[0].link.label, "See how it works");
});

test("a feature without a destination has none", () => {
  const payload = parseProductAnnouncementPayload(
    withFeatures([{ title: "t", body: "b" }])
  );
  assert.equal(payload.features[0].link, null);
});

test("a URL is not an id, however much it looks like one", () => {
  // The whole point of the table: a validator over a URL can only answer "does
  // this look acceptable", and the question is "is this one of the places we
  // decided to send people".
  for (const linkId of [
    "https://tomverse.app/models",
    "/models",
    "link.models",
    "release.pricing",
    "",
  ]) {
    assert.throws(
      () =>
        parseProductAnnouncementPayload(
          withFeatures([{ title: "t", body: "b", linkId, linkLabel: "Read more" }])
        ),
      /not an approved release-notes destination/,
      String(linkId)
    );
  }
});

test("a label with nowhere to go is refused", () => {
  // It would render as text that looks like a link and is not one, which is
  // worse than no label at all.
  assert.throws(
    () =>
      parseProductAnnouncementPayload(
        withFeatures([{ title: "t", body: "b", linkLabel: "Read more" }])
      ),
    /needs a linkId to go with it/
  );
});

test("a destination needs a label", () => {
  assert.throws(
    () =>
      parseProductAnnouncementPayload(
        withFeatures([{ title: "t", body: "b", linkId: "release.models" }])
      ),
    /linkLabel is required/
  );
});

test("the destination reaches both halves of the message", () => {
  // Some people only ever see the text part, and one that drops the link tells
  // them less than the HTML did.
  const { html, text } = buildProductAnnouncementEmail(
    withFeatures([
      {
        title: "Compare answers",
        body: "Ask several models the same question.",
        linkId: "release.compare-models",
        linkLabel: "See how it works",
      },
    ]),
    "en"
  );

  assert.ok(html.includes("https://tomverse.app/compare-ai-models"));
  assert.ok(html.includes("See how it works"));
  assert.ok(
    text.includes("See how it works: https://tomverse.app/compare-ai-models")
  );
});

test("a rendered destination is not an input", () => {
  // The input type and the parsed type were the same until 2026-09-23, so a
  // feature carrying an already-resolved link type-checked and the parser
  // dropped it: no link, no error, and the caller believing it went out. An
  // approved destination vanished exactly as quietly as a commercial one.
  assert.throws(
    () =>
      parseProductAnnouncementPayload(
        withFeatures([
          {
            title: "t",
            body: "b",
            link: { label: "See how it works", url: "https://tomverse.app/models" },
          },
        ])
      ),
    /features\[0\]\.link is a rendered value/
  );

  assert.throws(
    () =>
      parseProductAnnouncementPayload(
        withFeatures([
          {
            title: "t",
            body: "b",
            link: { label: "Pricing", url: "https://tomverse.app/pricing" },
          },
        ])
      ),
    /features\[0\]\.link is a rendered value/
  );

  assert.throws(
    () =>
      parseProductAnnouncementPayload(
        withFeatures([{ title: "t", body: "b", url: "https://tomverse.app/models" }])
      ),
    /features\[0\]\.url is a rendered value/
  );
});

test("a parsed payload cannot be parsed again", () => {
  // The round trip the type confusion allowed: parse once, feed the result
  // back, and get a mail with no feature links and nothing to say so.
  const once = parseProductAnnouncementPayload(
    withFeatures([
      {
        title: "Compare answers",
        body: "Ask several models the same question.",
        linkId: "release.compare-models",
        linkLabel: "See how it works",
      },
    ])
  );
  assert.notEqual(once.features[0].link, null);

  assert.throws(
    () => parseProductAnnouncementPayload(once),
    /is a rendered value/
  );
});
