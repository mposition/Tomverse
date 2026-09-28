// What the base comparison catches, and what it deliberately does not.
//
// Contract: docs/policy/email-consent-copy-draft.md sections 10, 10.1.
//
// The in-tree digests make an edit to the approved document visible; they cannot
// make it impossible, because the same commit holds both the document and the
// pins. This is the check that reads the base revision instead.
//
// Three rounds of review shaped it, and the third changed what it compares. The
// first two versions compared metadata -- digests, record fields, a list of
// which sections a version approved -- and each time a round found the same
// shape of hole underneath: a commit could change the words and move every
// number that described them. So it compares the words. There is no exemption
// list left to test, because there is nothing left for one to excuse.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AMENDABLE_SECTIONS,
  APPROVED_DOCUMENT,
  CONSENT_COPY_SOURCE,
  RECORD_FIELDS,
  Unreadable,
  immutabilityProblems,
  recordsOf,
  sectionsOf,
} from "../scripts/check-consent-copy-immutability-core.mjs";

const COPY = `
const V2026_09_23 = Object.freeze({
  signupOptIn: Object.freeze({ ko: "수신동의 (선택)", en: "Send me product news" }),
  signupNotice: Object.freeze({ ko: "켜시면 보냅니다", en: "If you turn this on" }),
});
`;

/** A minimal file of the shape the real one has, so a case can change one thing. */
const sourceWith = (...entries) => `${COPY}
export const CONSENT_COPY_VERSIONS: ReadonlyArray<Entry> = Object.freeze([
${entries.join("\n")}
]);
`;

const entry = (overrides = {}) => {
  const fields = {
    version: "2026-09-23",
    approvedBy: "mposition",
    approvedAt: "2026-09-23",
    recordSection: "8.",
    sections: `[
      ["§1", "R5 — 철회 시까지"],
      ["§4.1–4.3", "통지 3건의 문안"],
    ] as const`,
    copy: "V2026_09_23",
    comment: "// Recorded, not computed.",
    extra: "",
    ...overrides,
  };
  return `  Object.freeze({
    ${fields.comment}
    version: "${fields.version}",
    approvedBy: "${fields.approvedBy}",
    approvedAt: "${fields.approvedAt}",
    recordSection: "${fields.recordSection}",
    approvedSections: ${fields.sections},
    deviceCells: { signupOptIn: { section: "3.A", label: null, role: null } },
    deviceSummary: { section: "3.0", label: null, rows: [["#", "장치"]] },
    copy: ${fields.copy},${fields.extra}
  }),`;
};

const problemsFor = (before, now) =>
  immutabilityProblems({
    before: recordsOf(before, "base"),
    now: recordsOf(now, "head"),
    base: "origin/develop",
  });

const unreadable = (source, pattern) => {
  assert.throws(
    () => recordsOf(source, "head"),
    (error) => {
      assert.ok(error instanceof Unreadable, `expected Unreadable, got ${error}`);
      assert.match(error.message, pattern);
      return true;
    }
  );
};

test("the real files parse, and the wording comes back as words", () => {
  const records = recordsOf(readFileSync(CONSENT_COPY_SOURCE, "utf8"), CONSENT_COPY_SOURCE);
  assert.ok(records.length >= 1);
  for (const record of records) {
    for (const field of RECORD_FIELDS) {
      assert.ok(record[field] !== undefined, `${field} came back empty`);
    }
    // The point of the whole check: `copy` is the strings, not the name of the
    // constant that holds them.
    assert.equal(typeof record.copy, "object");
    assert.ok(Object.keys(record.copy).length >= 8, "fewer keys than the approved devices");
    for (const table of Object.values(record.copy)) {
      for (const text of Object.values(table)) {
        assert.equal(typeof text, "string");
        assert.ok(text.length > 0);
      }
    }
  }

  const sections = sectionsOf(readFileSync(APPROVED_DOCUMENT, "utf8"), APPROVED_DOCUMENT);
  assert.ok(sections.has(""), "the status block is not a part");
  for (const number of AMENDABLE_SECTIONS) {
    assert.ok(sections.has(number), `${number} is not in the approved document`);
  }
});

test("the document partition covers every byte exactly once", () => {
  // The same claim the unit suite makes about its own pins, made here because
  // this is the partition the base comparison uses and two partitions that
  // disagree would compare different things.
  const source = readFileSync(APPROVED_DOCUMENT, "utf8").replace(/\r\n/g, "\n");
  const parts = [...sectionsOf(source, "test").values()];
  assert.equal(parts.join(""), source);
});

