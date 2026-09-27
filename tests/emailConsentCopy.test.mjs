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

/**
 * The document with everything markdown does not render stripped out.
 *
 * Every slice below reads raw lines, and that was a way through: a reviewer
 * reading the rendered document sees neither a fenced code block nor an HTML
 * comment, so the approved digest could be moved inside a fence, or the whole
 * approved table wrapped in `<!-- -->`, and the suite still found its lines.
 * The record has to be the record somebody reads.
 *
 * Both are blanked rather than removed, so a slice's line numbering is not
 * disturbed.
 *
 * The first version treated any run of backticks or tildes as a fence toggle
 * and only removed closed comments, and a review found three ways through it.
 * A fence indented four spaces is not a fence at all -- it is an indented code
 * block whose content is the literal delimiter -- so treating it as one blanked
 * the real table that followed. A backtick fence is not closed by a tilde one,
 * nor by a shorter run. And an unterminated `<!--` swallows the rest of the
 * document, so a reader saw no section 3 while the test read one.
 *
 * So: a fence opens on three or more backticks or tildes indented at most
 * three spaces, and closes only on a run of the same character at least as
 * long, with no trailing text. An unterminated comment or fence blanks
 * everything to the end.
 */
const renderedOnly = (doc) => {
  const lines = doc.split("\n");
  const out = [];
  let fence = null;
  let inComment = false;

  for (const line of lines) {
    if (inComment) {
      const end = line.indexOf("-->");
      out.push("");
      if (end >= 0) {
        inComment = false;
        // Anything after the close is rendered, and a table cannot start
        // mid-line, so keeping the remainder is enough.
        const rest = line.slice(end + 3);
        out[out.length - 1] = rest.trim() === "" ? "" : rest;
      }
      continue;
    }
    if (fence !== null) {
      out.push("");
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = null;
      }
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      out.push("");
      continue;
    }
    const comment = line.indexOf("<!--");
    if (comment >= 0) {
      const end = line.indexOf("-->", comment + 4);
      if (end >= 0) {
        out.push(line.slice(0, comment) + line.slice(end + 3));
      } else {
        inComment = true;
        out.push(line.slice(0, comment).trim() === "" ? "" : line.slice(0, comment));
      }
      continue;
    }
    out.push(line);
  }
  return out.join("\n");
};

const approvedDocument = () =>
  renderedOnly(readFileSync("docs/policy/email-consent-copy-draft.md", "utf8"));

// Where each key's approved cell is: the subsection, the bold label the table
// follows (null when the subsection holds exactly one table), and for the
// transposed button table the role row. A string is compared with that one
// cell and nothing else, so neither a copy of the sentence elsewhere nor a
// swap between two cells of the same language can stand in for it.
const APPROVED_CELL = {
  signupOptIn: { heading: "### 3.A", label: null, role: null },
  signupNotice: { heading: "### 3.B", label: null, role: null },
  signupRefuse: { heading: "### 3.C", label: null, role: null },
  noticeTitle: { heading: "### 3.D", label: "**제목**", role: null },
  noticeBody: { heading: "### 3.D", label: "**본문**", role: null },
  noticeAccept: { heading: "### 3.D", label: "**세 버튼**", role: "동의" },
  noticeRefuse: { heading: "### 3.D", label: "**세 버튼**", role: "거부" },
  noticeDismiss: { heading: "### 3.D", label: "**세 버튼**", role: "닫기" },
};

/** The text of one section, from its heading to the next heading of the same or higher level. */
const sectionOf = (doc, heading) => {
  const lines = doc.split("\n");
  // The heading must be unique. Taking the first match let a second
  // `### 3.D ...` (or `## 8. ...`) placed above the real one shadow it: the
  // matcher read the decoy section, and the approved cells below it could then
  // be edited freely.
  const found = [];
  lines.forEach((line, index) => {
    if (line.startsWith(heading)) found.push(index);
  });
  assert.equal(
    found.length,
    1,
    `the approved document must hold exactly one ${heading} heading`
  );
  const from = found[0];
  const level = heading.match(/^#+/)[0].length;
  let to = lines.length;
  for (let i = from + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+) /);
    if (m && m[1].length <= level) {
      to = i;
      break;
    }
  }
  return lines.slice(from, to).join("\n");
};

/**
 * Every table in a section, each with the last non-blank line before it (its
 * label) and its rows as trimmed cells, separator rows dropped.
 */
const tablesOf = (section) => {
  const clean = (cell) => cell.trim().replace(/^\*\*(.*)\*\*$/, "$1");
  const tables = [];
  let label = null;
  let current = null;
  for (const line of section.split("\n")) {
    if (line.startsWith("|")) {
      if (!current) {
        current = { label, rows: [] };
        tables.push(current);
      }
      if (!/^\|[-\s|:]+\|$/.test(line)) {
        current.rows.push(line.split("|").slice(1, -1).map(clean));
      }
      continue;
    }
    current = null;
    // A heading is not a label. Keeping it as one made every subsection's
    // single table compare as `null` by accident, which meant a repeated
    // `**제목**` above another subsection's table went unnoticed.
    if (line.trim() !== "") label = /^#/.test(line.trim()) ? null : line.trim();
  }
  return tables;
};

