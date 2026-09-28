#!/usr/bin/env node
// An approved consent version does not change. Compared against the base
// revision, because nothing inside one commit can say that.
//
// Contract: docs/policy/email-consent-copy-draft.md sections 10, 10.1.
//
// The test file pins the approved document four ways, and every one of those
// pins is a line in a file the same commit can edit. That is what a pin is for:
// it makes the edit appear in the diff as a changed digest rather than as a
// silently different document. It is not immutability.
//
// This compares the bytes instead: the fifty-six approved strings of every
// version that existed at the base, its record, and every section of the
// approved document. Four rounds of review each found a hole under a comparison
// of metadata, so there is no metadata comparison left and no exemption list to
// argue about -- a recomputed digest is invisible here, and a changed word is
// not.
//
// ## The first landing
//
// On the commit that introduces the records there is nothing at the base to
// compare with, and skipping is not checking. So the bootstrap has its own
// baseline: `BASELINE` holds the records and the document as of this branch, and
// while the base has no source file the tree must equal it exactly. That is a
// weaker claim -- two files in one commit rather than one file against a
// revision nobody in this commit can change -- and it is stated as such in the
// output rather than dressed up. It is also validated: a baseline that is empty,
// short, or missing its document is refused, because a bootstrap that passes
// against nothing is the skip this replaced.
//
// Once the source is on the base branch the baseline is ignored, and deleting it
// is the right thing to do in the commit after the merge.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import {
  APPROVED_DOCUMENT,
  CONSENT_COPY_SOURCE as SOURCE,
  Unreadable,
  immutabilityProblems,
  recordsOf,
  sectionsOf,
} from "./check-consent-copy-immutability-core.mjs";

const BASELINE = "docs/policy/email-consent-copy-baseline.json";

const args = process.argv.slice(2);
const flag = (name) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const git = (...argv) =>
  execFileSync("git", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const stop = (message) => {
  console.error(`FAIL ${message}`);
  process.exit(1);
};

const base =
  flag("base") ??
  (process.env.GITHUB_BASE_REF ? `origin/${process.env.GITHUB_BASE_REF}` : "origin/develop");

let commit = null;
try {
  commit = git("rev-parse", "--verify", "--quiet", `${base}^{commit}`).trim();
} catch {
  commit = null;
}

if (commit === null) {
  // Not a pass: the check could not run. In CI that is a failure, because CI is
  // the one place this is the gate and `fetch-depth: 0` is what makes the ref
  // reachable. Locally it is a stated skip -- a clone without the base branch is
  // ordinary, and failing there would only teach people to skip the gate.
  const message =
    `The base revision ${base} is not in this checkout, so an approved version cannot be ` +
    `compared with anything. Fetch it (git fetch origin ${base.replace(/^origin\//, "")}) ` +
    `or pass --base <ref>.`;
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

const read = (what, load) => {
  try {
    return load();
  } catch (error) {
    if (error instanceof Unreadable) {
      stop(
        `${error.message}. This compares what the file states, so a shape it cannot read ` +
          `exactly is a refusal rather than a guess -- a spread, a computed value, a ` +
          `re-export or a second declaration can change a value without the value being ` +
          `written. (${what})`
      );
    }
    throw error;
  }
  return null;
};

const now = {
  records: read("the working tree", () => recordsOf(readFileSync(SOURCE, "utf8"), "the working tree")),
  document: read("the working tree", () =>
    sectionsOf(readFileSync(APPROVED_DOCUMENT, "utf8"), "the working tree")
  ),
};

const report = ({ problems, notes, added, newSections }, against, kind) => {
  for (const note of notes) console.log(`NOTE ${note}`);
  if (problems.length > 0) {
    console.error(`FAIL against ${against}:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  const grew =
    (added.length > 0 ? `, ${added.length} version(s) added: ${added.join(", ")}` : "") +
    (newSections.length > 0 ? `, new section(s): ${newSections.join(", ")}` : "");
  console.log(`OK${kind} every approved version and document section is unchanged against ${against}${grew}.`);
};

const baseSource = atBase(SOURCE);

if (baseSource === null) {
  // The first landing. The baseline is the only thing older than this commit's
  // own edits, so it is required rather than optional, and validated rather than
  // trusted: `{}` used to pass, and the output then claimed a comparison that
  // had not happened.
  if (!existsSync(BASELINE)) {
    stop(
      `${SOURCE} does not exist at ${base}, so no approved version is older than this ` +
        `branch, and ${BASELINE} does not exist either. One of the two has to: a first ` +
        `landing records its own baseline so the check runs, and a later one compares with ` +
        `the base.`
    );
  }
  let baseline;
  try {
    baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
  } catch (error) {
    stop(`${BASELINE} is not readable JSON: ${error.message}`);
  }
  if (!Array.isArray(baseline?.records) || baseline.records.length === 0) {
    stop(`${BASELINE} holds no records, so it would compare this tree with nothing.`);
  }
  if (baseline.records.length !== now.records.length) {
    stop(
      `${BASELINE} holds ${baseline.records.length} version(s) and the tree holds ` +
        `${now.records.length}. On a first landing the baseline is the tree, so a difference ` +
        `is an edit to one of them.`
    );
  }
  if (
    typeof baseline?.document !== "object" ||
    baseline.document === null ||
    Object.keys(baseline.document).length === 0
  ) {
    stop(`${BASELINE} holds no document sections, so the approved document is compared with nothing.`);
  }
  report(
    immutabilityProblems({
      before: baseline.records,
      now: now.records,
      base: BASELINE,
      documentBefore: new Map(Object.entries(baseline.document)),
      documentNow: now.document,
    }),
    BASELINE,
    " (bootstrap)"
  );
  console.log(
    `NOTE the bootstrap is the weaker claim: ${BASELINE} is in this commit too, so it ` +
      `proves the approved bytes were not changed without a second, obvious edit beside ` +
      `them -- not that they were not changed. Once ${SOURCE} is on ${base} the comparison ` +
      `is with the base and ${BASELINE} can be deleted.`
  );
  process.exit(0);
}

const baseDocument = atBase(APPROVED_DOCUMENT);
const before = {
  records: read(base, () => recordsOf(baseSource, base)),
  document: baseDocument === null ? null : read(base, () => sectionsOf(baseDocument, base)),
};

report(
  immutabilityProblems({
    before: before.records,
    now: now.records,
    base,
    documentBefore: before.document,
    documentNow: before.document === null ? null : now.document,
  }),
  `${base} (${commit.slice(0, 12)})`,
  ""
);
