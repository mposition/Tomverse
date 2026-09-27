// What the base comparison catches, and what it deliberately does not.
//
// Contract: docs/policy/email-consent-copy-draft.md sections 10, 10.1.
//
// The in-tree digests make an edit to the approved document visible; they cannot
// make it impossible, because the same commit holds both the document and the
// pins. This is the check that reads the base revision instead. The cases below
// are the six things a commit could do to an approved version's record, and the
// two it may do freely.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  RECOMPUTED,
  RECORD_FIELDS,
  entriesOf,
  immutabilityProblems,
  recordsOf,
} from "../scripts/check-consent-copy-immutability-core.mjs";

const SOURCE = "lib/emailConsentCopy.ts";

/** A minimal array of the shape the real file holds, so a case can edit one field. */
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
    copy: ${fields.copy},
  }),`;
};

const problemsFor = (before, now, recomputed = []) =>
  immutabilityProblems({
    before: recordsOf(before, "base"),
    now: recordsOf(now, "head"),
    base: "origin/develop",
    recomputed,
  });

test("the real file parses, and its record is the one the array states", () => {
  // If the entry shape ever moves past what this reads, the check has to fail
  // loudly rather than compare an empty record with another empty record.
  const records = recordsOf(readFileSync(SOURCE, "utf8"), SOURCE);
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
  // One case per field, because a check that compares five of seven is the same
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
    // The version id moving is reported as a reordered entry rather than as a
    // changed field: from outside, entry 1 simply is not that version any more.
    assert.match(
      problems[0],
      field === "version" ? /entry 1 is 2026-09-24/ : new RegExp(field),
      `${field}: ${problems[0]}`
    );
  }
});

test("dropping the scope of an approval is one of those changes", () => {
  // The whole reason the section list is no longer written beside the digest: a
  // commit that removed §4 from the list, removed its row from the approval
  // table and recomputed both digests used to pass everything. Two of those three
  // are fields here.
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

  // Inserted in front, which section 10.1 item 4 forbids because every other
  // check still passes while the product renders the older wording.
  const inserted = problemsFor(
    before,
    sourceWith(entry({ version: "2026-12-01", recordSection: "11." }), entry())
  );
  assert.match(inserted.problems[0], /A new version is appended/);
});

test("a recomputation is excused only for the exact transition it names", () => {
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

  // And an entry never excuses a different field or a different version.
  for (const overrides of [{ recordDigest: "3".repeat(32) }, { approvedAt: "2026-09-24" }]) {
    const { problems } = problemsFor(
      sourceWith(entry()),
      sourceWith(entry(overrides)),
      recomputed
    );
    assert.equal(problems.length, 1);
  }
});

test("the recorded recomputations are the shape the check reads", () => {
  for (const item of RECOMPUTED) {
    assert.ok(RECORD_FIELDS.includes(item.field), `${item.field} is not a compared field`);
    assert.notEqual(item.from, item.to);
    assert.ok(item.why.length > 40, "a recomputation says why, or it says nothing");
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
  const [only] = entriesOf(awkward, "test");
  assert.ok(only.includes("copy: V2026_09_23"), "the entry was cut short");
  const { problems } = problemsFor(awkward, awkward);
  assert.deepEqual(problems, []);
});
