// What an approved consent version's record is, and what counts as editing one.
//
// Contract: docs/policy/email-consent-copy-draft.md sections 10, 10.1.
//
// Pure, so the judgement can be tested against pairs of sources rather than
// against whatever two revisions happen to be checked out. The script beside this
// one supplies the two sources: the working tree and the base revision.
//
// ## Why the parser is the TypeScript one
//
// The first version found entries by searching for `CONSENT_COPY_VERSIONS`, then
// for `Object.freeze({`, and read each field with the first matching regex. A
// review broke it three ways in one sitting: an old copy of the array inside a
// comment answered for the real one, an old `field: "value"` in a comment above a
// computed value answered for the value, and `...changedRecord` after the literal
// fields would have changed them at runtime with the literals still there to be
// read.
//
// None of those is a subtle failure. A check that can be defeated by a comment is
// a check that reports "unchanged" about a file that changed, which is worse than
// no check because it is quoted as evidence. So this parses the file the way the
// compiler does and refuses anything it cannot read exactly: a spread, a computed
// key, a duplicated key, a value that is not a literal, a second declaration of
// the array.

import ts from "typescript";

const SOURCE = "lib/emailConsentCopy.ts";
const ARRAY = "CONSENT_COPY_VERSIONS";

/** The fields that make up the record, in the order a failure reports them. */
export const RECORD_FIELDS = [
  "version",
  "approvedBy",
  "approvedAt",
  "recordSection",
  "recordDigest",
  "approvedBodyDigest",
  "approvedSections",
  "copy",
];

/** The two fields a recomputation may ever move. */
export const DIGEST_FIELDS = ["recordDigest", "approvedBodyDigest"];

class Unreadable extends Error {}

const fail = (where, message) => {
  throw new Unreadable(`${where}: ${message}`);
};

const parse = (source, where) => {
  const file = ts.createSourceFile(SOURCE, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  // `parseDiagnostics` is not part of the public type, and a file that does not
  // parse is one whose entries cannot be trusted either way.
  const syntax = file.parseDiagnostics ?? [];
  if (syntax.length > 0) fail(where, `${SOURCE} does not parse (${syntax.length} error(s))`);
  return file;
};

/** The one `export const CONSENT_COPY_VERSIONS = Object.freeze([...])` initialiser. */
const arrayLiteral = (file, where) => {
  const found = [];
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === ARRAY
    ) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (found.length !== 1) {
    fail(where, `${SOURCE} declares ${ARRAY} ${found.length} time(s); it must declare it once`);
  }
  let initialiser = found[0].initializer;
  if (initialiser === undefined) fail(where, `${ARRAY} has no initialiser`);
  // `Object.freeze([...])`, or the array on its own.
  if (ts.isCallExpression(initialiser)) {
    const callee = initialiser.expression;
    const frozen =
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Object" &&
      callee.name.text === "freeze";
    if (!frozen) fail(where, `${ARRAY} is initialised by a call this check cannot read`);
    if (initialiser.arguments.length !== 1) fail(where, `Object.freeze takes one argument`);
    initialiser = initialiser.arguments[0];
  }
  if (!ts.isArrayLiteralExpression(initialiser)) {
    fail(where, `${ARRAY} is not an array literal`);
  }
  return initialiser;
};

/** One entry's object literal, unwrapping the `Object.freeze` around it. */
const objectLiteral = (element, where) => {
  let node = element;
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const frozen =
      ts.isPropertyAccessExpression(callee) &&
      ts.isIdentifier(callee.expression) &&
      callee.expression.text === "Object" &&
      callee.name.text === "freeze";
    if (!frozen) fail(where, "an entry is produced by a call this check cannot read");
    if (node.arguments.length !== 1) fail(where, "Object.freeze takes one argument");
    node = node.arguments[0];
  }
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression?.(node)) node = node.expression;
  if (!ts.isObjectLiteralExpression(node)) fail(where, "an entry is not an object literal");
  return node;
};

/** A string literal's value, and nothing else. */
const stringOf = (node, where, field) => {
  let value = node;
  if (ts.isAsExpression(value)) value = value.expression;
  if (!ts.isStringLiteral(value) && !ts.isNoSubstitutionTemplateLiteral(value)) {
    fail(where, `${field} is not a plain string literal, so its value cannot be compared`);
  }
  return value.text;
};

/**
 * The approved-section table, as a canonical string.
 *
 * Read as nested array literals of string literals rather than as source text:
 * the table is the record, and comparing its source would report a reflow as a
 * change while a computed element would read as unchanged.
 */