/** The one cell a key's approved string must equal. Fails unless it is unique. */
const approvedCell = (doc, key, language) => {
  const { heading, label, role } = APPROVED_CELL[key];
  const tables = tablesOf(sectionOf(doc, heading)).filter(
    (table) => label === null || table.label === label
  );
  assert.equal(tables.length, 1, `${key}: expected exactly one table under ${heading} ${label ?? ""}`);
  const [header, ...rows] = tables[0].rows;

  if (role === null) {
    assert.deepEqual(header, ["언어", "문안"], `${key}: not a language table`);
    const matches = rows.filter((row) => row[0] === language);
    assert.equal(matches.length, 1, `${key}.${language}: expected exactly one row`);
    assert.equal(matches[0].length, 2, `${key}.${language}: the row has extra cells`);
    return matches[0][1];
  }

  assert.equal(header[0], "역할", `${key}: not the transposed button table`);
  const column = header.indexOf(language);
  assert.ok(column > 0 && header.lastIndexOf(language) === column, `${key}: no single ${language} column`);
  const matches = rows.filter((row) => row[0] === role);
  assert.equal(matches.length, 1, `${key}: expected exactly one ${role} row`);
  assert.equal(matches[0].length, header.length, `${key}: the ${role} row is misaligned`);
  return matches[0][column];
};

test("every approved string is exactly its own cell of the approved document", () => {
  // The document is what the owner signed. If this file drifts from it, the
  // hash names words nobody approved.
  //
  // Three earlier versions each left a way through. Pooling every cell let a
  // Korean label be replaced by an English sentence found elsewhere. Pooling
  // per language let the approved cell be deleted while a copy of the sentence
  // survived in another table. Pooling per subsection let the title and body
  // cells, or two buttons, trade places. Now each key has one cell -- section,
  // table, role and language -- and must equal it, whole.
  const doc = approvedDocument();
  for (const key of CONSENT_COPY_KEYS) {
    assert.ok(APPROVED_CELL[key], `${key} has no approved cell`);
    for (const language of CONSENT_COPY_LANGUAGES) {
      assert.equal(
        consentCopy(key, language),
        approvedCell(doc, key, language),
        `${key}.${language} differs from its approved cell`
      );
    }
  }
});

