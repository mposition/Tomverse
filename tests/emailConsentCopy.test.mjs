// The approved consent wording, and the hash that has to keep naming it.
//
// Contract: docs/policy/email-consent-copy-draft.md, approved 2026-09-23.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { gfm } from "micromark-extension-gfm";

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
import {
  MAKES_NO_SEND_PROMISE_VERSIONS,
  PROMISE_NO_UNREQUESTED_SEND_VERSIONS,
  consentCopyPromisesNoUnrequestedSend,
} from "../lib/emailConsentCopy.ts";
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
  // It is not corrected here, and that restraint is the point. Section 10 says
  // approved wording is versioned rather than edited, and this string is
  // approved. Nothing has rendered it yet, so no evidence points at it, which
  // makes the correction cheap -- but cheap is not the same as ours to make.
  //
  // This test exists so the defect cannot be forgotten between now and that
  // decision, and so it fails the day somebody silently fixes it without
  // adding a version.
  // The first clause only. The second one ("a menos que você peça") does name
  // the reader, which is what makes this read as a slip rather than a choice.
  // Bound to the version whose wording it is. A later version correcting it is
  // the outcome this test is waiting for, and it must not fail that version.
  const firstClause = consentCopy("noticeBody", "pt", "2026-09-23").split(" e não enviará")[0];
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

/* -------------------------------------------------------------------------- */
/* The approved document, read the way it renders                              */
/* -------------------------------------------------------------------------- */

/**
 * The document as a GFM syntax tree.
 *
 * Three versions of this read raw lines and looked for `|` at the start, and a
 * review broke each of them by writing something that renders differently from
 * the way those lines were being read: a comment opened and closed mid-line, a
 * four-space-indented `<!--`, an invalid info string containing a backtick, a
 * heading indented three spaces, a table row whose trailing pipe was dropped so
 * its cell count changed. Every one of them let the approved record and the
 * code drift apart while the suite stayed green.
 *
 * A hand-written parser was the wrong tool. This is `remark-gfm`'s whole
 * extension set over `mdast-util-from-markdown` -- the same GFM the product
 * renders markdown with, minus the two CJK plugins, which amend emphasis and
 * strikethrough and change nothing this document's headings or tables depend
 * on. So what the test reads is what a reader sees, including CRLF, which the
 * parser handles and `split("\n")` did not.
 *
 * The source is returned beside the tree because the record digest hashes bytes
 * and the tree is what says which bytes: a node's `position.offset` is the
 * parser's own idea of where a section starts and ends, so the ranges cannot
 * drift from what was parsed.
 */
const approvedSource = () => readFileSync(APPROVED_DOCUMENT, "utf8").replace(/\r\n/g, "\n");

const approvedTree = () =>
  fromMarkdown(approvedSource(), {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });

/** A node's text, as the reader sees it, with emphasis markers dropped. */
const textOf = (node) => {
  if (node.type === "text" || node.type === "inlineCode") return node.value;
  if (node.type === "break") return " ";
  if (!Array.isArray(node.children)) return "";
  return node.children.map(textOf).join("");
};

const cellsOf = (row) => row.children.map((cell) => textOf(cell).trim());

/**
 * The nodes of one section: from the heading whose text starts with `prefix` to
 * the next heading of the same or higher depth.
 *
 * The heading must be unique. Taking the first match let a second `### 3.D …`
 * above the real one shadow it, and the approved cells below could then be
 * edited freely.
 */
const sectionOf = (tree, number, depth) => {
  const at = [];
  tree.children.forEach((node, index) => {
    // The heading's first token, compared exactly. `startsWith("1.")` also
    // matched `1.5`, so a section inserted with a nearby number could be taken
    // for the one being located.
    if (
      node.type === "heading" &&
      node.depth === depth &&
      textOf(node).trim().split(/\s+/)[0] === number
    ) {
      at.push(index);
    }
  });
  assert.equal(
    at.length,
    1,
    `the approved document must hold exactly one depth-${depth} ${number} heading`
  );
  const from = at[0];
  const sectionDepth = tree.children[from].depth;
  let to = tree.children.length;
  for (let i = from + 1; i < tree.children.length; i += 1) {
    const node = tree.children[i];
    if (node.type === "heading" && node.depth <= sectionDepth) {
      to = i;
      break;
    }
  }
  return tree.children.slice(from, to);
};

/** Every heading number in a section's nodes, at one depth. */
const headingsOf = (nodes, depth) =>
  nodes
    .filter((node) => node.type === "heading" && node.depth === depth)
    .map((node) => textOf(node).trim().split(/\s+/)[0]);

