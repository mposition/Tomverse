import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAccountDeletionScheduledEmail,
  buildAccountRestoredEmail,
} from "../lib/accountEmails.ts";
import { SUPPORTED_LANGUAGES } from "../lib/language.ts";

// The two account lifecycle notices, in every language this product speaks.
//
// Contract: docs/policy/email-notifications.md §3, §8.6.
//
// EM-12: the deletion notice is the least reversible message this system
// sends -- an account and everything in it will be destroyed on a date -- and
// it had one language. The welcome mail in the same file has had seven since
// it was written.
//
// What must hold: every language renders, no two are the same message, the
// facts a recipient needs to act survive translation, and nothing here
// apologises or hurries them (§14.3: facts and user impact first).

const SCHEDULED_FOR = "2026-09-15T09:00:00.000Z";

const deletion = (language) =>
  buildAccountDeletionScheduledEmail({ scheduledFor: SCHEDULED_FOR, language });

test("the deletion notice renders in every supported language", () => {
  assert.equal(SUPPORTED_LANGUAGES.length, 7);
  const subjects = new Set();
  for (const language of SUPPORTED_LANGUAGES) {
    const { subject, text, html } = deletion(language);
    assert.ok(subject.length > 0, `${language} subject`);
    // The date is the one fact the recipient has to act before.
    assert.ok(text.includes(SCHEDULED_FOR), `${language} omits the date`);
    assert.ok(html.includes(SCHEDULED_FOR), `${language} html omits the date`);
    // And the address, because cancelling is not self-service.
    assert.ok(text.includes("support@tomverse.app"), `${language} omits support`);
    assert.match(html, /mailto:support@tomverse\.app/, `${language} html omits support`);
    subjects.add(subject);
  }
  // A language silently falling back to English would collapse these.
  assert.equal(subjects.size, 7);
});

test("the restoration notice renders in every supported language", () => {
  const subjects = new Set();
  for (const language of SUPPORTED_LANGUAGES) {
    const { subject, text, html } = buildAccountRestoredEmail({ language });
    assert.ok(subject.length > 0, `${language} subject`);
    assert.ok(text.length > 40, `${language} body`);
    assert.ok(html.startsWith("<p>"), `${language} html`);
    subjects.add(subject);
  }
  assert.equal(subjects.size, 7);
});

test("an absent or unknown language is English, not a crash", () => {
  const english = deletion("en");
  assert.deepEqual(deletion(undefined), english);
  assert.deepEqual(deletion(null), english);
  assert.deepEqual(deletion("xx"), english);
  assert.deepEqual(buildAccountRestoredEmail(), buildAccountRestoredEmail({ language: "en" }));
});

test("the deletion notice states all four facts in every language", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const { text } = deletion(language);
    const paragraphs = text.split("\n\n").filter(Boolean);
    // Access stopped and the date; renewal; how to cancel; what to do if it
    // was not you. Dropping any one of them in translation is how a notice
    // becomes unactionable in one language only.
    assert.equal(paragraphs.length, 4, `${language} has ${paragraphs.length} paragraphs`);
    for (const paragraph of paragraphs) {
      assert.ok(paragraph.length > 20, `${language} has a stub paragraph`);
    }
  }
});

test("the date is escaped in the html", () => {
  const { html } = buildAccountDeletionScheduledEmail({
    scheduledFor: '<script>alert(1)</script>',
    language: "ko",
  });
  assert.doesNotMatch(html, /<script>/);
  assert.ok(html.includes("&lt;script&gt;"));
});

test("no locale apologises or hurries the recipient", () => {
  // §14.3: facts and user impact first, no apology, no "act now or else".
  const forbidden = [
    "sorry",
    "we apologise",
    "we apologize",
    "죄송",
    "사과",
    "抱歉",
    "désolé",
    "entschuldig",
    "lo sentimos",
    "desculpe",
    "act now",
    "지금 조치하지 않으면",
  ];
  for (const language of SUPPORTED_LANGUAGES) {
    for (const build of [deletion(language), buildAccountRestoredEmail({ language })]) {
      const body = `${build.subject}\n${build.text}`.toLowerCase();
      for (const word of forbidden) {
        assert.equal(body.includes(word.toLowerCase()), false, `${language}: "${word}"`);
      }
    }
  }
});

test("the same input renders the same bytes twice", () => {
  assert.deepEqual(deletion("ko"), deletion("ko"));
  assert.deepEqual(
    buildAccountRestoredEmail({ language: "zh" }),
    buildAccountRestoredEmail({ language: "zh" })
  );
});