test("section 3 holds exactly the approved devices, tables and roles", () => {
  // Reverse completeness. Every test above walks the eight keys the code
  // declares and finds each one's cell, which says nothing about what else the
  // document claims was approved: a `### 3.E` device, a fourth button role, or
  // an extra language column with an approved-looking sentence in it would all
  // pass while the code knew nothing about them. The owner signed section 3 as
  // a whole, so the whole of it is compared.
  const doc = approvedDocument();
  const section = sectionOf(doc, "## 3.");

  const subsections = section
    .split("\n")
    .filter((line) => /^### /.test(line))
    .map((line) => line.replace(/^(### \S+).*$/, "$1"));
  assert.deepEqual(subsections, ["### 3.0", "### 3.A", "### 3.B", "### 3.C", "### 3.D"]);

  // 3.0 is the summary of what the four devices are; the four that follow carry
  // the approved strings, and their tables are exactly the ones the keys name.
  // The labels are compared as they are, not nulled outside 3.D: a repeated
  // `**제목**` above another subsection's table would otherwise pass.
  const expectedTables = {
    "### 3.0": [null],
    "### 3.A": [null],
    "### 3.B": [null],
    "### 3.C": [null],
    "### 3.D": ["**제목**", "**본문**", "**세 버튼**"],
  };
  for (const [heading, labels] of Object.entries(expectedTables)) {
    const tables = tablesOf(sectionOf(doc, heading));
    assert.deepEqual(
      tables.map((table) => table.label),
      labels,
      `${heading} does not hold exactly the approved tables`
    );
  }

  // 3.0's table says there are four devices and what each records. A fifth row
  // there is a fifth approved device, and the eight keys would not notice.
  const devices = tablesOf(sectionOf(doc, "### 3.0"))[0].rows;
  assert.deepEqual(devices[0], ["#", "장치", "어디에", "무엇을 기록하는가"]);
  assert.deepEqual(
    devices.slice(1).map((row) => row[0]),
    ["A", "B", "C", "D"],
    "3.0 does not name exactly the four approved devices"
  );
  for (const row of devices) {
    assert.equal(row.length, 4);
  }

  // The language tables: one row per language and no more, so an eighth row
  // cannot claim an eighth approved language.
  for (const heading of ["### 3.A", "### 3.B", "### 3.C"]) {
    const [header, ...rows] = tablesOf(sectionOf(doc, heading))[0].rows;
    assert.deepEqual(header, ["언어", "문안"]);
    assert.deepEqual(rows.map((row) => row[0]), [...CONSENT_COPY_LANGUAGES]);
  }
  for (const label of ["**제목**", "**본문**"]) {
    const [header, ...rows] = tablesOf(sectionOf(doc, "### 3.D")).find(
      (table) => table.label === label
    ).rows;
    assert.deepEqual(header, ["언어", "문안"]);
    assert.deepEqual(rows.map((row) => row[0]), [...CONSENT_COPY_LANGUAGES]);
  }

  // The button table: the whole header, in order, and exactly three roles. An
  // extra column was how an approved sentence could be added beside the cell
  // the code reads.
  const buttons = tablesOf(sectionOf(doc, "### 3.D")).find(
    (table) => table.label === "**세 버튼**"
  );
  assert.deepEqual(buttons.rows[0], ["역할", ...CONSENT_COPY_LANGUAGES]);
  assert.deepEqual(buttons.rows.slice(1).map((row) => row[0]), ["동의", "거부", "닫기"]);
  for (const row of buttons.rows) {
    assert.equal(row.length, 1 + CONSENT_COPY_LANGUAGES.length);
  }
});

test("the approval table binds every approved section to the version's approver and date", () => {
  // `doc.includes(approver)` was the whole of this check, so the approval cell
  // for section 3 could be changed to "rejected" and the suite still found the
  // name somewhere else in the document. The rows are what the owner signed, so
  // each one is read as a row, and each must carry the approver and date the
  // code records for the current version.
  const current = CONSENT_COPY_VERSIONS[CONSENT_COPY_VERSIONS.length - 1];
  const tables = tablesOf(sectionOf(approvedDocument(), "## 8."));
  const approvals = tables.filter(
    (table) => table.rows[0]?.[0] === "절" && table.rows[0]?.[2] === "승인"
  );
  // Exactly one. `find()` took the first, so a second table with the same
  // header and every cell reading "rejected" sat below it and passed.
  assert.equal(approvals.length, 1, "section 8 must hold exactly one approval table");
  const approval = approvals[0];
  assert.deepEqual(approval.rows[0], ["절", "내용", "승인"]);

  const rows = approval.rows.slice(1);
  assert.deepEqual(
    rows.map((row) => row[0]),
    ["§1", "§2", "§3.A–D", "§4.1–4.3", "§5", "§6"],
    "the approved sections are not the ones section 8 lists"
  );
  for (const row of rows) {
    assert.equal(row.length, 3, `${row[0]} has extra cells`);
    assert.equal(
      row[2],
      `${current.approvedBy}, ${current.approvedAt}`,
      `${row[0]} is not approved by the version's own approver and date`
    );
  }
});

test("the approval section records the digest of each version, once, on that version's line", () => {
  // Per-string pins stop an approved byte moving on its own, but a commit that
  // changes a string *and* its pin passes them. The whole-version digest is
  // also written into the owner's signed record, so changing an approved byte
  // means editing that record -- which section 10 forbids and which a reviewer
  // sees for what it is.
  //
  // Only section 8 counts, only as the digest's own line directly under the
  // line naming its version, and only once. `doc.includes()` was satisfied by
  // the digest anywhere; the first line-based version by the first matching
  // line, so a correct copy placed above the approval hid an edited one.
  const approval = sectionOf(approvedDocument(), "## 8.");
  const lines = approval.split("\n");
  const TICK = String.fromCharCode(96); // a backtick
  const digestLines = lines.filter((line) => /^`sha256:[0-9a-f]*`$/.test(line.trim()));
  assert.equal(
    digestLines.length,
    CONSENT_COPY_VERSIONS.length,
    "section 8 must hold exactly one digest line per version"
  );
  for (const { version } of CONSENT_COPY_VERSIONS) {
    const digest = consentCopyVersionDigest(version);
    const at = lines.indexOf(TICK + digest + TICK);
    assert.ok(at >= 0, `version ${version} digest ${digest} is not its own line in section 8`);
    assert.equal(lines.lastIndexOf(TICK + digest + TICK), at, `version ${version} digest appears twice`);
    const label = lines.slice(0, at).reverse().find((line) => line.trim() !== "");
    assert.ok(
      label?.includes("버전 " + TICK + version + TICK),
      `the digest line for ${version} is not under the line naming that version`
    );
  }
});

test("two versions never share a digest", () => {
  // The version digest covers the words, not the version's name. Two versions
  // with identical wording would share one, and section 8 could not tell which
  // approval it records. A version that changes nothing has no reason to exist.
  const digests = CONSENT_COPY_VERSIONS.map(({ version }) => consentCopyVersionDigest(version));
  assert.equal(new Set(digests).size, digests.length);
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


