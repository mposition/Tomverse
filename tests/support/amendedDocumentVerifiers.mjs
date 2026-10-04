// What each amended document actually says now, recomputed from its source.
//
// Contract: docs/policy/email-product-news-redesign-draft.md section 10, and
// `DIGEST_VERIFIED_BY` in lib/emailPolicyPublication.ts.
//
// tests/emailPolicyPublication.test.mjs runs every verifier here and compares
// the result with the record the publication gate reads. An entry in
// `DIGEST_VERIFIED_BY` without a verifier here, or with one whose digest or
// shown date disagrees with the record, fails that test -- which is what makes
// "verified" mean something.
//
// The /privacy inputs are the ones tests/sitemapLastModified.test.mjs hashes,
// in the order lib/sitemapContentDates.ts documents.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { infoPages } from "../../components/marketing/marketingInfoContent.ts";
import { en } from "../../locales/en.ts";
import { ko } from "../../locales/ko.ts";
import { zh } from "../../locales/zh.ts";
import { fr } from "../../locales/fr.ts";
import { de } from "../../locales/de.ts";
import { es } from "../../locales/es.ts";
import { pt } from "../../locales/pt.ts";

const PRIVACY_LOCALES = { en, ko, zh, fr, de, es, pt };

const source = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");

const squash = (text) => text.toLowerCase().replace(/\s+/g, "");

/** Whether every locale's text shows `date` (YYYY-MM-DD) as its formatted date. */
const showsDateInEveryLocale = (textFor, date, locales = PRIVACY_LOCALES) =>
  Object.entries(locales).every(([locale, copy]) => {
    const expected = new Intl.DateTimeFormat(locale, {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${date}T00:00:00.000Z`));
    return squash(textFor(copy)).includes(squash(expected));
  });

/**
 * One verifier per document: the record it answers for, the digest of what is
 * rendered now, and whether the document shows a given effective date.
 */
export const AMENDED_DOCUMENT_VERIFIERS = {
  "/privacy": {
    record: "amended",
    digest: () => {
      const digest = createHash("sha256");
      digest.update(source("components/legal/PrivacyPolicy.tsx"));
      digest.update(source("lib/providerDataDestinations.ts"));
      for (const copy of Object.values(PRIVACY_LOCALES)) {
        digest.update(JSON.stringify(copy.privacyPolicy));
      }
      return digest.digest("hex");
    },
    showsDate: (date) => showsDateInEveryLocale((copy) => copy.privacyPolicy.effective, date),
  },
  // Every locale the terms page has, in the object's own order. The shown date
  // is the "updated" line, which is the date a reader of the page sees.
  "/terms": {
    record: "amended",
    digest: () => {
      const digest = createHash("sha256");
      digest.update(JSON.stringify(infoPages.terms));
      return digest.digest("hex");
    },
    showsDate: (date) => showsDateInEveryLocale((copy) => copy.updated, date, infoPages.terms),
  },
};
