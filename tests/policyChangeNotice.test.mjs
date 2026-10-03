import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  POLICY_CHANGE_NOTICE_APPROVED_CONTENT_HASHES,
  POLICY_CHANGE_NOTICE_EFFECTIVE_DATE,
  buildPolicyChangeNoticeEmail,
  isPolicyChangeNoticeWordingApproved,
  policyChangeNoticeRenderHash,
} from "../lib/policyChangeNoticeEmail.ts";
import { templateContentHash } from "../lib/emailTemplateRegistry.ts";
import { documentFacts } from "../lib/emailPolicyPublication.ts";
import { effectiveDateOf } from "../lib/emailPolicyPublicationCore.ts";

// The amendment notice (S10): only approved wording can be queued or sent.
// Contract: docs/policy/email-policy-amendment-draft.md sections 4 and 5.

const APP = "https://tomverse.app";
const LANGUAGES = ["en", "ko", "zh", "fr", "de", "es", "pt"];

test("the hash the notice checks is the hash the registry records", () => {
  // The publication gate counts deliveries by TemplateVersion.contentHash, so
  // the approval has to be over the same bytes.
  for (const language of LANGUAGES) {
    assert.equal(
      policyChangeNoticeRenderHash(language, APP),
      templateContentHash(buildPolicyChangeNoticeEmail({ language, appUrl: APP }))
    );
  }
});

test("the wording approved on 2026-10-03 is what production renders, in every language", () => {
  // docs/policy/email-policy-amendment-draft.md §4 and §5: approved by
  // mposition, effective 2026-11-16. One hash per language, computed with
  // production's site URL.
  assert.equal(POLICY_CHANGE_NOTICE_EFFECTIVE_DATE, "2026-11-16");
  assert.equal(POLICY_CHANGE_NOTICE_APPROVED_CONTENT_HASHES.length, LANGUAGES.length);
  for (const language of LANGUAGES) {
    assert.equal(isPolicyChangeNoticeWordingApproved(language, APP), true, language);
  }
  // Any other site URL renders other bytes, so a staging render is not the
  // approved notice: the links are part of what was approved.
  assert.equal(isPolicyChangeNoticeWordingApproved("en", "https://staging.tomverse.app"), false);
});

test("the notice announces the documents' own effective date", () => {
  // Once set, the date in the notice and the date the pages show are one date.
  if (POLICY_CHANGE_NOTICE_EFFECTIVE_DATE === null) return;
  const documents = effectiveDateOf(documentFacts());
  assert.ok(documents, "the documents show no single effective date");
  assert.equal(documents.toISOString().slice(0, 10), POLICY_CHANGE_NOTICE_EFFECTIVE_DATE);
});

test("every writer of a notice delivery, and the drain, asks whether the wording is approved", () => {
  // Draft, approval, the single-row writer every enqueue and test send goes
  // through, the campaign fan-out, and the drain before it sends.
  const reads = (file, needle) =>
    assert.ok(readFileSync(file, "utf8").includes(needle), `${file} does not check ${needle}`);
  reads("lib/emailCampaignService.ts", "assertChangeNoticeWordingApproved(input.templateKey, input.locales)");
  reads("lib/emailCampaignService.ts", "assertChangeNoticeWordingApproved(campaign.templateKey, locales)");
  reads("lib/standardEmailLane.ts", "assertPolicyChangeNoticeApproved(definition.key, input.language)");
  reads("lib/standardEmailLane.ts", "notice_wording_unapproved");
  reads("lib/emailAudienceExpansion.ts", "isPolicyChangeNoticeWordingApproved(language, appUrl())");
});

test("every language says may, not will", () => {
  // A permission the policy grants, not a statement about who will receive
  // what: the sealed list leaves people out.
  for (const language of LANGUAGES) {
    const text = buildPolicyChangeNoticeEmail({ language, appUrl: APP }).text;
    assert.ok(!/with two exceptions|à deux exceptions|mit zwei Ausnahmen|con dos excepciones|com duas exceções/.test(text), language);
  }
  assert.match(buildPolicyChangeNoticeEmail({ language: "en", appUrl: APP }).text, /Tomverse may send product update emails/);
  // And every language closes the case: otherwise only if asked.
  const closing = {
    en: /Otherwise we send them only if you ask/,
    ko: /그 밖에는 신청하신 경우에만 보냅니다/,
    zh: /其他情况下，只有在您申请后才会发送/,
    fr: /Sinon, nous ne les envoyons que si vous les demandez/,
    de: /Andernfalls senden wir sie nur auf Ihre Anforderung/,
    es: /En los demás casos solo las enviamos si las pides/,
    pt: /Nos demais casos, só enviamos se você pedir/,
  };
  for (const language of LANGUAGES) {
    assert.match(buildPolicyChangeNoticeEmail({ language, appUrl: APP }).text, closing[language], language);
  }
  assert.match(buildPolicyChangeNoticeEmail({ language: "ko", appUrl: APP }).text, /보낼 수 있습니다/);
});

test("the notice names only the case the send rules can reach", () => {
  // Accounts registered before the announcement (the sealed list). No
  // relationship case: no approved sign-up notice discloses relationship
  // sending, and a relationship is judged against the recipient rule at send
  // time, not where the account was opened.
  const countries = /Australia|United States|호주|미국|澳大利亚|美国|Australie|États-Unis|Australien|Vereinigten Staaten|Estados Unidos|Austrália|Estados Unidos/;
  for (const language of LANGUAGES) {
    const { text, html } = buildPolicyChangeNoticeEmail({ language, appUrl: APP });
    assert.doesNotMatch(text, countries, language);
    assert.doesNotMatch(html, countries, language);
    assert.doesNotMatch(text, /24/, language);
  }
});

test("the /privacy draft closes the unasked case the way the notice does", () => {
  // Without the closing sentence the draft does not rule other paths out.
  const draft = readFileSync("docs/policy/email-policy-amendment-draft.md", "utf8");
  const section = draft.slice(draft.indexOf("## 2."), draft.indexOf("## 3."));
  assert.match(section, /그 밖에는 신청하신 경우에만 보냅니다/);
  assert.match(section, /Otherwise they are sent only if you ask for them/);
  assert.doesNotMatch(section, /호주나 미국|Australia or the United States|24개월|24 months/);
});