test("an unchanged version is a pass, comments and formatting included", () => {
  const { problems, added } = problemsFor(
    sourceWith(entry()),
    sourceWith(entry({ comment: "// Rewritten comment, three words longer than it was." }))
  );
  assert.deepEqual(problems, []);
  assert.deepEqual(added, []);
});

test("appending a version is a pass, and the addition is named", () => {
  const before = sourceWith(entry());
  const now = sourceWith(entry(), entry({ version: "2026-12-01", recordSection: "11." }));
  const { problems, added } = problemsFor(before, now);
  assert.deepEqual(problems, []);
  assert.deepEqual(added, ["2026-12-01"]);
});

test("a changed approved string is caught, and named", () => {
  // The hole the last round found: every earlier version compared a digest of
  // these strings and a commit could move the digest. This compares the strings.
  const changed = COPY.replace("Send me product news", "Send me product news and offers");
  const now = `${changed}
export const CONSENT_COPY_VERSIONS: ReadonlyArray<Entry> = Object.freeze([
${entry()}
]);
`;
  const { problems } = problemsFor(sourceWith(entry()), now);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /approved wording changed: signupOptIn\.en/);
});

test("every other field of the record is compared too", () => {
  const changes = {
    version: { version: "2026-09-24" },
    approvedBy: { approvedBy: "somebody-else" },
    approvedAt: { approvedAt: "2026-09-24" },
    recordSection: { recordSection: "11." },
    approvedSections: { sections: `[["§1", "R5 — 철회 시까지"]] as const` },
  };
  for (const [field, overrides] of Object.entries(changes)) {
    const { problems } = problemsFor(sourceWith(entry()), sourceWith(entry(overrides)));
    assert.equal(problems.length, 1, `${field} was not reported`);
    assert.match(
      problems[0],
      field === "version" ? /entry 1 is 2026-09-24/ : new RegExp(field),
      `${field}: ${problems[0]}`
    );
  }
});

test("a different copy table with identical strings is still a different table", () => {
  const now = `${COPY}
const V2026_09_23_COPY = V2026_09_23;
export const CONSENT_COPY_VERSIONS: ReadonlyArray<Entry> = Object.freeze([
${entry({ copy: "V2026_09_23_COPY" })}
]);
`;
  // The alias is not a literal, so it is refused rather than compared -- which is
  // the right answer: a table this cannot read is one it cannot claim anything
  // about.
  unreadable(now, /V2026_09_23_COPY is not a literal|copy is not the name/);
});

test("a decoy declaration cannot answer for the export", () => {
  // A review's own bypass: a local const with the right name and an export
  // clause renaming the real one, so the parser read one value and the module
  // exported another.
  const decoy = `${COPY}
const CONSENT_COPY_VERSIONS = Object.freeze([
${entry()}
]);
const actual = Object.freeze([
${entry({ approvedBy: "somebody-else" })}
]);
export { actual as CONSENT_COPY_VERSIONS };
`;
  unreadable(decoy, /re-exported through an export clause/);

  // And a declaration that is not exported at all.
  const unexported = `${COPY}
const CONSENT_COPY_VERSIONS = Object.freeze([
${entry()}
]);
`;
  unreadable(unexported, /declared but not exported/);
});

test("a comment cannot answer for the array, or for a field", () => {
  const changed = { approvedBy: "somebody-else" };
  const commentedArray = `
/*
export const CONSENT_COPY_VERSIONS = Object.freeze([
${entry()}
]);
*/
${sourceWith(entry(changed))}`;
  const { problems } = problemsFor(sourceWith(entry()), commentedArray);
  assert.equal(problems.length, 1, "a commented-out array answered for the real one");
  assert.match(problems[0], /approvedBy/);

  const commentedField = sourceWith(
    entry({ ...changed, comment: '// approvedBy: "mposition",' })
  );
  const second = problemsFor(sourceWith(entry()), commentedField);
  assert.equal(second.problems.length, 1);
  assert.match(second.problems[0], /approvedBy/);
});

test("a spread, a computed key, a duplicate and a computed value are refused", () => {
  unreadable(sourceWith(entry({ extra: "\n    ...changedRecord," })), /spread/);
  unreadable(sourceWith(entry({ extra: '\n    ["approved" + "By"]: "x",' })), /computed key/);
  unreadable(sourceWith(entry({ extra: '\n    approvedBy: "somebody-else",' })), /approvedBy twice/);
  unreadable(
    sourceWith(entry()).replace('approvedBy: "mposition"', "approvedBy: computeApprover()"),
    /approvedBy is produced by a call|approvedBy is not a literal/
  );
  unreadable(sourceWith(entry({ sections: "buildSections()" })), /approvedSections is produced by a call|approvedSections is not a literal/);
  unreadable(sourceWith(entry({ copy: '"V2026_09_23"' })), /copy is not the name/);
});

