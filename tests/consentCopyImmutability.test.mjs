// What the base comparison catches, and what it deliberately does not.
//
// Contract: docs/policy/email-consent-copy-draft.md sections 10, 10.1.
//
// The in-tree digests make an edit to the approved document visible; they cannot
// make it impossible, because the same commit holds both the document and the
// pins. This is the check that reads the base revision instead. Two rounds of
// review shaped it: the first asked for it at all, the second broke its parser
// three ways in one sitting, and every one of those is a case here -- a check a
// comment can defeat reports "unchanged" about a file that changed, which is
// worse than no check because it is quoted as evidence.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CONSENT_COPY_SOURCE,
  DIGEST_FIELDS,
  DOCUMENT_AMENDMENTS,
  PINS_SOURCE,
  RECOMPUTED,
  RECORD_FIELDS,
  Unreadable,
  immutabilityProblems,
  pinsOf,
  recordsOf,
} from "../scripts/check-consent-copy-immutability-core.mjs";

/** A minimal file of the shape the real one holds, so a case can edit one field. */
const sourceWith = (...entries) => `
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
    recordDigest: "c1cb328e70178109be557037025ef807",
    approvedBodyDigest: "4d4f8824c4a859fbc1f2007eca022af2",
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
    recordDigest: "${fields.recordDigest}",
    approvedBodyDigest: "${fields.approvedBodyDigest}",
    deviceCells: {
      signupOptIn: { section: "3.A", label: null, role: null },
    },
    approvedSections: ${fields.sections},
    copy: ${fields.copy},${fields.extra}
  }),`;
};