/**
 * Every table in a section, with the last paragraph before it as its label.
 *
 * A heading is not a label: treating it as one made each subsection's single
 * table compare as `null` by accident, which hid a `**제목**` repeated above
 * another subsection's table.
 */
const tablesOf = (nodes) => {
  const tables = [];
  let label = null;
  for (const node of nodes) {
    if (node.type === "table") {
      tables.push({ label, rows: node.children.map(cellsOf) });
      continue;
    }
    label = node.type === "paragraph" ? textOf(node).trim() : null;
  }
  return tables;
};

/**
 * The one cell a key's approved string must equal, in one version's own part of
 * the document. Fails unless that cell is unique.
 *
 * The location comes from the version (`deviceCells`), not a constant: a new
 * version's wording is approved in a new section, so a map fixed at 3.A–3.D
 * meant the second version could not be checked against its own record at all.
 */
const approvedCell = (tree, version, key, language) => {
  const { section, label, role } = version.deviceCells[key];
  const tables = tablesOf(sectionOf(tree, section, 3)).filter(
    (table) => label === null || table.label === label
  );
  assert.equal(tables.length, 1, `${key}: expected exactly one table under ${section} ${label ?? ""}`);
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

const APPROVED_DOCUMENT = "docs/policy/email-consent-copy-draft.md";

/**
 * The whole of what the owner approved, as one digest per version.
 *
 * The per-string pins and the version digest cover section 3's fifty-six
 * strings, which is what the code renders. They cover nothing else, and a
 * review showed what that left open: section 4's notice wording could be
 * replaced, section 5's and section 6's clauses rewritten, and the status line
 * at the top changed from 승인됨 to 반려됨, with all twenty-three tests still
 * green. The approval says sections 1 to 6, so all six are frozen here.
 *
 * The **whole document**, because selecting ranges leaves gaps and the gaps are
 * where a review kept getting through.
 *
 * The first version hashed a flattening of the tree, and seven reader-visible
 * edits survived it. The second hashed the source of chosen ranges, and a whole
 * new section could be written into the space between two of them: an inserted
 * `## 승인 철회` ends the preceding range early, so its entire body sits outside
 * every range. Both attempts were arguments about which bytes matter, and this
 * document does not have any that do not -- section 9 holds the owner's decision
 * B and the rule against fabricating consent, section 10 is the edit procedure
 * this very digest enforces, and the tests and four modules cite both.
 *
 * So: every byte, CRLF normalised to LF because a checkout style is not a change
 * to the record (and .gitattributes pins the file to LF anyway). Any edit at all
 * moves it, including an editorial one, which is what section 10 already says
 * about this document.
 *
 * Recorded, not computed: a digest this test derives from whatever it is handed
 * proves only that sha256 is deterministic. Moving it means editing a line that
 * says, in this file, that the owner's record has changed — which is the edit
 * section 10 forbids, and the one a reviewer sees for what it is.
 *
 * Each version **also** pins its own record section
 * (`CONSENT_COPY_VERSIONS[].recordDigest`), because this one has to move when a
 * version is added and that move would otherwise cover for an edit to an
 * earlier version's approval table in the same commit.
 */
const APPROVED_DOCUMENT_DIGEST = "ceab5b00849e7254fa8b80018d7581b9";

/** The source bytes of a section, from the parser's own offsets. */
const sourceOf = (source, nodes) => {
  const from = nodes[0].position.start.offset;
  const to = nodes[nodes.length - 1].position.end.offset;
  return source.slice(from, to);
};

test("the approved document is the one the owner signed, every byte of it", () => {
  const digest = createHash("sha256").update(approvedSource()).digest("hex").slice(0, 32);
  assert.equal(
    digest,
    APPROVED_DOCUMENT_DIGEST,
    "The approved document changed. Section 10 says a change to approved wording " +
      "is a new version in a new section rather than an edit, and everything else " +
      "here -- the decisions in section 9, the procedure in section 10 -- is cited " +
      `by code. If this change is meant, record "${digest}".`
  );
});

test("each version's own record is pinned to that version", () => {
  // The document digest moves whenever a version is added, legitimately. These
  // do not: an edit to an earlier version's approval table or digest fails
  // against the version it belongs to, rather than against a number that was
  // going to change in that commit anyway.
  const source = approvedSource();
  const tree = approvedTree();
  for (const version of CONSENT_COPY_VERSIONS) {
    const digest = createHash("sha256")
      .update(sourceOf(source, sectionOf(tree, version.recordSection, 2)))
      .digest("hex")
      .slice(0, 32);
    assert.equal(
      digest,
      version.recordDigest,
      `section ${version.recordSection} is no longer the record approved for ` +
        `${version.version}. If this change is meant, record "${digest}".`
    );
  }
});

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
  const tree = approvedTree();
  for (const version of CONSENT_COPY_VERSIONS) {
    for (const key of CONSENT_COPY_KEYS) {
      assert.ok(version.deviceCells[key], `${version.version}.${key} has no approved cell`);
      for (const language of CONSENT_COPY_LANGUAGES) {
        assert.equal(
          consentCopy(key, language, version.version),
          approvedCell(tree, version, key, language),
          `${version.version}.${key}.${language} differs from its approved cell`
        );
      }
    }
  }
});

