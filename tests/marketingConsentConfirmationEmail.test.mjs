import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MARKETING_CONSENT_CONFIRMATION_COPY,
  buildMarketingConsentConfirmationEmail,
} from "../lib/marketingConsentConfirmationEmail.ts";

// The confirmation mail confirms and does nothing else.
// Contract: docs/policy/email-double-opt-in.md §3 rules 2-3.
//
// A confirmation mail that promotes something is itself advertising sent to
// somebody who has not consented. So the copy is checked for the shape of a
// promotion rather than trusted to stay plain.

const LANGUAGES = ["en", "ko", "zh", "fr", "de", "es", "pt"];
const CONFIRM_URL = "https://tomverse.app/consent/confirm?t=c1.v1.iv.ct.tag";

// Words that turn a confirmation into an advertisement, in the languages the
// copy exists in. Checked against the copy's own sentences only.
const PROMOTIONAL = [
  /\b(new feature|discount|offer ends|free trial|upgrade|limited time|save \d|% off|pro plan|max plan)\b/i,
  /(할인|무료 체험|업그레이드|한정|신규 기능|요금제)/,
  /(折扣|免费试用|升级|限时)/,
  /\b(remise|essai gratuit|mettre à niveau|durée limitée)\b/i,
  /\b(rabatt|kostenlos testen|upgrade|zeitlich begrenzt)\b/i,
  /\b(descuento|prueba gratuita|mejorar plan|tiempo limitado)\b/i,
  /\b(desconto|teste grátis|fazer upgrade|tempo limitado)\b/i,
];

test("every language exists and renders with exactly one link", () => {
  assert.deepEqual(Object.keys(MARKETING_CONSENT_CONFIRMATION_COPY).sort(), [...LANGUAGES].sort());
  for (const language of LANGUAGES) {
    for (const purpose of ["product_updates", "newsletter", "promotions"]) {
      const email = buildMarketingConsentConfirmationEmail(
        { purpose, confirmUrl: CONFIRM_URL },
        language
      );
      const links = email.html.match(/<a\s/g) ?? [];
      assert.equal(links.length, 1, `${language}/${purpose}: one link only`);
      assert.ok(email.html.includes(CONFIRM_URL), `${language}/${purpose}: link`);
      assert.ok(email.text.includes(CONFIRM_URL), `${language}/${purpose}: text link`);
      const urls = email.text.match(/https?:\/\/\S+/g) ?? [];
      assert.deepEqual(urls, [CONFIRM_URL], `${language}/${purpose}: no other URL`);
    }
  }
});

test("the copy carries no promotion", () => {
  for (const language of LANGUAGES) {
    const email = buildMarketingConsentConfirmationEmail(
      { purpose: "promotions", confirmUrl: CONFIRM_URL },
      language
    );
    const prose = `${email.subject}\n${email.text.replace(CONFIRM_URL, "")}`;
    for (const pattern of PROMOTIONAL) {
      assert.doesNotMatch(prose, pattern, `${language}: ${pattern}`);
    }
  }
});

test("it says what happens if the reader did not ask", () => {
  for (const language of LANGUAGES) {
    const copy = MARKETING_CONSENT_CONFIRMATION_COPY[language];
    const email = buildMarketingConsentConfirmationEmail(
      { purpose: "newsletter", confirmUrl: CONFIRM_URL },
      language
    );
    assert.ok(email.text.includes(copy.ignore), language);
    assert.ok(email.text.includes(copy.expiry), language);
  }
});

test("the URL is escaped in HTML and the render is deterministic", () => {
  const hostile = 'https://tomverse.app/consent/confirm?t=a"><script>';
  const email = buildMarketingConsentConfirmationEmail(
    { purpose: "newsletter", confirmUrl: hostile },
    "en"
  );
  assert.equal(email.html.includes("<script>"), false);
  assert.deepEqual(
    buildMarketingConsentConfirmationEmail({ purpose: "newsletter", confirmUrl: CONFIRM_URL }, "ko"),
    buildMarketingConsentConfirmationEmail({ purpose: "newsletter", confirmUrl: CONFIRM_URL }, "ko")
  );
});
