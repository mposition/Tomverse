import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CONSENT_RESULT_NOTICE_TEMPLATE,
  UNSUBSCRIBE_RESULT_NOTICE_TEMPLATE,
  buildProcessingResultNotice,
  emailTemplateDefinition,
} from "../lib/emailTemplateDefinitions.ts";
import { processingResultDate } from "../lib/processingResultNotice.ts";

// Korea's 14-day processing-result notices (S6b).
// Contract: docs/policy/email-consent-copy-draft.md sections 4.1 and 4.2 hold the
// approved wording; docs/policy/email-product-news-redesign-draft.md 7.7 the duty.

const DOC = readFileSync("docs/policy/email-consent-copy-draft.md", "utf8");

/** One approved notice, read from the document: subject per language and the body text. */
const approved = (heading) => {
  const start = DOC.indexOf(heading);
  assert.ok(start >= 0, `${heading} is not in the document`);
  const end = DOC.indexOf("\n### ", start + heading.length);
  const section = DOC.slice(start, end);
  const subject = (language) => {
    const row = section.split("\n").find((line) => line.startsWith(`| ${language} |`));
    assert.ok(row, `${heading}: no ${language} subject`);
    return row.split("|")[2].trim();
  };
  const body = (language) => {
    const marker = `**본문 (${language})**`;
    const at = section.indexOf(marker);
    assert.ok(at >= 0, `${heading}: no ${language} body`);
    const quoted = [];
    for (const line of section.slice(at + marker.length).split("\n").slice(1)) {
      if (!line.startsWith(">")) {
        if (quoted.length > 0) break;
        continue;
      }
      quoted.push(line.replace(/^> ?/, ""));
    }
    // The first paragraph is one fact per line; the second is one sentence
    // pair, wrapped for the page.
    const blank = quoted.indexOf("");
    const facts = quoted.slice(0, blank);
    const closing = quoted.slice(blank + 1).join(" ");
    return `${facts.join("\n")}\n\n${closing}`;
  };
  return { subject, body };
};

test("the consent notice is the approved wording, byte for byte", () => {
  const doc = approved("### 4.1 수신동의 처리결과 통지");
  for (const language of ["ko", "en"]) {
    const rendered = buildProcessingResultNotice("consent", { date: "{{consentDate}}" }, language);
    assert.equal(rendered.subject, doc.subject(language), language);
    assert.equal(rendered.text, doc.body(language), language);
  }
});

test("the unsubscribe notice is the approved wording, byte for byte", () => {
  const doc = approved("### 4.2 수신거부·철회 처리결과 통지");
  for (const language of ["ko", "en"]) {
    const rendered = buildProcessingResultNotice("unsubscribe", { date: "{{processedDate}}" }, language);
    assert.equal(rendered.subject, doc.subject(language), language);
    assert.equal(rendered.text, doc.body(language), language);
  }
});

test("only Korean and English were approved; everyone else reads the English", () => {
  for (const language of ["zh", "fr", "de", "es", "pt", null]) {
    assert.deepEqual(
      buildProcessingResultNotice("consent", { date: "2026-09-29" }, language),
      buildProcessingResultNotice("consent", { date: "2026-09-29" }, "en")
    );
  }
});

test("both notices are transactional, carry no unsubscribe link and no purpose", () => {
  for (const key of [CONSENT_RESULT_NOTICE_TEMPLATE, UNSUBSCRIBE_RESULT_NOTICE_TEMPLATE]) {
    const definition = emailTemplateDefinition(key);
    assert.equal(definition.classification, "transactional", key);
    assert.equal(definition.purpose, null, key);
    assert.equal(definition.requiresUnsubscribe, false, key);
  }
});

test("the date is the Korean calendar day", () => {
  // 2026-09-29 15:30 UTC is already the 30th in Seoul.
  assert.equal(processingResultDate(new Date("2026-09-29T15:30:00.000Z")), "2026-09-30");
  assert.equal(processingResultDate(new Date("2026-09-29T14:59:59.999Z")), "2026-09-29");
});