const problemsFor = (before, now, recomputed = []) =>
  immutabilityProblems({
    before: recordsOf(before, "base"),
    now: recordsOf(now, "head"),
    base: "origin/develop",
    recomputed,
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

test("the real files parse, and their records are what the arrays state", () => {
  const records = recordsOf(readFileSync(CONSENT_COPY_SOURCE, "utf8"), CONSENT_COPY_SOURCE);
  assert.ok(records.length >= 1);
  for (const record of records) {
    for (const field of RECORD_FIELDS) {
      assert.ok(
        typeof record[field] === "string" && record[field].length > 0,
        `${field} came back empty, so the check would compare nothing`
      );
    }
    assert.match(record.recordDigest, /^[0-9a-f]{32}$/);
    assert.match(record.approvedBodyDigest, /^[0-9a-f]{32}$/);
  }
  const pins = pinsOf(readFileSync(PINS_SOURCE, "utf8"), PINS_SOURCE);
  assert.match(pins.unversionedSectionsDigest, /^[0-9a-f]{32}$/);
  assert.ok(pins.unversionedSections.length > 0);
});

test("an unchanged version is a pass, comments and formatting included", () => {
  const before = sourceWith(entry());
  const now = sourceWith(
    entry({ comment: "// Rewritten comment, three words longer than it was." })
  );
  const { problems, added } = problemsFor(before, now);
  assert.deepEqual(problems, []);
  assert.deepEqual(added, []);
});

test("appending a version is a pass, and the addition is named", () => {
  const before = sourceWith(entry());
  const now = sourceWith(
    entry(),
    entry({ version: "2026-12-01", recordSection: "11.", copy: "V2026_12_01" })
  );
  const { problems, added } = problemsFor(before, now);
  assert.deepEqual(problems, []);
  assert.deepEqual(added, ["2026-12-01"]);
});

test("every field of an approved record is compared", () => {
  // One case per field, because a check that compares six of eight is the same
  // failure as no check for the two.
  const changes = {
    version: { version: "2026-09-24" },
    approvedBy: { approvedBy: "somebody-else" },
    approvedAt: { approvedAt: "2026-09-24" },
    recordSection: { recordSection: "11." },
    recordDigest: { recordDigest: "0".repeat(32) },
    approvedBodyDigest: { approvedBodyDigest: "1".repeat(32) },
    approvedSections: {
      sections: `[
      ["§1", "R5 — 철회 시까지"],
    ] as const`,
    },
    copy: { copy: "V2026_12_01" },
  };
  assert.deepEqual(Object.keys(changes).sort(), [...RECORD_FIELDS].sort());

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

test("a comment cannot answer for the array, or for a field", () => {
  // The three bypasses a review found in the string-searching version. Each one
  // made the check report "unchanged" about a file that had changed.
  const changed = { approvedBy: "somebody-else" };

  // An old copy of the array in a comment, above the real one.
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

  // An old field in a comment, above the real one. The parser reads the
  // initialiser, so the comment is not a value.
  const commentedField = sourceWith(
    entry({
      ...changed,
      comment: '// approvedBy: "mposition",',
    })
  );
  const second = problemsFor(sourceWith(entry()), commentedField);
  assert.equal(second.problems.length, 1);
  assert.match(second.problems[0], /approvedBy/);
});

test("a spread, a computed key, a duplicate and a computed value are refused", () => {
  // Not "reported as unchanged" and not "reported as changed": refused. A record
  // this cannot read exactly is one whose runtime value it cannot claim anything
  // about, and `...changedRecord` after the literal fields is exactly that.
  unreadable(sourceWith(entry({ extra: "\n    ...changedRecord," })), /spread/);
  unreadable(sourceWith(entry({ extra: '\n    ["approved" + "By"]: "x",' })), /computed key/);
  unreadable(sourceWith(entry({ extra: '\n    approvedBy: "somebody-else",' })), /approvedBy twice/);
  unreadable(
    sourceWith(entry({ approvedBy: '${base}' }).replace('"${base}"', "computeApprover()")),
    /approvedBy is not a plain string literal/
  );
  unreadable(sourceWith(entry({ sections: "buildSections()" })), /approvedSections is not an array/);
  unreadable(sourceWith(entry({ copy: '"V2026_09_23"' })), /copy is not the name/);
});

test("a second declaration of the array is refused rather than picked between", () => {
  const two = `${sourceWith(entry())}\n${sourceWith(entry({ approvedBy: "somebody-else" }))}`;
  unreadable(two, /declares CONSENT_COPY_VERSIONS 2 time\(s\)/);
});

test("a file that does not parse is refused", () => {
  unreadable("export const CONSENT_COPY_VERSIONS = Object.freeze([ {{{ ", /does not parse|cannot read/);
});

test("dropping the scope of an approval is one of those changes", () => {
  // The whole reason the section list is no longer written beside the digest: a
  // commit that removed §4 from the list, removed its row from the approval
  // table and recomputed both digests used to pass everything.
  const narrowed = {
    sections: `[
      ["§1", "R5 — 철회 시까지"],
    ] as const`,
    approvedBodyDigest: "2".repeat(32),
  };
  const { problems } = problemsFor(sourceWith(entry()), sourceWith(entry(narrowed)));
  assert.equal(problems.length, 2);
  assert.ok(problems.some((problem) => problem.includes("approvedSections")));
  assert.ok(problems.some((problem) => problem.includes("approvedBodyDigest")));
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

test("a recomputation excuses only a digest, and only the transition it names", () => {
  const recomputed = [
    {
      version: "2026-09-23",
      field: "approvedBodyDigest",
      from: "4d4f8824c4a859fbc1f2007eca022af2",
      to: "3".repeat(32),
      why: "test",
    },
  ];
  const named = problemsFor(
    sourceWith(entry()),
    sourceWith(entry({ approvedBodyDigest: "3".repeat(32) })),
    recomputed
  );
  assert.deepEqual(named.problems, []);
  assert.deepEqual(named.notes, [
    "version 2026-09-23's approvedBodyDigest was recomputed: test",
  ]);

  // A third value, the same field: not the transition that was reviewed.
  const other = problemsFor(
    sourceWith(entry()),
    sourceWith(entry({ approvedBodyDigest: "4".repeat(32) })),
    recomputed
  );
  assert.equal(other.problems.length, 1);

  // And an entry for a field that is not a digest excuses nothing, however
  // exactly it names the transition. A review was right that this list is an
  // audit signal rather than an approval, so it is narrowed to the two values
  // that can move without the document moving.
  for (const field of RECORD_FIELDS.filter((name) => !DIGEST_FIELDS.includes(name))) {
    if (field === "version") continue; // reported as a reordered entry instead
    const overrides =
      field === "approvedSections"
        ? { sections: '[["§1", "R5"]] as const' }
        : field === "copy"
          ? { copy: "ChangedCopy" }
          : { [field]: "changed-value" };
    const was =
      field === "approvedSections" ? '[["§1","R5 — 철회 시까지"],["§4.1–4.3","통지 3건의 문안"]]' : undefined;
    const { problems } = problemsFor(
      sourceWith(entry()),
      sourceWith(entry(overrides)),
      [
        {
          version: "2026-09-23",
          field,
          from: was ?? "mposition",
          to: field === "copy" ? "ChangedCopy" : "changed-value",
          why: "an entry that must not work",
        },
      ]
    );
    assert.equal(problems.length, 1, `${field} was excused by a recomputation entry`);
    assert.match(problems[0], /No recomputation entry can excuse this field/);
  }
});

test("the sections no version owns are compared too, and an amendment is named", () => {
  const pins = (digest, sections = '["0.", "7.", "9.", "10."]') => `
export const UNVERSIONED_SECTIONS = ${sections};
export const UNVERSIONED_SECTIONS_DIGEST = "${digest}";
`;
  const before = pinsOf(pins("a".repeat(32)), "base");
  const source = sourceWith(entry());

  // An edited section 9 with the digest repinned: the version records are
  // untouched, so this is the one thing round 14's finding still covered.
  const unnamed = immutabilityProblems({
    before: recordsOf(source, "base"),
    now: recordsOf(source, "head"),
    base: "origin/develop",
    pinsBefore: before,
    pinsNow: pinsOf(pins("b".repeat(32)), "head"),
    amendments: [],
  });
  assert.equal(unnamed.problems.length, 1);
  assert.match(unnamed.problems[0], /DOCUMENT_AMENDMENTS/);

  // With a line saying what was amended, it passes and says so.
  const named = immutabilityProblems({
    before: recordsOf(source, "base"),
    now: recordsOf(source, "head"),
    base: "origin/develop",
    pinsBefore: before,
    pinsNow: pinsOf(pins("b".repeat(32)), "head"),
    amendments: [{ from: "a".repeat(32), to: "b".repeat(32), why: "section 10.1 gained an item" }],
  });
  assert.deepEqual(named.problems, []);
  assert.equal(named.notes.length, 1);

  // The list itself is not amendable: a section no version claims is a section
  // nobody approved.
  const listMoved = immutabilityProblems({
    before: recordsOf(source, "base"),
    now: recordsOf(source, "head"),
    base: "origin/develop",
    pinsBefore: before,
    pinsNow: pinsOf(pins("a".repeat(32), '["0.", "7.", "9.", "10.", "11."]'), "head"),
    amendments: [],
  });
  assert.equal(listMoved.problems.length, 1);
  assert.match(listMoved.problems[0], /list of sections no version owns/);
});

test("the recorded exemptions are the shape the check reads", () => {
  for (const item of RECOMPUTED) {
    assert.ok(DIGEST_FIELDS.includes(item.field), `${item.field} is not a digest field`);
    assert.notEqual(item.from, item.to);
    assert.ok(item.why.length > 40, "a recomputation says why, or it says nothing");
  }
  for (const item of DOCUMENT_AMENDMENTS) {
    assert.notEqual(item.from, item.to);
    assert.ok(item.why.length > 40, "an amendment says what was amended, or it says nothing");
  }
});

test("prose in an entry cannot end it early", () => {
  // The Korean descriptions in the approval table hold brackets and braces, and
  // an entry that ended at the first one of those would compare a truncated
  // record against a truncated record and pass.
  const awkward = sourceWith(
    entry({
      sections: `[
      ["§3.A–D", "동의 장치 4개의 문안 {A, B} [초안]"],
    ] as const`,
    })
  );
  const [record] = recordsOf(awkward, "test");
  assert.equal(record.copy, "V2026_09_23", "the entry was cut short");
  const { problems } = problemsFor(awkward, awkward);
  assert.deepEqual(problems, []);
});
