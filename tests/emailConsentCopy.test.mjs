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
  consentCopyVersionDigest,
} from "../lib/emailConsentCopyHash.ts";
import {
  CONSENT_COPY_DIGESTS,
  consentCopyDigestKey,
} from "../lib/emailConsentCopyDigests.ts";
import { consentCopyPromisesNoUnrequestedSend } from "../lib/emailConsentCopy.ts";
import { consentCopyForLanguage } from "../lib/emailConsentCopyLocale.ts";

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

// What each language has to say, so the checks below cover all seven.
//
// They were English and Korean only, and a translation that dropped the
// sign-in-code sentence would have passed -- leaving that language's screen
// reading as "turn this off and the mail stops", so the next sign-in code
// looks like a violation.
const REQUIRED_PHRASES = {
  // Contract section 3's classification boundary, said on the screen.
  keepsComing: {
    ko: [/로그인 코드/, /영수증/, /서비스 공지/],
    en: [/Sign-in codes/, /receipts/, /service notices/],
    de: [/Anmeldecodes/, /(Rechnungsbelege|Belege)/, /Servicehinweise/],
    es: [/códigos de acceso/, /recibos/, /avisos de servicio/],
    fr: [/codes de connexion/, /reçus/, /avis de service/],
    pt: [/[Cc]ódigos de acesso/, /recibos/, /avisos de serviço/],
    zh: [/登录验证码/, /(收据|账单收据)/, /服务通知/],
  },
  // Korea's guidance and the approved contract section 11.3.
  noSignIn: {
    ko: [/로그인 없이/],
    en: [/without signing in/],
    de: [/ohne Anmeldung/],
    es: [/sin iniciar sesión/],
    fr: [/sans vous connecter/],
    pt: [/sem fazer login/],
    zh: [/无需登录/],
  },
};

test("every language names the three kinds of mail that keep coming", () => {
  for (const [language, patterns] of Object.entries(
    REQUIRED_PHRASES.keepsComing
  )) {
    for (const pattern of patterns) {
      assert.match(
        consentCopy("signupNotice", language),
        pattern,
        `signupNotice.${language}`
      );
      assert.match(
        consentCopy("noticeBody", language),
        pattern,
        `noticeBody.${language}`
      );
    }
  }
});

test("every language says unsubscribing needs no sign-in", () => {
  for (const [language, patterns] of Object.entries(REQUIRED_PHRASES.noSignIn)) {
    for (const pattern of patterns) {
      assert.match(
        consentCopy("signupNotice", language),
        pattern,
        `signupNotice.${language}`
      );
      assert.match(
        consentCopy("noticeBody", language),
        pattern,
        `noticeBody.${language}`
      );
    }
  }
});

test("the in-product notice opens by saying we have not been sending", () => {
  // Draft section 5.5: these accounts have no basis anywhere, so the screen
  // has to read as the first time we ask rather than as notice of something
  // already happening. A policy-change notice does not create a permission.
  assert.match(consentCopy("noticeBody", "en"), /^Tomverse has not sent you/);
  assert.match(consentCopy("noticeBody", "ko"), /^Tomverse는 지금까지/);
});

test("the opening sentence is about the reader, where the language marks that", () => {
  // "We have not sent product news" without a recipient is a claim about the
  // world, and it is not one we could keep. Six of the seven mark the reader
  // with a pronoun; Korean marks it with the honorific verb form instead, and
  // an explicit pronoun there would read as stilted rather than as careful.
  const marksTheReader = {
    en: /sent you/,
    de: /Ihnen/,
    es: /te ha enviado/,
    fr: /vous a pas envoyé/,
    zh: /向您发送/,
    ko: /보내드린/,
  };
  for (const [language, pattern] of Object.entries(marksTheReader)) {
    assert.match(
      consentCopy("noticeBody", language),
      pattern,
      `noticeBody.${language} does not mark the reader`
    );
  }
});

test("the wording defects waiting on a new version are the ones we know about", () => {
  // Portuguese is the one language whose opening sentence has no recipient:
  // `A Tomverse não enviou novidades do produto` reads literally as a claim
  // about everybody. The other five pronoun languages name the reader.
  //
  // It is not corrected here, and that restraint is the point. Section 9 says
  // approved wording is versioned rather than edited, and this string is
  // approved. Nothing has rendered it yet, so no evidence points at it, which
  // makes the correction cheap -- but cheap is not the same as ours to make.
  //
  // This test exists so the defect cannot be forgotten between now and that
  // decision, and so it fails the day somebody silently fixes it without
  // adding a version.
  // The first clause only. The second one ("a menos que você peça") does name
  // the reader, which is what makes this read as a slip rather than a choice.
  const firstClause = consentCopy("noticeBody", "pt").split(" e não enviará")[0];
  assert.equal(firstClause, "A Tomverse não enviou novidades do produto");
  assert.ok(
    !/você|lhe |te /.test(firstClause),
    "the Portuguese opening now names the reader; record the new version rather than editing this test"
  );
});