const sectionsOf = (node, where) => {
  let value = node;
  if (ts.isAsExpression(value)) value = value.expression;
  if (!ts.isArrayLiteralExpression(value)) fail(where, "approvedSections is not an array literal");
  return JSON.stringify(
    value.elements.map((row) => {
      let entry = row;
      if (ts.isAsExpression(entry)) entry = entry.expression;
      if (!ts.isArrayLiteralExpression(entry)) {
        fail(where, "an approvedSections row is not an array literal");
      }
      return entry.elements.map((cell) => stringOf(cell, where, "an approvedSections cell"));
    })
  );
};

/** The record one entry states, read from the syntax and nothing else. */
const recordOf = (entry, where) => {
  const object = objectLiteral(entry, where);
  const seen = new Map();
  for (const property of object.properties) {
    if (ts.isSpreadAssignment(property)) {
      fail(
        where,
        "an entry holds a spread, which can change any field without the field being written"
      );
    }
    if (!ts.isPropertyAssignment(property)) {
      // A shorthand or a method: either way the value is not here to be read.
      fail(where, "an entry holds a property this check cannot read");
    }
    const name = property.name;
    if (ts.isComputedPropertyName(name)) {
      fail(where, "an entry holds a computed key");
    }
    const key = ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
    if (key === null) fail(where, "an entry holds a key this check cannot read");
    if (seen.has(key)) fail(where, `an entry holds ${key} twice`);
    seen.set(key, property.initializer);
  }

  const record = {};
  for (const field of RECORD_FIELDS) {
    const value = seen.get(field);
    if (value === undefined) fail(where, `an entry has no ${field}`);
    if (field === "approvedSections") {
      record[field] = sectionsOf(value, where);
    } else if (field === "copy") {
      // An identifier: the name of the copy table, which is what ties the entry
      // to the fifty-six pinned strings.
      if (!ts.isIdentifier(value)) fail(where, "copy is not the name of a copy table");
      record[field] = value.text;
    } else {
      record[field] = stringOf(value, where, field);
    }
  }
  return record;
};

/** Every entry's record, in the order the array holds them. */
export const recordsOf = (source, where) => {
  const array = arrayLiteral(parse(source, where), where);
  if (array.elements.length === 0) fail(where, `${ARRAY} holds no entries`);
  return array.elements.map((element) => recordOf(element, where));
};

/**
 * The document-level pins, read from `lib/emailConsentCopyDocumentPins.ts`.
 *
 * Separate from the versions because they answer a different question: the
 * unversioned sections are the part of the document no version owns, and a review
 * pointed out that leaving their digest in the test file left round 14's finding
 * standing for sections 9 and 10 -- edit them, repin, and the base comparison saw
 * nothing because no version's record had moved.
 */
export const PINS_SOURCE = "lib/emailConsentCopyDocumentPins.ts";

/** A flat array literal of string literals. */
const stringsOf = (node, where, field) => {
  let value = node;
  if (ts.isAsExpression(value)) value = value.expression;
  if (!ts.isArrayLiteralExpression(value)) fail(where, `${field} is not an array literal`);
  return value.elements.map((element) => stringOf(element, where, field));
};

export const pinsOf = (source, where) => {
  const file = parse(source, where);
  const found = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (found.has(node.name.text)) fail(where, `${PINS_SOURCE} declares ${node.name.text} twice`);
      found.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);

  const digest = found.get("UNVERSIONED_SECTIONS_DIGEST");
  const sections = found.get("UNVERSIONED_SECTIONS");
  if (digest === undefined || sections === undefined) {
    fail(where, `${PINS_SOURCE} does not declare the unversioned pins`);
  }
  return {
    unversionedSectionsDigest: stringOf(digest, where, "UNVERSIONED_SECTIONS_DIGEST"),
    unversionedSections: stringsOf(sections, where, "UNVERSIONED_SECTIONS").join(","),
  };
};

/**
 * The recomputations this repository has decided are not changes to a record.
 *
 * A digest is a function of the document *and* of how the digest is computed. When
 * the second changes -- the body digest's input became length-prefixed, and its
 * section list became derived from the approval table rather than written beside
 * it -- an existing version's recorded value has to move although nothing the
 * owner signed did.
 *
 * What an entry here honestly buys, and a review was right to press on this: it
 * is an audit signal and not an approval. The list is in the same commit as the
 * change it excuses, so it cannot prove that the change was a recomputation
 * rather than a rewording. What it does is make the exemption a line in the diff
 * that names the exact pair of values and says why -- and it is narrowed to the
 * two digest fields, so no entry here can ever excuse a moved approver, date,
 * section list or copy table. Those fail, full stop.
 *
 * An entry whose `from` is no longer what the base holds is dead, and goes out
 * with the branch that needed it. The list is empty on the branch that introduced
 * it, for exactly that reason: this branch's own digests moved twice while the
 * canonical form was being fixed, and the base holds neither value, so an entry
 * naming either would excuse nothing and read as though something had been
 * excused.
 */
