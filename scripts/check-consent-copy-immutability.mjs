#!/usr/bin/env node
// An approved consent version's record is not edited. Compared against the base
// revision, because a digest in the tree cannot say that.
//
// Contract: docs/policy/email-consent-copy-draft.md sections 10, 10.1.
//
// The test file pins the approved document four ways -- the whole document, the
// part no version owns, and each version's record and approved body -- and every
// one of those pins is a line in a file the same commit can edit. That is what a
// pin is for: it makes the edit appear in the diff as a changed digest rather
// than as a silently different document. It is not immutability. A commit that
// edits section 4's wording, its version's two digests and the document digest
// passes every test, and a fourteenth-round review said so plainly.
//
// Immutability needs something outside the commit. This reads
// `lib/emailConsentCopy.ts` and `lib/emailConsentCopyDocumentPins.ts` at the base
// revision and requires every version that existed there to still be there,
// unchanged, in the same order, with new versions appended. The judgement is in
// the core module beside this one; this supplies the sources and reports.
//
// ## The first landing
//
// On the commit that introduces the records there is nothing at the base to
// compare with, and a fifteenth-round review was right that skipping is not a
// check. So the bootstrap has its own baseline: `BASELINE` holds the records and
// the pins as of this branch, and while the base has no source file the records
// must equal it exactly. That is a weaker claim -- two files in one commit rather
// than one file against a revision nobody in this commit can change -- and it is
// stated as such in the output rather than dressed up. What it buys is that the
// records cannot be edited without a second, obvious edit beside them, and that
// the check runs rather than reporting nothing.
//
// Once the source is on the base branch the baseline is ignored, and deleting it
// is the right thing to do in the commit after the merge.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import {
  CONSENT_COPY_SOURCE as SOURCE,
  PINS_SOURCE,
  Unreadable,
  immutabilityProblems,
  pinsOf,
  recordsOf,
} from "./check-consent-copy-immutability-core.mjs";

const BASELINE = "docs/policy/email-consent-copy-baseline.json";

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const git = (...argv) =>
  execFileSync("git", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const base =
  flag("base") ??
  (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/develop");

let commit = null;
try {
  commit = git("rev-parse", "--verify", "--quiet", `${base}^{commit}`).trim();
} catch {
  commit = null;
}

const stop = (message) => {
  console.error(`FAIL ${message}`);
  process.exit(1);
};

if (commit === null) {
  // Not a pass: the check could not run. In CI that is a failure, because CI is
  // the one place this is the gate and `fetch-depth: 0` is what makes the ref
  // reachable. Locally it is a stated skip -- a clone without the base branch is
  // ordinary, and failing there would only teach people to skip the gate.
  const message =
    `The base revision ${base} is not in this checkout, so an approved version's ` +
    `record cannot be compared with anything. Fetch it (git fetch origin ` +
    `${base.replace(/^origin\//, "")}) or pass --base <ref>.`;
  if (process.env.CI) stop(message);
  console.log(`SKIPPED ${message}`);
  process.exit(0);
}

const atBase = (path) => {
  try {
    return git("show", `${commit}:${path}`);
  } catch {
    return null;
  }
};

const now = { records: null, pins: null };
try {
  now.records = recordsOf(readFileSync(SOURCE, "utf8"), "the working tree");
  now.pins = pinsOf(readFileSync(PINS_SOURCE, "utf8"), "the working tree");
} catch (error) {
  if (error instanceof Unreadable) {
    stop(
      `${error.message}. This check compares what the file states, so a shape it ` +
        `cannot read exactly is a refusal rather than a guess -- a spread, a ` +
        `computed value or a second declaration can change a record without the ` +
        `record being written.`
    );
  }
  throw error;
}

const baseSource = atBase(SOURCE);
const basePins = atBase(PINS_SOURCE);

if (baseSource === null) {
  // The first landing. The baseline is the only thing older than this commit's
  // own edits, so it is required rather than optional.
  if (!existsSync(BASELINE)) {
    stop(
      `${SOURCE} does not exist at ${base}, so there is no approved record older ` +
        `than this branch, and ${BASELINE} does not exist either. One of the two ` +
        `has to: a first landing records its own baseline so the check runs, and ` +
        `a later one compares with the base. See the header of this file.`
    );
  }
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch (error) {
    stop(`${BASELINE} is not readable JSON: ${error.message}`);
  }
  const { problems, notes } = immutabilityProblems({
    before: baseline.records ?? [],
    now: now.records,
    base: BASELINE,
    pinsBefore: baseline.pins ?? null,
    pinsNow: now.pins,
  });
  for (const note of notes) console.log(`NOTE ${note}`);
  if (problems.length > 0) {
    console.error(`FAIL ${SOURCE} against ${BASELINE}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `OK (bootstrap) ${now.records.length} approved version record(s) match ${BASELINE}. ` +
      `This is the weaker claim: the baseline is in this commit too, so it proves the ` +
      `records were not edited without a second edit beside them, and not that they ` +
      `were not edited. Once ${SOURCE} is on ${base} the comparison is with the base ` +
      `and ${BASELINE} can be deleted.`
  );
  process.exit(0);
}

let before;
try {
  before = {
    records: recordsOf(baseSource, base),
    pins: basePins === null ? null : pinsOf(basePins, base),
  };
} catch (error) {
  if (error instanceof Unreadable) {
    stop(`${error.message}. The base revision's records cannot be read, so nothing is proved.`);
  }
  throw error;
}

const { problems, notes, added } = immutabilityProblems({
  before: before.records,
  now: now.records,
  base,
  pinsBefore: before.pins,
  pinsNow: before.pins === null ? null : now.pins,
});

for (const note of notes) console.log(`NOTE ${note}`);

if (problems.length > 0) {
  console.error(`FAIL against ${base} (${commit.slice(0, 12)}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `OK ${before.records.length} approved version${before.records.length === 1 ? "" : "s"} ` +
    `unchanged against ${base} (${commit.slice(0, 12)})` +
    (added.length > 0 ? `, ${added.length} added: ${added.join(", ")}` : "") +
    (before.pins === null ? `, and ${PINS_SOURCE} is new on this branch` : "") +
    "."
);
