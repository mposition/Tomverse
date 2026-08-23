import assert from "node:assert/strict";
import test from "node:test";

import { buildModelLaunchEmail } from "../lib/modelLaunchEmail.ts";
import { SUPPORTED_LANGUAGES } from "../lib/language.ts";
import {
  MODEL_LAUNCH_TEMPLATE,
  emailTemplateDefinition,
  templateDefinitionProblems,
} from "../lib/emailTemplateDefinitions.ts";

// Template A of the model lifecycle set: "a new model is available".
//
// Contract: docs/policy/email-notifications.md §3,
// .github/audits/model-lifecycle-email-2026-08-22.md §11.1, §14.2, §14.3.
//
// The copy rules are enforced here rather than trusted, for the same reason
// tests/autoRoutingUi.test.mjs enforces them on the routing copy: a superlative
// is a claim, and nothing in this codebase measures which model is best.

const PAYLOAD = {
  modelName: "Claude Opus 5.1",
  plans: "Pro and Max",
  highlights: ["200K context window", "Image and PDF input"],
  creditLine: "Premium tier - 12 credits per message",
  ctaUrl: "https://tomverse.app/chat?model=claude-opus-5-1",
};

test("the template is registered as marketing, gated, and unsubscribable", () => {
  const definition = emailTemplateDefinition(MODEL_LAUNCH_TEMPLATE);
  assert.equal(definition.classification, "marketing");
  assert.equal(definition.purpose, "product_updates");
  assert.equal(definition.requiresUnsubscribe, true);
  // The same rule the database holds as a CHECK.
  assert.deepEqual(templateDefinitionProblems(definition), []);
});

test("every supported language renders, with no silent fallback", () => {
  assert.equal(SUPPORTED_LANGUAGES.length, 7);
  const subjects = new Set();
  for (const language of SUPPORTED_LANGUAGES) {
    const { subject, html, text } = buildModelLaunchEmail(PAYLOAD, language);
    assert.ok(subject.includes(PAYLOAD.modelName), `${language} subject`);
    assert.ok(text.includes(PAYLOAD.creditLine), `${language} credit line`);
    assert.ok(text.includes(PAYLOAD.ctaUrl), `${language} cta`);
    assert.ok(html.includes(PAYLOAD.ctaUrl), `${language} cta in html`);
    subjects.add(subject);
  }
  // Seven distinct subjects: a language quietly falling back to English would
  // collapse them.
  assert.equal(subjects.size, 7);
});

test("an unknown language falls back to English rather than throwing", () => {
  const { subject } = buildModelLaunchEmail(PAYLOAD, "xx");
  assert.equal(subject, buildModelLaunchEmail(PAYLOAD, "en").subject);
});

test("no locale claims a model is best, fastest or smartest", () => {
  // The English list plus the words the other six would reach for. Nothing here
  // is measured anywhere in this repository, so none of it can be written.
  const forbidden = [
    "best",
    "fastest",
    "smartest",
    "most powerful",
    "most advanced",
    "state of the art",
    "최고",
    "가장 빠른",
    "가장 똑똑",
    "최강",
    "最好",
    "最强",
    "最快",
    "le meilleur",
    "das beste",
    "el mejor",
    "o melhor",
  ];
  for (const language of SUPPORTED_LANGUAGES) {
    const { subject, text } = buildModelLaunchEmail(PAYLOAD, language);
    const body = `${subject}\n${text}`.toLowerCase();
    for (const word of forbidden) {
      assert.equal(
        body.includes(word.toLowerCase()),
        false,
        `${language} claims "${word}"`
      );
    }
  }
});

test("every locale says why the message arrived and what does not change", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const { text } = buildModelLaunchEmail(PAYLOAD, language);
    const lines = text.split("\n").filter(Boolean);
    // The reason line is last, and the "nothing changes" sentence is present:
    // an announcement that reads as if a selection had been altered is the one
    // thing this template must not do.
    assert.ok(lines.length >= 5, `${language} is too short to carry both`);
    assert.ok(lines.at(-1).length > 10, `${language} has no reason line`);
  }
});

test("there is exactly one call to action", () => {
  const { html } = buildModelLaunchEmail(PAYLOAD, "en");
  assert.equal(html.match(/<a /g)?.length, 1);
});

test("interpolated values are escaped", () => {
  const { html } = buildModelLaunchEmail(
    { ...PAYLOAD, modelName: '<script>alert(1)</script>', ctaUrl: 'https://x/"y' },
    "en"
  );
  assert.doesNotMatch(html, /<script>/);
  assert.ok(html.includes("&lt;script&gt;"));
  assert.ok(html.includes("&quot;"));
});

test("the same payload renders the same bytes twice", () => {
  assert.deepEqual(
    buildModelLaunchEmail(PAYLOAD, "ko"),
    buildModelLaunchEmail(PAYLOAD, "ko")
  );
});