test("two declarations of the array are refused rather than picked between", () => {
  const two = `${sourceWith(entry())}\nexport const CONSENT_COPY_VERSIONS = Object.freeze([${entry()}]);`;
  unreadable(two, /declared 2 time\(s\)/);
});

test("a file that does not parse is refused", () => {
  unreadable("export const CONSENT_COPY_VERSIONS = Object.freeze([ {{{ ", /does not parse|cannot read/);
});

test("a version cannot be removed or pushed down the array", () => {
  const before = sourceWith(entry());
  const removed = problemsFor(before, sourceWith(entry({ version: "2026-12-01" })));
  assert.match(removed.problems[0], /entry 1 is 2026-12-01 and was 2026-09-23/);

  const emptied = problemsFor(
    sourceWith(entry(), entry({ version: "2026-12-01", recordSection: "11." })),
    sourceWith(entry())
  );
  assert.match(emptied.problems[0], /2026-12-01 was approved version 2 .* not in the array/s);

  const inserted = problemsFor(
    before,
    sourceWith(entry({ version: "2026-12-01", recordSection: "11." }), entry())
  );
  assert.match(inserted.problems[0], /A new version is appended/);
});

test("the approved document is compared section by section, and only two may be amended", () => {
  const doc = (overrides = {}) => {
    const parts = {
      "": "# 이메일 동의 문안 (S2)\n\n상태: 승인됨\n\n",
      "0.": "## 0. 승인하실 때 보시는 것\n\n...\n\n",
      "4.": "## 4. 통지\n\n승인된 문안\n\n",
      "9.": "## 9. 승인 이후 발견된 것\n\n...\n\n",
      "10.": "## 10. 고치는 법\n\n...\n",
      ...overrides,
    };
    return Object.values(parts).join("");
  };
  const before = sectionsOf(doc(), "base");
  const source = sourceWith(entry());
  const compare = (text) =>
    immutabilityProblems({
      before: recordsOf(source, "base"),
      now: recordsOf(source, "head"),
      base: "origin/develop",
      documentBefore: before,
      documentNow: sectionsOf(text, "head"),
    });

  assert.deepEqual(compare(doc()).problems, []);

  // Approved wording: refused.
  const wording = compare(doc({ "4.": "## 4. 통지\n\n고친 문안\n\n" }));
  assert.equal(wording.problems.length, 1);
  assert.match(wording.problems[0], /section 4\. of the approved document changed/);

  // The status block, where 승인됨 could become 반려됨: refused.
  const status = compare(doc({ "": "# 이메일 동의 문안 (S2)\n\n상태: 반려됨\n\n" }));
  assert.equal(status.problems.length, 1);
  assert.match(status.problems[0], /the status block of the approved document changed/);

  // Section 0, which is neither approved wording nor the procedure: refused.
  assert.equal(compare(doc({ "0.": "## 0. 승인하실 때\n\n바뀜\n\n" })).problems.length, 1);

  // Sections 9 and 10: amended, and said so rather than refused.
  for (const number of AMENDABLE_SECTIONS) {
    const amended = compare(doc({ [number]: `## ${number} 고침\n\n새 내용\n\n` }));
    assert.deepEqual(amended.problems, []);
    assert.equal(amended.notes.length, 1);
    assert.match(amended.notes[0], /was amended/);
  }

  // A new section is an addition, which a new version brings.
  const added = compare(`${doc()}## 11. 새 버전\n\n문안\n`);
  assert.deepEqual(added.problems, []);
  assert.deepEqual(added.newSections, ["11."]);

  // A deleted section is not.
  const deleted = immutabilityProblems({
    before: recordsOf(source, "base"),
    now: recordsOf(source, "head"),
    base: "origin/develop",
    documentBefore: before,
    documentNow: sectionsOf(doc({ "4.": "" }), "head"),
  });
  assert.equal(deleted.problems.length, 1);
  assert.match(deleted.problems[0], /section 4\. was in the approved document .* and is gone/);
});

test("a document with two sections of the same number is refused", () => {
  assert.throws(
    () => sectionsOf("## 4. one\n\n## 4. two\n", "test"),
    (error) => {
      assert.ok(error instanceof Unreadable);
      assert.match(error.message, /two depth-2 headings numbered 4\./);
      return true;
    }
  );
  assert.throws(
    () => sectionsOf("no headings here\n", "test"),
    (error) => {
      assert.match(error.message, /no depth-2 heading/);
      return true;
    }
  );
});
