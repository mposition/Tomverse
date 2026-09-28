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
  APPROVED_DOCUMENT_DIGEST,
  UNVERSIONED_SECTIONS,
  UNVERSIONED_SECTIONS_DIGEST,
} from "../lib/emailConsentCopyDocumentPins.ts";
// The depth-2 partition, imported rather than kept twice. A review found the
// two implementations disagreeing about a heading inside a fenced code block --
// a section to one, a line of code to the other -- and two partitions that
// disagree are two documents being checked.
import { sectionsOf } from "../scripts/check-consent-copy-immutability-core.mjs";
import {
  MAKES_NO_SEND_PROMISE_VERSIONS,
  PROMISE_NO_UNREQUESTED_SEND_VERSIONS,
  consentCopyPromiseState,
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
  assert.equal(consentCopyPromiseState("2026-09-23"), "promises_no_unrequested_send");

  // A version this deployment has never seen is held back, not let through. A
  // review found the boolean answering "unknown" and "deliberately makes no
  // promise" with the same false, and section 9.1 reads that false as "the
  // override may mail this person". The unknown string is not hypothetical: a
  // copyHash written by an older deployment, or by a branch carrying a version
  // this one does not have, resolves to exactly that.
  assert.equal(consentCopyPromiseState("not-a-version"), "unknown_version");
  assert.equal(consentCopyPromisesNoUnrequestedSend("not-a-version"), true);
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
 * An integrity pin over the **whole document**, because selecting ranges leaves
 * gaps and the gaps are where a review kept getting through.
 *
 * Not a claim that the owner approved every byte: the approval covers sections 1
 * to 6 and says so, section 7 puts itself out of scope, and section 9 is what
 * was found afterwards. This says the document has not changed since the commit
 * that recorded this value -- which is what makes an edit to any of it visible
 * in review, whatever its status.
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


/**
 * The source bytes of a section: from its heading to the next section's heading,
 * or to the end of the document.
 *
 * Not "to the end of the last node in it", which is what the first version did.
 * A review counted what that left out: the blank line between two sections and
 * the newline at the end of the file belonged to no part of any digest, twenty-one
 * bytes in the current document -- and, worse, a depth-1 heading with a body
 * inserted between two sections sat in the same gap, so its whole text was
 * covered by nothing but the document digest that a new version moves anyway.
 *
 * Taking the range to the next heading's start means every byte after the first
 * heading belongs to exactly one section, whatever is in it.
 */
const sourceOf = (source, nodes, endOffset) => {
  const from = nodes[0].position.start.offset;
  return source.slice(from, endOffset ?? nodes[nodes.length - 1].position.end.offset);
};

/**
 * One depth-2 section, as the bytes between its heading and the next one's.
 *
 * Both this and the immutability check read `sectionsOf()`, which is the point:
 * the pins below and the base comparison have to be about the same sections.
 */
const documentSections = (source) => sectionsOf(source, "the approved document");

const sectionSource = (source, tree, number) => {
  void tree;
  const section = documentSections(source).get(number);
  assert.ok(section !== undefined, `the approved document has no depth-2 ${number} section`);
  return section;
};

/** Every depth-2 section number, in the order the document holds them. */
const sectionNumbers = (tree, source = approvedSource()) => {
  void tree;
  return [...documentSections(source).keys()].filter((number) => number !== "");
};

/**
 * The sections one version's approval covers, in document order.
 *
 * Derived from the approval table rather than written beside the digest over
 * them. The first version carried the list in the same file as the digest, and
 * a review named what that allowed: drop `"4."` from the list, drop section 4's
 * row from the table, recompute both digests, and section 4's approved wording
 * is editable behind a repin that adding a version would have justified. The
 * list is the table's own content now, and the table is inside the record
 * section whose digest is pinned, so narrowing the scope means moving a value
 * the owner signed.
 */
const approvedSectionNumbersOf = (tree, version) => {
  const order = sectionNumbers(tree);
  const seen = new Set();
  for (const [section] of version.approvedSections) {
    // A section number, not a prefix: `§3A` and `§3 anything` are not
    // references to section 3, and a longer number is a different section.
    const named = /^§([0-9]+)(\.|$)/.exec(section);
    assert.ok(named, `${version.version}: "${section}" is not a section reference`);
    const number = named[1] + ".";
    // Locating it asserts the heading is unique, which is what makes the
    // digest's input a section rather than the first of several.
    sectionOf(tree, number, 2);
    seen.add(number);
  }
  assert.ok(seen.size > 0, `${version.version} approves no section`);
  assert.ok(
    !seen.has(version.recordSection),
    `${version.version}'s approval table names its own record section ` +
      `${version.recordSection}, which the digest already reads separately`
  );
  // Document order, so the order the table happens to be written in cannot
  // change the digest.
  return order.filter((number) => seen.has(number));
};

/**
 * The bytes a digest is taken over, as one unambiguous string.
 *
 * Each part carries its own length, rather than being joined by a separator.
 * The first version joined the sections with a NUL, which is a boundary only
 * while no part contains one -- nothing checked that, and two different lists
 * can be the same bytes either way. The part's name is in the input too, so the
 * same bytes under a different heading is a different digest.
 */
const canonicalParts = (parts) =>
  parts.map(([name, body]) => `${name.length}:${name}${body.length}:${body}`).join("");

const digestOf = (input) =>
  createHash("sha256").update(input).digest("hex").slice(0, 32);

test("the sections no version owns have not changed either", () => {
  const source = approvedSource();
  const tree = approvedTree();
  const owned = new Set(
    CONSENT_COPY_VERSIONS.flatMap((version) => [
      ...approvedSectionNumbersOf(tree, version),
      version.recordSection,
    ])
  );
  assert.deepEqual(
    sectionNumbers(tree).filter((number) => !owned.has(number)),
    UNVERSIONED_SECTIONS,
    "a depth-2 section belongs to no version and is not in UNVERSIONED_SECTIONS. " +
      "Section 10.1 says a new version's sections are the new version's; anything " +
      "else is an unversioned part of the document, and is pinned here."
  );

  // The bytes before the first depth-2 heading are the title and the status
  // block, which is where a review found that 승인됨 could be changed to 반려됨.
  const firstHeading = tree.children.find(
    (node) => node.type === "heading" && node.depth === 2
  );
  const digest = digestOf(
    canonicalParts([
      ["status block", source.slice(0, firstHeading.position.start.offset)],
      ...UNVERSIONED_SECTIONS.map((number) => [number, sectionSource(source, tree, number)]),
    ])
  );
  assert.equal(
    digest,
    UNVERSIONED_SECTIONS_DIGEST,
    "the part of the approved document that no version owns has changed. Adding " +
      "a version does not do this. If this change is meant, record " +
      `"${digest}".`
  );
});

test("every byte of the approved document belongs to exactly one pin", () => {
  // The thing three earlier attempts got wrong. Each was an argument about which
  // bytes matter, and each left a gap: a flattening of the tree, then chosen
  // ranges with the space between them, then ranges that stopped at the last node
  // of a section. A review found twenty-one bytes in the current document that no
  // part digest covered, and a depth-1 heading with a body that could be inserted
  // into the same space.
  //
  // So rather than arguing, this reassembles the document from the parts the pins
  // are taken over and compares it with the file. There is no third thing to
  // reason about: either every byte is in exactly one part or this fails.
  const source = approvedSource();
  const tree = approvedTree();
  const firstHeading = tree.children.find(
    (node) => node.type === "heading" && node.depth === 2
  );
  const owned = new Set(
    CONSENT_COPY_VERSIONS.flatMap((version) => [
      ...approvedSectionNumbersOf(tree, version),
      version.recordSection,
    ])
  );
  const numbers = sectionNumbers(tree);
  assert.deepEqual(
    numbers.filter((number) => !owned.has(number)),
    UNVERSIONED_SECTIONS,
    "a depth-2 section belongs to no version and is not in UNVERSIONED_SECTIONS"
  );

  const parts = [
    source.slice(0, firstHeading.position.start.offset),
    ...numbers.map((number) => sectionSource(source, tree, number)),
  ];
  assert.equal(parts.join(""), source, "the parts the pins cover are not the document");
});

test("the approved document has not changed since this digest was recorded", () => {
  const digest = createHash("sha256").update(approvedSource()).digest("hex").slice(0, 32);
  assert.equal(
    digest,
    APPROVED_DOCUMENT_DIGEST,
    "The approved document changed. Sections 1 to 6 are approved wording, and " +
      "section 10 says a change to those is a new version in a new section rather " +
      "than an edit; the rest -- the decisions in section 9, the procedure in " +
      "section 10 -- is cited by code and by these tests. Section 10.1 lists what " +
      `a new version actually requires. If this change is meant, record "${digest}".`
  );
});

test("each version pins its own record and the body it approved", () => {
  // The document digest moves whenever a version is added, legitimately, and a
  // review showed what that covers for: the same commit could edit section 4's
  // approved wording and record one new document digest, with the only
  // per-version pin being over the approval table.
  //
  // So each version pins two things, and adding a version touches neither: the
  // approval record it signed, and the body that record approved. An edit to
  // either fails against the version it belongs to rather than against a number
  // that was going to change anyway.
  const source = approvedSource();
  const tree = approvedTree();
  for (const version of CONSENT_COPY_VERSIONS) {
    const record = digestOf(sectionSource(source, tree, version.recordSection));
    assert.equal(
      record,
      version.recordDigest,
      `section ${version.recordSection} is no longer the record approved for ` +
        `${version.version}. If this change is meant, record "${record}".`
    );

    const numbers = approvedSectionNumbersOf(tree, version);
    const body = digestOf(
      canonicalParts(
        [...numbers, version.recordSection].map((number) => [
          number,
          sectionSource(source, tree, number),
        ])
      )
    );
    assert.equal(
      body,
      version.approvedBodyDigest,
      `the body approved for ${version.version} (sections ` +
        `${numbers.join(", ")} and ${version.recordSection}) ` +
        `has changed. Section 10 says that is a new version, not an edit. If this ` +
        `change is meant, record "${body}".`
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
  // Reverse completeness, per version. Every test above walks the eight keys the
  // code declares and finds each one's cell, which says nothing about what else
  // the document claims was approved: a fifth device, a fourth button role, an
  // eighth language row, or an extra table with an approved-looking sentence in
  // it would all pass while the code knew nothing about them.
  //
  // Derived from the version rather than written out, because a version's
  // wording is approved in a new section and a check hardcoded at 3.A-3.D would
  // have left a second version's structure unexamined. Only the summary table's
  // words are in the metadata; the shape comes from `deviceCells` and the key
  // and language lists.
  const tree = approvedTree();
  for (const version of CONSENT_COPY_VERSIONS) {
    const cells = CONSENT_COPY_KEYS.map((key) => ({ key, ...version.deviceCells[key] }));
    const sections = [...new Set(cells.map((cell) => cell.section))];
    const parent = version.deviceSummary.section.split(".")[0] + ".";
    assert.ok(
      sections.every((name) => name.startsWith(parent)),
      `${version.version}'s devices are not all under ${parent}`
    );

    // The section holds the summary and this version's device subsections, and
    // nothing else claiming to be one.
    assert.deepEqual(
      headingsOf(sectionOf(tree, parent, 2), 3),
      [version.deviceSummary.section, ...[...sections].sort()],
      `section ${parent} does not hold exactly ${version.version}'s devices`
    );

    // The summary says how many devices there are and what each records, and
    // it is the only table there: comparing the first one let a second table
    // holding a fifth device sit below it, which is exactly what this is for.
    const summary = tablesOf(sectionOf(tree, version.deviceSummary.section, 3));
    assert.deepEqual(
      summary.map((table) => table.label),
      [version.deviceSummary.label],
      `${version.deviceSummary.section} does not hold exactly one summary table`
    );
    assert.deepEqual(
      summary[0].rows,
      version.deviceSummary.rows.map((row) => [...row]),
      `${version.deviceSummary.section} is not ${version.version}'s device summary`
    );

    for (const section of sections) {
      const here = cells.filter((cell) => cell.section === section);
      // The labels this section's keys name, in key order, without repeats. A
      // label the keys do not name is a table nobody approved.
      const labels = [...new Set(here.map((cell) => cell.label))];
      const tables = tablesOf(sectionOf(tree, section, 3));
      assert.deepEqual(
        tables.map((table) => table.label),
        labels,
        `${section} does not hold exactly the approved tables`
      );

      for (const label of labels) {
        const table = tables.find((entry) => entry.label === label);
        const [header, ...rows] = table.rows;
        const keys = here.filter((cell) => cell.label === label);
        const roles = keys.map((cell) => cell.role);

        if (roles.every((role) => role === null)) {
          // One language per row and no more, so an eighth row cannot claim an
          // eighth approved language.
          assert.deepEqual(header, ["언어", "문안"], `${section} ${label ?? ""} header`);
          assert.deepEqual(
            rows.map((row) => row[0]),
            [...CONSENT_COPY_LANGUAGES],
            `${section} ${label ?? ""} languages`
          );
          for (const row of rows) assert.equal(row.length, 2);
          continue;
        }

        // The transposed table: its whole header in order, exactly the roles the
        // keys name, and no extra column -- which was how an approved sentence
        // could sit beside the cell the code reads.
        assert.deepEqual(header, ["역할", ...CONSENT_COPY_LANGUAGES], `${section} ${label} header`);
        assert.deepEqual(rows.map((row) => row[0]), roles, `${section} ${label} roles`);
        for (const row of table.rows) {
          assert.equal(row.length, 1 + CONSENT_COPY_LANGUAGES.length);
        }
      }
    }
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

    // And it approves the section the wording is actually in. Without this, a
    // version could keep its devices in section 11 while its approval table
    // named other sections entirely -- the two agreeing with each other and
    // neither agreeing with the copy.
    // Compared as a section number, not as a prefix: `§3A` and `§3 anything`
    // are not references to section 3, and a two-digit number starting with 3
    // is a different section entirely. The entry is either the number itself or
    // the number followed by a dot.
    const parent = version.deviceSummary.section.split(".")[0];
    assert.ok(
      version.approvedSections.some(([section]) => {
        const named = /^§([0-9]+)(\.|$)/.exec(section);
        return named !== null && named[1] === parent;
      }),
      `${where}'s approval table does not approve section ${parent}, where ` +
        `${version.version}'s wording is`
    );

    // Every entry names a section of this document, and not one this version
    // uses for something else. The list the body digest covers is that set, so
    // there is nothing here for the two to drift apart over.
    //
    // What this does **not** check is the description beside each number: it is
    // compared against the code's copy of it above, not derived from anything,
    // so the guarantee here is the section link.
    assert.ok(approvedSectionNumbersOf(approvedTree(), version).length > 0);
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
    const at = nodes
      .map((node, index) => ({ node, index }))
      .filter(
        ({ node }) =>
          node.type === "paragraph" && /^sha256:[0-9a-f]+$/.test(textOf(node).trim())
      );
    assert.deepEqual(
      at.map(({ node }) => textOf(node).trim()),
      [consentCopyVersionDigest(version)],
      `section ${recordSection} must hold exactly one digest, this version's`
    );

    // The node immediately before it, not merely the paragraph before it.
    // Filtering to paragraphs first let a table, a list or a quote sit between
    // the version's line and its digest, which section 10.1 says it may not and
    // which a reader would see as two separate claims.
    const before = nodes[at[0].index - 1];
    assert.ok(
      before?.type === "paragraph",
      `the digest in ${recordSection} does not directly follow a paragraph`
    );
    // The version is written in inline code there, so this compares that
    // node's value and needs no notion of where a token ends. Two earlier
    // attempts argued about the boundary instead: a substring match let
    // `2026-09-2` answer for `2026-09-23`, and a character class let a
    // combining mark after the id pass for it. Section 10.1 states the rule the
    // document has to follow for this to be checkable.
    assert.ok(
      textOf(before).includes("버전"),
      `the paragraph above the digest in ${recordSection} does not name a version`
    );
    assert.deepEqual(
      (before.children ?? [])
        .filter((node) => node.type === "inlineCode")
        .map((node) => node.value),
      [version],
      `the paragraph above the digest in ${recordSection} must hold exactly one ` +
        `inline code, whose value is ${version}`
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
