// The approved consent wording, and the hash that has to keep naming it.
//
// Contract: docs/policy/email-consent-copy-draft.md, approved 2026-09-23.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CONSENT_COPY_KEYS,
  CONSENT_COPY_LANGUAGES,
  CONSENT_COPY_VERSIONS,
  CURRENT_CONSENT_COPY_VERSION,
  consentCopy,
  consentCopyCanonical,
} from "../lib/emailConsentCopy.ts";
import {
  allConsentCopyHashes,
  consentCopyForHash,
  consentCopyHash,
} from "../lib/emailConsentCopyHash.ts";

test("every device has every approved language", () => {
  // Section 2's approved choice: the four consent devices carry all seven,
  // because a consent is only valid if the person understood it and four of
  // the five fallback locales are EEA languages.
  for (const key of CONSENT_COPY_KEYS) {
    for (const language of CONSENT_COPY_LANGUAGES) {
      const text = consentCopy(key, language);
      assert.ok(
        typeof text === "string" && text.trim().length > 0,
        `${key} has no ${language}`
      );
    }
  }
});

test("the Korean opt-in label is the one the contract specifies", () => {
  // Draft section 5.1 names this string. It states the channel and that it is
  // optional, and neither word is ours to reword.
  assert.equal(
    consentCopy("signupOptIn", "ko"),
    "이메일 광고성 정보 수신동의 (선택)"
  );
});

test("no device label tries to sell the thing it describes", () => {
  // A checkbox label says what you are agreeing to. It is not a place to
  // persuade, and a label that persuades is a label somebody has to defend as
  // informed consent.
  const banned = [/놓치지/, /don't miss/i, /never miss/i, /best/i, /latest and greatest/i];
  for (const key of CONSENT_COPY_KEYS) {
    for (const language of CONSENT_COPY_LANGUAGES) {
      const text = consentCopy(key, language);
      for (const pattern of banned) {
        assert.ok(!pattern.test(text), `${key}.${language} matches ${pattern}`);
      }
    }
  }
});

test("the notice says the three kinds of mail that keep coming", () => {
  // Contract section 3's classification boundary, said on the screen rather
  // than only in the policy: somebody who reads "turned off" as "no more mail"
  // treats the next sign-in code as a violation.
  assert.match(consentCopy("signupNotice", "en"), /Sign-in codes/);
  assert.match(consentCopy("signupNotice", "en"), /receipts/);
  assert.match(consentCopy("signupNotice", "en"), /service notices/);
  assert.match(consentCopy("signupNotice", "ko"), /로그인 코드/);
  assert.match(consentCopy("signupNotice", "ko"), /영수증/);
});

test("both notices say unsubscribing needs no sign-in", () => {
  // Korea's guidance and the approved contract section 11.3.
  assert.match(consentCopy("signupNotice", "en"), /without signing in/);
  assert.match(consentCopy("noticeBody", "en"), /without signing in/);
  assert.match(consentCopy("signupNotice", "ko"), /로그인 없이/);
  assert.match(consentCopy("noticeBody", "ko"), /로그인 없이/);
});

test("the in-product notice opens by saying we have not been sending", () => {
  // Draft section 5.5: these accounts have no basis anywhere, so the screen
  // has to read as the first time we ask rather than as notice of something
  // already happening. A policy-change notice does not create a permission.
  assert.match(consentCopy("noticeBody", "en"), /^Tomverse has not sent you/);
  assert.match(consentCopy("noticeBody", "ko"), /^Tomverse는 지금까지/);
});

test("dismissing and refusing are different labels in every language", () => {
  // The whole reason there are three states. If the two read alike, a person
  // closing the dialog cannot tell which one they pressed.
  for (const language of CONSENT_COPY_LANGUAGES) {
    assert.notEqual(
      consentCopy("noticeDismiss", language),
      consentCopy("noticeRefuse", language),
      `dismiss and refuse read the same in ${language}`
    );
  }
});

// --- the hash ------------------------------------------------------------

test("a hash names one device in one language in one version", () => {
  // Two devices can legitimately carry the same sentence, so the key and the
  // language are hashed with the text. Otherwise a stored hash could not say
  // which screen it was evidence of.
  const hashes = allConsentCopyHashes();
  assert.equal(
    new Set(hashes.map((row) => row.hash)).size,
    hashes.length,
    "two entries share a hash"
  );
  assert.equal(
    hashes.length,
    CONSENT_COPY_VERSIONS.length *
      CONSENT_COPY_KEYS.length *
      CONSENT_COPY_LANGUAGES.length
  );
});

test("a stored hash resolves back to the words it names", () => {
  // The reason the hash exists. A `notice_shown` row carries this and nothing
  // else about the wording.
  const hash = consentCopyHash("noticeBody", "ko");
  const found = consentCopyForHash(hash);
  assert.equal(found?.key, "noticeBody");
  assert.equal(found?.language, "ko");
  assert.equal(found?.version, CURRENT_CONSENT_COPY_VERSION);
  assert.equal(found?.text, consentCopy("noticeBody", "ko"));
});

test("a hash of wording we never approved resolves to nothing", () => {
  assert.equal(consentCopyForHash("sha256:" + "0".repeat(64)), null);
});

test("an unknown version answers null rather than today's words", () => {
  // Answering with the current version would be the quiet substitution this
  // whole file exists to prevent.
  assert.equal(consentCopy("noticeBody", "ko", "1999-01-01"), null);
  assert.equal(consentCopyHash("noticeBody", "ko", "1999-01-01"), null);
});

test("the canonical form separates the fields it hashes", () => {
  // A hash over concatenated fields can be collided by moving a boundary.
  assert.notEqual(
    consentCopyCanonical({ version: "a", key: "noticeTitle", language: "en", text: "b" }),
    consentCopyCanonical({ version: "ab", key: "noticeTitle", language: "en", text: "" })
  );
});

// --- the approved document and this file are the same words --------------

test("every approved string appears in the approved document", () => {
  // The document is what the owner signed. If this file drifts from it, the
  // hash names words nobody approved -- and the drift would be invisible,
  // because nothing else compares them.
  const doc = readFileSync("docs/policy/email-consent-copy-draft.md", "utf8");
  for (const key of CONSENT_COPY_KEYS) {
    for (const language of CONSENT_COPY_LANGUAGES) {
      const text = consentCopy(key, language);
      assert.ok(
        doc.includes(text),
        `${key}.${language} is not in the approved document: ${text.slice(0, 40)}`
      );
    }
  }
});

test("the approved document records who approved it and when", () => {
  const doc = readFileSync("docs/policy/email-consent-copy-draft.md", "utf8");
  const current = CONSENT_COPY_VERSIONS[CONSENT_COPY_VERSIONS.length - 1];
  assert.ok(doc.includes(current.approvedBy), "approver missing from the document");
  assert.ok(doc.includes(current.approvedAt), "approval date missing from the document");
});