test("this wording promises something the override contradicts", () => {
  // Not a style note. The notice promises we have not sent and will not
  // without being asked; the owner's other approved decision sends to these
  // same accounts under `risk_accepted`, without consent. One such send makes
  // the promise false and the stored `copyHash` evidence that we showed it.
  //
  // The owner chose option B on 2026-09-23: the notice is not shown to
  // somebody the override actually mails (S8a's `overrideWouldSend()`), and
  // once it has been shown, no override applies to them again.
  assert.equal(consentCopyPromisesNoUnrequestedSend("2026-09-23"), true);
  assert.equal(consentCopyPromisesNoUnrequestedSend("not-a-version"), false);
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

test("every approved string sits in its own language's cell of the approved document", () => {
  // The document is what the owner signed. If this file drifts from it, the
  // hash names words nobody approved.
  //
  // Matched per language, not against every cell at once. Pooling the cells
  // let a Korean label be swapped for an English sentence that already
  // appeared elsewhere in the document -- the string was "in the document",
  // just not in the Korean column. A whole cell rather than a substring, too:
  // `받지 않겠습니다` is inside `광고성 이메일을 받지 않겠습니다`.
  const doc = readFileSync("docs/policy/email-consent-copy-draft.md", "utf8");
  const clean = (cell) => cell.trim().replace(/^\*\*(.*)\*\*$/, "$1");
  const rows = doc
    .split("\n")
    .filter((line) => line.startsWith("|") && !/^\|[-\s|]+\|$/.test(line))
    .map((line) => line.split("|").slice(1, -1).map(clean));

  // Two table shapes. Most tables have a language in the first column and the
  // text in the second. The button table is transposed: its header names the
  // languages, and each row starts with the button's role.
  const byLanguage = new Map();
  for (const row of rows) {
    if (CONSENT_COPY_LANGUAGES.includes(row[0]) && row.length === 2) {
      if (!byLanguage.has(row[0])) byLanguage.set(row[0], new Set());
      byLanguage.get(row[0]).add(row[1]);
    }
  }
  const header = rows.find(
    (row) => row.length > 7 && CONSENT_COPY_LANGUAGES.every((l) => row.includes(l))
  );
  assert.ok(header, "the transposed button table's header was not found");
  for (const row of rows) {
    if (row.length !== header.length || row === header) continue;
    header.forEach((column, index) => {
      if (!CONSENT_COPY_LANGUAGES.includes(column)) return;
      if (!byLanguage.has(column)) byLanguage.set(column, new Set());
      byLanguage.get(column).add(row[index]);
    });
  }

  for (const key of CONSENT_COPY_KEYS) {
    for (const language of CONSENT_COPY_LANGUAGES) {
      const text = consentCopy(key, language);
      assert.ok(
        byLanguage.get(language)?.has(text),
        `${key}.${language} is not in the approved document's ${language} cells: ${text.slice(0, 40)}`
      );
    }
  }
});

test("the approved document records the digest of the version it approved", () => {
  // Per-string pins stop an approved byte moving on its own, but a commit that
  // changes a string *and* its pin passes them. The whole-version digest is
  // also written into the owner's signed record, so changing an approved byte
  // means editing that record -- which section 10 forbids and which a reviewer
  // sees for what it is.
  const doc = readFileSync("docs/policy/email-consent-copy-draft.md", "utf8");
  for (const { version } of CONSENT_COPY_VERSIONS) {
    const digest = consentCopyVersionDigest(version);
    assert.ok(
      doc.includes(digest),
      `version ${version} digest ${digest} is not recorded in the approved document`
    );
  }
});

test("no approved byte has moved since it was approved", () => {
  // The guard above compares code with document, and an editor changing both
  // -- which is what anybody fixing wording would do -- left it green while
  // the version name stayed `2026-09-23`. Every `copyHash` already stored
  // against that version then resolved to nothing, silently. This is the check
  // that cannot be satisfied by editing two files instead of one.
  for (const row of allConsentCopyHashes()) {
    const pinned =
      CONSENT_COPY_DIGESTS[
        consentCopyDigestKey(row.version, row.key, row.language)
      ];
    assert.equal(
      row.hash,
      pinned,
      `${row.version}/${row.key}/${row.language} changed; approved wording is versioned, not edited`
    );
  }
});

test("the pinned list covers every approved string and nothing else", () => {
  const live = new Set(
    allConsentCopyHashes().map((row) =>
      consentCopyDigestKey(row.version, row.key, row.language)
    )
  );
  assert.deepEqual(
    [...Object.keys(CONSENT_COPY_DIGESTS)].sort(),
    [...live].sort()
  );
});

test("a missing string is an error rather than an empty label", () => {
  // An empty label would ask for consent with nothing written on it, and the
  // hash would be null for the same gap. Both silent.
  for (const language of CONSENT_COPY_LANGUAGES) {
    const table = consentCopyForLanguage(language);
    for (const key of CONSENT_COPY_KEYS) {
      assert.ok(table[key].length > 0, `${key}.${language} is empty`);
    }
  }
});

test("the approved document records who approved it and when", () => {
  const doc = readFileSync("docs/policy/email-consent-copy-draft.md", "utf8");
  const current = CONSENT_COPY_VERSIONS[CONSENT_COPY_VERSIONS.length - 1];
  assert.ok(doc.includes(current.approvedBy), "approver missing from the document");
  assert.ok(doc.includes(current.approvedAt), "approval date missing from the document");
});