export const RECOMPUTED = [];

/**
 * Amendments to the sections no version owns.
 *
 * Sections 9 and 10 are amendable -- section 10 is the procedure, and the
 * document's own revision history amends it -- so their digest legitimately
 * moves. Which is exactly why it needs a line saying so: without one, an edit to
 * section 9's recorded decisions is invisible to a base comparison that only
 * watches version records.
 */
export const DOCUMENT_AMENDMENTS = [];

/**
 * What changed between the base revision's approved versions and this tree's.
 *
 * Returns the problems, which is the answer: no problems is the pass. Versions
 * may be appended and nothing else -- not removed, not reordered, not edited.
 */
export const immutabilityProblems = ({
  before,
  now,
  base,
  recomputed = RECOMPUTED,
  pinsBefore = null,
  pinsNow = null,
  amendments = DOCUMENT_AMENDMENTS,
}) => {
  const problems = [];
  const notes = [];
  const excuse = (version, field, was, next) =>
    recomputed.find(
      (entry) =>
        entry.version === version &&
        entry.field === field &&
        entry.from === was &&
        entry.to === next &&
        // Narrowed to the digests, so no entry can excuse a moved approver.
        DIGEST_FIELDS.includes(entry.field)
    );

  before.forEach((was, index) => {
    const current = now[index];
    if (current === undefined) {
      problems.push(
        `version ${was.version} was approved version ${index + 1} at ${base} and is ` +
          `not in the array any more. A past copyHash has to stay resolvable ` +
          `(section 10, item 3).`
      );
      return;
    }
    if (current.version !== was.version) {
      problems.push(
        `entry ${index + 1} is ${current.version} and was ${was.version} at ${base}. ` +
          `A new version is appended (section 10.1, item 4): inserting one in front ` +
          `of another passes every other check while the product keeps rendering the ` +
          `older wording.`
      );
      return;
    }
    for (const field of RECORD_FIELDS) {
      if (current[field] === was[field]) continue;
      const allowed = excuse(was.version, field, was[field], current[field]);
      if (allowed) {
        notes.push(`version ${was.version}'s ${field} was recomputed: ${allowed.why}`);
        continue;
      }
      problems.push(
        `version ${was.version}'s ${field} changed from ${JSON.stringify(was[field])} ` +
          `to ${JSON.stringify(current[field])}. That record is what a stored ` +
          `consent's copyHash points at; section 10 says a change to approved ` +
          `wording is a new version in a new section, not an edit to this one.` +
          (DIGEST_FIELDS.includes(field)
            ? ""
            : " No recomputation entry can excuse this field.")
      );
    }
  });

  // The part of the document no version owns.
  if (pinsBefore !== null && pinsNow !== null) {
    if (pinsBefore.unversionedSections !== pinsNow.unversionedSections) {
      problems.push(
        `the list of sections no version owns changed from ` +
          `${pinsBefore.unversionedSections} to ${pinsNow.unversionedSections}. A new ` +
          `version's sections belong to that version, so adding one does not change ` +
          `this list; a section that no version claims is a section nobody approved.`
      );
    }
    if (pinsBefore.unversionedSectionsDigest !== pinsNow.unversionedSectionsDigest) {
      const amendment = amendments.find(
        (entry) =>
          entry.from === pinsBefore.unversionedSectionsDigest &&
          entry.to === pinsNow.unversionedSectionsDigest
      );
      if (amendment) {
        notes.push(`the sections no version owns were amended: ${amendment.why}`);
      } else {
        problems.push(
          `the digest of the sections no version owns changed from ` +
            `${pinsBefore.unversionedSectionsDigest} to ${pinsNow.unversionedSectionsDigest} ` +
            `with no entry in DOCUMENT_AMENDMENTS saying what was amended. Sections 9 ` +
            `and 10 may be amended; an amendment nobody wrote down cannot be told ` +
            `from an edit to the approved wording hiding behind one.`
        );
      }
    }
  }

  return { problems, notes, added: now.slice(before.length).map((entry) => entry.version) };
};

export const CONSENT_COPY_SOURCE = SOURCE;
export { Unreadable };
