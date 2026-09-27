#!/usr/bin/env node
// An approved consent version's record is not edited. Compared against the base
// revision, because a digest in the tree cannot say that.
//
// Contract: docs/policy/email-consent-copy-draft.md sections 10, 10.1.
//
// The test file pins the approved document three ways -- the whole document, the
// part no version owns, and each version's record and approved body -- and every
// one of those pins is a line in a file the same commit can edit. That is what a
// pin is for: it makes the edit appear in the diff as a changed digest rather than
// as a silently different document. It is not immutability. A commit that edits
// section 4's wording, its version's two digests and the document digest passes
// every test, and a fourteenth-round review said so plainly.
//
// Immutability needs something outside the commit. This reads
// `lib/emailConsentCopy.ts` at the base revision and requires every version that
// existed there to still be there, unchanged, in the same order, with new versions
// appended. The judgement is in the core module beside this one; this supplies the
// two sources and reports.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  CONSENT_COPY_SOURCE as SOURCE,
  immutabilityProblems,
  recordsOf,
} from "./check-consent-copy-immutability-core.mjs";

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

if (commit === null) {
  // Not a pass: the check could not run. In CI that is a failure, because CI is
  // the one place this is the gate and `fetch-depth: 0` is what makes the ref
  // reachable. Locally it is a stated skip -- a clone without the base branch is
  // ordinary, and failing there would only teach people to skip the gate.
  const message =
    `The base revision ${base} is not in this checkout, so an approved version's ` +
    `record cannot be compared with anything. Fetch it (git fetch origin ` +
    `${base.replace(/^origin\//, "")}) or pass --base <ref>.`;
  if (process.env.CI) {
    console.error(`FAIL ${message}`);
    process.exit(1);
  }
  console.log(`SKIPPED ${message}`);
  process.exit(0);
}

let baseSource;
try {
  baseSource = git("show", `${commit}:${SOURCE}`);
} catch {
  console.log(
    `SKIPPED ${SOURCE} does not exist at ${base}, so no approved record is older ` +
      `than this branch. Nothing to compare.`
  );
  process.exit(0);
}

const before = recordsOf(baseSource, base);
const { problems, notes, added } = immutabilityProblems({
  before,
  now: recordsOf(readFileSync(SOURCE, "utf8"), "the working tree"),
  base,
});

for (const note of notes) console.log(`NOTE ${note}`);

if (problems.length > 0) {
  console.error(`FAIL ${SOURCE} against ${base} (${commit.slice(0, 12)}):`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `OK ${before.length} approved version${before.length === 1 ? "" : "s"} unchanged ` +
    `against ${base} (${commit.slice(0, 12)})` +
    (added.length > 0 ? `, ${added.length} added: ${added.join(", ")}` : "") +
    "."
);
