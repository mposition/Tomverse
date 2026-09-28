// What an approved consent version is, and what counts as changing one.
//
// Contract: docs/policy/email-consent-copy-draft.md sections 10, 10.1.
//
// Pure, so the judgement can be tested against pairs of sources rather than
// against whatever two revisions happen to be checked out. The script beside
// this one supplies the sources: the working tree and the base revision.
//
// ## What this compares, after four rounds of getting it wrong
//
// The approved bytes. Not a digest of them, not a record about them -- the
// wording itself, the document sections it was approved in, and the approval
// table that signed them.
//
// Every earlier version compared metadata, and every round of review found the
// same shape of hole underneath it. The last one was the clearest: the
// recomputation exemption had been narrowed to the two digest fields, and a
// commit could still change the words in the copy table, repin the document,
// and write both digest transitions into the exemption list. Narrowing the
// exemption did not close the hole, because a digest is only evidence about
// bytes that nobody was comparing.
//
// So there is no exemption list any more. `RECOMPUTED` is gone because a
// recomputation is now indistinguishable from a no-op: if the bytes are equal
// the check passes whatever the digests say, and if the bytes differ no entry
// anywhere can excuse it. `DOCUMENT_AMENDMENTS` is gone because sections 9 and
// 10 are compared as themselves -- amendable, and named as such -- rather than
// lumped into one digest with the status block.
//
// ## And the parser is the compiler's
//
// A round found three ways to defeat a string search: an old array in a comment,
// an old field in a comment above a computed value, and a spread after the
// literals. This parses with TypeScript and refuses anything it cannot read
// exactly. A round after that found the parser trusting any declaration with the
// right name: it now requires a top-level `export const`, and refuses a file
// that re-exports the name under an alias.

import ts from "typescript";

const SOURCE = "lib/emailConsentCopy.ts";
const ARRAY = "CONSENT_COPY_VERSIONS";
const DOCUMENT = "docs/policy/email-consent-copy-draft.md";

/** The fields of a version entry that are compared as the record. */
export const RECORD_FIELDS = [
  "version",
  "approvedBy",
  "approvedAt",
  "recordSection",
  "approvedSections",
  "deviceCells",
  "deviceSummary",
  "copy",
];

/**
 * The document sections an approved version may not change, and the ones it may.
 *
 * The status block and sections 0 and 7 are neither approved wording nor an
 * amendable procedure: they are the frame, and nothing in a later commit has a
 * reason to move them. Sections 9 and 10 are amendable -- 9 records what was
 * found afterwards and 10 is the procedure the document amends by -- so a change
 * to them is reported as an amendment rather than refused, which is a line in
 * the output an operator reads rather than an exemption somebody writes.
 */
export const AMENDABLE_SECTIONS = ["9.", "10."];

class Unreadable extends Error {}

const fail = (where, message) => {
  throw new Unreadable(`${where}: ${message}`);
};

const parse = (source, where, file = SOURCE) => {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const syntax = parsed.parseDiagnostics ?? [];
  if (syntax.length > 0) fail(where, `${file} does not parse (${syntax.length} error(s))`);
  return parsed;
};

/**
 * The initialiser of one top-level `export const <name>`.
 *
 * Top-level and exported, both checked. A review made a decoy: a local
 * declaration with the right name and `export { actual as CONSENT_COPY_VERSIONS }`
 * beside it, so the parser read one object while the module exported another. An
 * export clause that renames anything to a name this check reads is refused
 * outright -- there is no legitimate reason for one here, and refusing what it
 * cannot follow is the only safe answer to indirection.
 */
const exportedConst = (file, where, name) => {
  for (const statement of file.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.exportClause) continue;
    if (!ts.isNamedExports(statement.exportClause)) continue;
    for (const element of statement.exportClause.elements) {
      if (element.name.text === name) {
        fail(
          where,
          `${name} is re-exported through an export clause, so the declaration this check ` +
            `reads may not be the value the module exports`
        );
      }
    }
  }

  const found = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const exported = (statement.modifiers ?? []).some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    );
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        found.push({ declaration, exported });
      }
    }
  }
  if (found.length !== 1) {
    fail(where, `${name} is declared ${found.length} time(s) at the top level; it must be once`);
  }
  if (!found[0].exported) fail(where, `${name} is declared but not exported`);
  const initialiser = found[0].declaration.initializer;
  if (initialiser === undefined) fail(where, `${name} has no initialiser`);
  return initialiser;
};