test("each version's device sections hold exactly its devices, tables and roles", () => {
  // Reverse completeness. Every test above walks the eight keys the code
  // declares and finds each one's cell, which says nothing about what else the
  // document claims was approved: a `### 3.E` device, a fourth button role, or
  // an extra language column with an approved-looking sentence in it would all
  // pass while the code knew nothing about them. The owner signed section 3 as
  // a whole, so the whole of it is compared.
  const tree = approvedTree();
  for (const version of CONSENT_COPY_VERSIONS) {
    // The device subsections this version names, and the summary that sits
    // above them. Derived from the version rather than written here, so a second
    // version is checked against its own section rather than against 3.A-3.D.
    const sections = [...new Set(Object.values(version.deviceCells).map((cell) => cell.section))];
    const parent = sections[0].split(".")[0] + ".";
    assert.ok(
      sections.every((name) => name.startsWith(parent)),
      `${version.version}'s devices are spread across more than one section`
    );
    assert.deepEqual(
      headingsOf(sectionOf(tree, parent, 2), 3),
      [parent + "0", ...sections.sort()],
      `section ${parent} does not hold exactly ${version.version}'s devices`
    );
  }

  // The rest is this version's shape, which is the only one written down.
  const version = CONSENT_COPY_VERSIONS[CONSENT_COPY_VERSIONS.length - 1];
  assert.equal(version.version, "2026-09-23", "a new version needs its own expected shape here");
  const section = sectionOf(tree, "3.", 2);

  assert.deepEqual(headingsOf(section, 3), ["3.0", "3.A", "3.B", "3.C", "3.D"]);

  // 3.0 is the summary of what the four devices are; the four that follow carry
  // the approved strings, and their tables are exactly the ones the keys name.
  // The labels are compared as they are, not nulled outside 3.D: a repeated
  // `**제목**` above another subsection's table would otherwise pass.
  const expectedTables = {
    "3.0": [null],
    "3.A": [null],
    "3.B": [null],
    "3.C": [null],
    "3.D": ["제목", "본문", "세 버튼"],
  };
  for (const [heading, labels] of Object.entries(expectedTables)) {
    const tables = tablesOf(sectionOf(tree, heading, 3));
    assert.deepEqual(
      tables.map((table) => table.label),
      labels,
      `${heading} does not hold exactly the approved tables`
    );
  }

  // 3.0's table says there are four devices and what each records. A fifth row
  // there is a fifth approved device, and the eight keys would not notice.
  // Whole rows, not just their first column: "A" saying something else about
  // where the checkbox lives or what it records is a different approved device
  // under the same letter, and comparing the letters alone let that through.
  assert.deepEqual(tablesOf(sectionOf(tree, "3.0", 3))[0].rows, [
    ["#", "장치", "어디에", "무엇을 기록하는가"],
    ["A", "opt-in 체크박스 (미체크 상태)", "가입 흐름", "동의 → DOI"],
    ["B", "고지 문장", "가입 흐름, A 옆", "notice_shown"],
    ["C", "독립 거부 수단", "가입 흐름, A와 별개", "objected"],
    ["D", "제품 내 일회성 안내", "기존 계정의 다음 접속", "A·B·C와 같은 세 상태"],
  ]);

  // The language tables: one row per language and no more, so an eighth row
  // cannot claim an eighth approved language.
  for (const heading of ["3.A", "3.B", "3.C"]) {
    const [header, ...rows] = tablesOf(sectionOf(tree, heading, 3))[0].rows;
    assert.deepEqual(header, ["언어", "문안"]);
    assert.deepEqual(rows.map((row) => row[0]), [...CONSENT_COPY_LANGUAGES]);
  }
  for (const label of ["제목", "본문"]) {
    const [header, ...rows] = tablesOf(sectionOf(tree, "3.D", 3)).find(
      (table) => table.label === label
    ).rows;
    assert.deepEqual(header, ["언어", "문안"]);
    assert.deepEqual(rows.map((row) => row[0]), [...CONSENT_COPY_LANGUAGES]);
  }

  // The button table: the whole header, in order, and exactly three roles. An
  // extra column was how an approved sentence could be added beside the cell
  // the code reads.
  const buttons = tablesOf(sectionOf(tree, "3.D", 3)).find(
    (table) => table.label === "세 버튼"
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
  // Every version, each against its own record section and its own approved
  // sections. Reading only the last version's table, with the rows written out
  // here, meant a second version could not pass at all: its approver and date
  // differ, and fixing that for it would have stopped checking the first
  // version's table.
  const tree = approvedTree();
  for (const version of CONSENT_COPY_VERSIONS) {
    const where = `section ${version.recordSection}`;
    const approvals = tablesOf(sectionOf(tree, version.recordSection, 2)).filter(
      (table) => table.rows[0]?.[0] === "절" && table.rows[0]?.[2] === "승인"
    );
    // Exactly one. `find()` took the first, so a second table with the same
    // header and every cell reading "rejected" sat below it and passed.
    assert.equal(approvals.length, 1, `${where} must hold exactly one approval table`);

    // The whole table, not only its first and third columns: what each row says
    // was approved is part of the record, and comparing the numbers alone let
    // the description beside them be rewritten. The expected rows come from the
    // version's own metadata, so a new version brings its own.
    assert.deepEqual(approvals[0].rows, [
      ["절", "내용", "승인"],
      ...version.approvedSections.map(([section, what]) => [
        section,
        what,
        `${version.approvedBy}, ${version.approvedAt}`,
      ]),
    ], `${where}'s approval table is not this version's record`);
  }
});

test("the approval section records the digest of each version, once, on that version's line", () => {
  // Per-string pins stop an approved byte moving on its own, but a commit that
  // changes a string *and* its pin passes them. The whole-version digest is
  // also written into the owner's signed record, so changing an approved byte
  // means editing that record -- which section 10 forbids and which a reviewer
  // sees for what it is.
  //
  // Each version's own record section, named in code, holds exactly one
  // paragraph that is nothing but a sha256 digest, and the paragraph before it
  // names that version. Section 10 says a new version is added as a new section
  // rather than by editing an approved one, so the section is part of the
  // version's identity and not something this test assumes.
  for (const { version, recordSection } of CONSENT_COPY_VERSIONS) {
    const nodes = sectionOf(approvedTree(), recordSection, 2);
    const paragraphs = nodes
      .filter((node) => node.type === "paragraph")
      .map((node) => textOf(node).trim());
    const digests = paragraphs.filter((text) => /^sha256:[0-9a-f]+$/.test(text));
    assert.deepEqual(
      digests,
      [consentCopyVersionDigest(version)],
      `section ${recordSection} must hold exactly one digest, this version's`
    );
    const at = paragraphs.indexOf(digests[0]);
    assert.ok(at > 0, `the digest in ${recordSection} has nothing above it naming a version`);
    assert.match(
      paragraphs[at - 1],
      new RegExp(`버전 ${version.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`),
      `the digest in ${recordSection} does not follow the line naming ${version}`
    );
  }
});

test("every version says whether it promises not to send unasked", () => {
  // Whether a version makes that promise decides whether the risk_accepted
  // override may mail somebody who was shown it (section 9.1). A new version
  // inheriting a silent default would decide that by accident, so each one has
  // to be in exactly one of the two sets.
  for (const { version } of CONSENT_COPY_VERSIONS) {
    const promises = PROMISE_NO_UNREQUESTED_SEND_VERSIONS.has(version);
    const does_not = MAKES_NO_SEND_PROMISE_VERSIONS.has(version);
    assert.notEqual(
      promises,
      does_not,
      `${version} is in neither promise set, or in both`
    );
    assert.equal(consentCopyPromisesNoUnrequestedSend(version), promises);
  }
  // And neither set names a version that does not exist.
  const known = new Set(CONSENT_COPY_VERSIONS.map((entry) => entry.version));
  for (const version of [
    ...PROMISE_NO_UNREQUESTED_SEND_VERSIONS,
    ...MAKES_NO_SEND_PROMISE_VERSIONS,
  ]) {
    assert.ok(known.has(version), `${version} is classified but is not a version`);
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
