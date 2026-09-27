// What an approved consent version's record is, and what counts as editing one.
//
// Contract: docs/policy/email-consent-copy-draft.md sections 10, 10.1.
//
// Pure, so the judgement can be tested against pairs of sources rather than
// against whatever two revisions happen to be checked out. The script beside this
// one supplies the two sources: the working tree and the base revision.

const SOURCE = "lib/emailConsentCopy.ts";
const ARRAY = "CONSENT_COPY_VERSIONS";

/**
 * Walk source text, ignoring what is inside strings and comments.
 *
 * Needed because the entries hold Korean prose in quotes and a `{` or `[` in it
 * would otherwise close a block early. Template literals are walked as plain
 * strings: the array holds none, and a `${}` with a brace in it would be a reason
 * to fail rather than to guess.
 */
export const blockEnd = (source, open) => {
  const pairs = { "{": "}", "[": "]", "(": ")" };
  const stack = [pairs[source[open]]];
  let i = open + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "/" && source[i + 1] === "/") {
      i = source.indexOf("\n", i);
      if (i < 0) break;
      continue;
    }
    if (ch === "/" && source[i + 1] === "*") {
      const to = source.indexOf("*/", i + 2);
      if (to < 0) break;
      i = to + 2;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < source.length && source[i] !== ch) i += source[i] === "\\" ? 2 : 1;
      i += 1;
      continue;
    }
    if (pairs[ch]) {
      stack.push(pairs[ch]);
    } else if (ch === stack[stack.length - 1]) {
      stack.pop();
      if (stack.length === 0) return i;
    }
    i += 1;
  }
  throw new Error(`${SOURCE}: a block opened at ${open} never closes`);
};

/** The text of each `Object.freeze({ ... })` entry of the versions array. */
export const entriesOf = (source, where) => {
  const at = source.indexOf(ARRAY);
  if (at < 0) throw new Error(`${where}: ${SOURCE} holds no ${ARRAY}`);
  const open = source.indexOf("([", at);
  if (open < 0) throw new Error(`${where}: ${ARRAY} is not an array literal`);
  const region = source.slice(open + 1, blockEnd(source, open + 1) + 1);

  const entries = [];
  let i = 0;
  for (;;) {
    const found = region.indexOf("Object.freeze({", i);
    if (found < 0) break;
    const brace = region.indexOf("{", found);
    const to = blockEnd(region, brace);
    entries.push(region.slice(brace, to + 1));
    i = to + 1;
  }
  if (entries.length === 0) throw new Error(`${where}: ${ARRAY} holds no entries`);
  return entries;
};

const SCALARS = [
  "version",
  "approvedBy",
  "approvedAt",
  "recordSection",
  "recordDigest",
  "approvedBodyDigest",
];

/** The fields compared, in the order a failure reports them. */
export const RECORD_FIELDS = [...SCALARS, "approvedSections", "copy"];

/**
 * The record an entry states, with comments and formatting left out.
 *
 * `approvedSections` is the table the owner signed, so its content is part of the
 * record; whitespace inside it is not. `copy` is compared by the name of the copy
 * table, which is what ties the entry to the fifty-six pinned strings. Everything
 * else in the entry -- the comments, the device map, the line breaks -- may be
 * improved without this check having an opinion.
 */
export const recordOf = (entry, where) => {
  const record = {};
  for (const field of SCALARS) {
    const found = new RegExp(`(?:^|[\\s,{])${field}:\\s*"([^"]*)"`).exec(entry);
    if (!found) throw new Error(`${where}: an entry has no ${field}`);
    record[field] = found[1];
  }
  const sections = entry.indexOf("approvedSections:");
  if (sections < 0) throw new Error(`${where}: an entry has no approvedSections`);
  const bracket = entry.indexOf("[", sections);
  record.approvedSections = entry
    .slice(bracket, blockEnd(entry, bracket) + 1)
    .replace(/\s+/g, " ");
  const copy = /(?:^|[\s,{])copy:\s*([A-Za-z0-9_$.]+)/.exec(entry);
  if (!copy) throw new Error(`${where}: an entry has no copy table`);
  record.copy = copy[1];
  return record;
};

export const recordsOf = (source, where) =>
  entriesOf(source, where).map((entry) => recordOf(entry, where));

/**
 * The recomputations this repository has decided are not changes to a record.
 *
 * A digest is a function of the document *and* of how the digest is computed. When
 * the second changes -- the body digest's input became length-prefixed, and its
 * section list became derived from the approval table rather than written beside
 * it -- an existing version's recorded value has to move although nothing the
 * owner signed did. Refusing that outright would mean never being able to
 * strengthen the pin; letting it through silently would mean the gate says
 * nothing.
 *
 * So each one is written down, with the exact pair of values and why. A wording
 * edit matches no entry here and still fails, and an entry only ever excuses the
 * one transition it names. An entry whose `from` is no longer what the base holds
 * is dead, and goes out with the branch that needed it.
 */
export const RECOMPUTED = [
  {
    version: "2026-09-23",
    field: "approvedBodyDigest",
    from: "641a53ca88b3a0fd7d276426c1ee2a29",
    to: "4d4f8824c4a859fbc1f2007eca022af2",
    why:
      "The digest's input changed, not the document: each part now carries its " +
      "own length instead of being joined by a NUL, and the section list is " +
      "derived from the approval table. Sections 1 to 6 and section 8 are the " +
      "same bytes.",
  },
];

/**
 * What changed between the base revision's approved versions and this tree's.
 *
 * Returns the problems, which is the answer: no problems is the pass. Versions
 * may be appended and nothing else -- not removed, not reordered, not edited.
 */
export const immutabilityProblems = ({ before, now, base, recomputed = RECOMPUTED }) => {
  const problems = [];
  const notes = [];
  const excuse = (version, field, was, next) =>
    recomputed.find(
      (entry) =>
        entry.version === version &&
        entry.field === field &&
        entry.from === was &&
        entry.to === next
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
          `wording is a new version in a new section, not an edit to this one.`
      );
    }
  });

  return { problems, notes, added: now.slice(before.length).map((entry) => entry.version) };
};

export const CONSENT_COPY_SOURCE = SOURCE;