/** Unwraps `Object.freeze(x)`, `x as const` and parentheses; refuses other calls. */
const unwrap = (node, where, what) => {
  let value = node;
  for (;;) {
    if (ts.isAsExpression(value) || (ts.isSatisfiesExpression?.(value) ?? false)) {
      value = value.expression;
      continue;
    }
    if (ts.isParenthesizedExpression(value)) {
      value = value.expression;
      continue;
    }
    if (ts.isCallExpression(value)) {
      const callee = value.expression;
      const frozen =
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Object" &&
        callee.name.text === "freeze" &&
        value.arguments.length === 1;
      if (!frozen) fail(where, `${what} is produced by a call this check cannot read`);
      value = value.arguments[0];
      continue;
    }
    return value;
  }
};

/**
 * A literal, as a plain JavaScript value.
 *
 * Strings, numbers, booleans, null, and arrays and objects of those. Anything
 * else -- an identifier, a computed key, a spread, a getter, a template with a
 * substitution -- is refused rather than approximated, because a value this
 * cannot read is one it cannot claim anything about.
 */
const literal = (node, where, what) => {
  const value = unwrap(node, where, what);
  if (ts.isStringLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)) return value.text;
  if (ts.isNumericLiteral(value)) return Number(value.text);
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (value.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(value)) {
    return value.elements.map((element) => {
      if (ts.isSpreadElement(element)) fail(where, `${what} holds a spread`);
      return literal(element, where, what);
    });
  }
  if (ts.isObjectLiteralExpression(value)) {
    const out = {};
    for (const property of value.properties) {
      if (ts.isSpreadAssignment(property)) fail(where, `${what} holds a spread`);
      if (!ts.isPropertyAssignment(property)) {
        fail(where, `${what} holds a property this check cannot read`);
      }
      if (ts.isComputedPropertyName(property.name)) fail(where, `${what} holds a computed key`);
      const key =
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : null;
      if (key === null) fail(where, `${what} holds a key this check cannot read`);
      if (Object.hasOwn(out, key)) fail(where, `${what} holds ${key} twice`);
      out[key] = literal(property.initializer, where, `${what}.${key}`);
    }
    return out;
  }
  fail(where, `${what} is not a literal, so its value cannot be compared`);
  return null;
};

/**
 * The approved wording a version's `copy` names, resolved to its strings.
 *
 * This is the point of the whole check. `copy: V2026_09_23` is a reference, and
 * a review pointed out that comparing the reference compares the name of the
 * words rather than the words. The table is a top-level `const` in the same
 * file, so it is read and compared as a value -- fifty-six strings, all of them.
 */
const copyTable = (file, identifier, where) => {
  const found = [];
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === identifier) {
        found.push(declaration);
      }
    }
  }
  if (found.length !== 1) {
    fail(where, `${identifier} is declared ${found.length} time(s); the copy table must be one`);
  }
  const initialiser = found[0].initializer;
  if (initialiser === undefined) fail(where, `${identifier} has no initialiser`);
  return literal(initialiser, where, identifier);
};

/**
 * Every version's record, with the wording it approves resolved.
 *
 * Plain values, so the comparison is deep equality over things a person can read
 * in a failure message.
 */
export const recordsOf = (source, where) => {
  const file = parse(source, where);
  const array = unwrap(exportedConst(file, where, ARRAY), where, ARRAY);
  if (!ts.isArrayLiteralExpression(array)) fail(where, `${ARRAY} is not an array literal`);
  if (array.elements.length === 0) fail(where, `${ARRAY} holds no entries`);

  return array.elements.map((element) => {
    const object = unwrap(element, where, "a version entry");
    if (!ts.isObjectLiteralExpression(object)) {
      fail(where, "a version entry is not an object literal");
    }

    const fields = new Map();
    for (const property of object.properties) {
      if (ts.isSpreadAssignment(property)) {
        fail(
          where,
          "a version entry holds a spread, which can change any field without the field being written"
        );
      }
      if (!ts.isPropertyAssignment(property)) {
        fail(where, "a version entry holds a property this check cannot read");
      }
      if (ts.isComputedPropertyName(property.name)) {
        fail(where, "a version entry holds a computed key");
      }
      const key =
        ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)
          ? property.name.text
          : null;
      if (key === null) fail(where, "a version entry holds a key this check cannot read");
      if (fields.has(key)) fail(where, `a version entry holds ${key} twice`);
      fields.set(key, property.initializer);
    }

    const record = {};
    for (const field of RECORD_FIELDS) {
      const value = fields.get(field);
      if (value === undefined) fail(where, `a version entry has no ${field}`);
      if (field === "copy") {
        const named = unwrap(value, where, "copy");
        if (!ts.isIdentifier(named)) fail(where, "copy is not the name of a copy table");
        record.copyTable = named.text;
        // The words themselves, which is the thing this check exists to compare.
        record.copy = copyTable(file, named.text, where);
      } else {
        record[field] = literal(value, where, field);
      }
    }
    return record;
  });
};

/**
 * The approved document, split into its depth-2 sections plus the bytes before
 * the first one.
 *
 * A heading to the next heading, the last to the end of the file, so every byte
 * belongs to exactly one part. `tests/emailConsentCopy.test.mjs` reassembles the
 * document from the same partition and compares it with the file, so the two
 * cannot disagree about what a section is.
 */
export const sectionsOf = (source, where) => {
  const text = source.replace(/\r\n/g, "\n");
  const headings = [];
  const pattern = /^## +(\S+)/gm;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    headings.push({ number: match[1], at: match.index });
  }
  if (headings.length === 0) fail(where, `${DOCUMENT} has no depth-2 heading`);

  const sections = new Map();
  sections.set("", text.slice(0, headings[0].at));
  headings.forEach((heading, index) => {
    if (sections.has(heading.number)) {
      fail(where, `${DOCUMENT} has two depth-2 headings numbered ${heading.number}`);
    }
    const end = index + 1 < headings.length ? headings[index + 1].at : text.length;
    sections.set(heading.number, text.slice(heading.at, end));
  });
  return sections;
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Which strings of a copy table differ, named so a failure can be acted on. */
const movedStrings = (was, now) => {
  const moved = [];
  const keys = new Set([...Object.keys(was ?? {}), ...Object.keys(now ?? {})]);
  for (const key of keys) {
    const a = was?.[key];
    const b = now?.[key];
    if (same(a, b)) continue;
    if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) {
      moved.push(key);
      continue;
    }
    for (const language of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!same(a[language], b[language])) moved.push(`${key}.${language}`);
    }
  }
  return [...new Set(moved)].sort();
};

/**
 * What changed between the base revision and this tree.
 *
 * Returns the problems, which is the answer: no problems is the pass. Versions
 * may be appended and nothing else; document sections may be added, sections 9
 * and 10 may be amended, and no other section may move.
 */
export const immutabilityProblems = ({
  before,
  now,
  base,
  documentBefore = null,
  documentNow = null,
  amendable = AMENDABLE_SECTIONS,
}) => {
  const problems = [];
  const notes = [];

  before.forEach((was, index) => {
    const current = now[index];
    if (current === undefined) {
      problems.push(
        `version ${was.version} was approved version ${index + 1} at ${base} and is not in ` +
          `the array any more. A past copyHash has to stay resolvable (section 10, item 3).`
      );
      return;
    }
    if (current.version !== was.version) {
      problems.push(
        `entry ${index + 1} is ${current.version} and was ${was.version} at ${base}. A new ` +
          `version is appended (section 10.1, item 4): inserting one in front of another ` +
          `passes every other check while the product keeps rendering the older wording.`
      );
      return;
    }
    if (!same(was.copy, current.copy)) {
      problems.push(
        `version ${was.version}'s approved wording changed: ` +
          `${movedStrings(was.copy, current.copy).join(", ") || "its shape"}. Those bytes are ` +
          `what a stored consent's copyHash points at; section 10 says a change to them is a ` +
          `new version in a new section, not an edit to this one.`
      );
    }
    for (const field of RECORD_FIELDS) {
      if (field === "copy") continue;
      if (same(was[field], current[field])) continue;
      problems.push(
        `version ${was.version}'s ${field} changed from ${JSON.stringify(was[field])} to ` +
          `${JSON.stringify(current[field])}. Nothing excuses this: an approved version's ` +
          `record is what it was when it was approved.`
      );
    }
    if (was.copyTable !== current.copyTable) {
      problems.push(
        `version ${was.version}'s copy table is ${current.copyTable} and was ${was.copyTable}. ` +
          `Even with identical strings, that is a different table for a version nobody ` +
          `re-approved.`
      );
    }
  });

  if (documentBefore !== null && documentNow !== null) {
    for (const [number, bytes] of documentBefore) {
      const current = documentNow.get(number);
      const name = number === "" ? "the status block" : `section ${number}`;
      if (current === undefined) {
        problems.push(`${name} was in the approved document at ${base} and is gone.`);
        continue;
      }
      if (current === bytes) continue;
      if (amendable.includes(number)) {
        notes.push(`${name} was amended, which sections ${amendable.join(" and ")} may be.`);
        continue;
      }
      problems.push(
        `${name} of the approved document changed. Only sections ${amendable.join(" and ")} ` +
          `may be amended; approved wording is changed by adding a version in a new section ` +
          `(section 10).`
      );
    }
  }

  const added = now.slice(before.length).map((entry) => entry.version);
  const newSections =
    documentBefore === null || documentNow === null
      ? []
      : [...documentNow.keys()].filter((number) => !documentBefore.has(number));
  return { problems, notes, added, newSections };
};

export const CONSENT_COPY_SOURCE = SOURCE;
export const APPROVED_DOCUMENT = DOCUMENT;
export { Unreadable };
