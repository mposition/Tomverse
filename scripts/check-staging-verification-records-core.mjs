// The parts of the staging verification record check that are pure text.
//
// Split out so they can be tested without importing the checker, which runs its
// whole audit at import time. The line-ending handling below is the reason this
// file exists: it was wrong for as long as the check had existed and nobody
// could see it, because CI and every agent container check out LF.

import { createHash } from "node:crypto";

/**
 * The same document however git checked it out.
 *
 * Every read below was line-ending sensitive, and the failure was total rather
 * than partial: on a `core.autocrlf` checkout the front-matter regex matched
 * nothing at all -- `.` does not match `\r` and `$` does not sit before one --
 * so a fully filled record reported "no executor", "no result" and
 * "templateRevision (none)". The check ran correctly only on LF checkouts, and
 * said the records were blank on the platform most likely to be writing them.
 *
 * The digest matters more. It covers the body, so without this the same
 * committed bytes hash differently depending on the checkout, and a record
 * frozen on one machine reads as edited on another -- tamper evidence that
 * fires on `git clone`. Normalising to LF leaves every existing digest
 * unchanged, because they were computed where the checkout was already LF.
 */
export const normalizeLineEndings = (text) => text.replace(/\r\n?/g, "\n");

/** Everything after the front matter, which is what a digest covers. */
export const bodyOf = (raw) => {
  const text = normalizeLineEndings(raw);
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("---", 3);
  return end === -1 ? text : text.slice(end + 4);
};


export const frontMatter = (raw) => {
  const text = normalizeLineEndings(raw);
  const fields = new Map();
  if (!text.startsWith("---")) return fields;
  const end = text.indexOf("---", 3);
  if (end === -1) return fields;
  for (const line of text.slice(4, end).split("\n")) {
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (match) fields.set(match[1], match[2].trim().replace(/^"|"$/g, ""));
  }
  return fields;
};

export const recordDigest = (text) =>
  createHash("sha256").update(bodyOf(text), "utf8").digest("hex").slice(0, 32);

/**
 * What a run quoted to approve an activation has to name, beyond its SHA.
 *
 * A commit SHA does not identify a build. Dependency resolution, the builder
 * version and the build environment can all move between two deployments of
 * the same commit, so a record naming only the SHA cannot point at the thing
 * it actually exercised. The migration set is the other half: the same code
 * against a different set is a different system.
 *
 * Only `formal` is held to this. A record with no `runType` either predates
 * the field or belongs to a feature whose template has not adopted it, and a
 * requirement invented for those would fail the check on records nobody can go
 * back and fill in.
 *
 * Pure, and returns messages rather than throwing, so the checker can collect
 * them alongside everything else it found.
 */
export const formalRunProblems = (fields, path) => {
  if (fields.get("runType") !== "formal") return [];
  const problems = [];
  if (!fields.get("deploymentId") && !fields.get("artifactDigest")) {
    problems.push(
      `${path}  is a formal run with neither deploymentId nor artifactDigest. ` +
        `The same SHA can build twice; without one of these the record cannot ` +
        `name the build it actually ran against.`
    );
  }
  if (!fields.get("appliedMigrations")) {
    problems.push(
      `${path}  is a formal run that does not name its applied migrations. ` +
        `The same code on a different migration set is a different system.`
    );
  }
  // Which commit the items came from. Routinely not the deployed SHA -- the
  // checklist's history stays on one branch while the verified build is an
  // activation candidate that may have reached production another way. A
  // reader who finds items here that are absent from the deployed tree cannot
  // otherwise tell that intended split from a mistake.
  const source = fields.get("checklistSourceSha");
  if (!source || source === "uncommitted") {
    problems.push(
      `${path}  is a formal run whose checklistSourceSha is ` +
        `${source ? `"${source}"` : "empty"}. The items have to come from a ` +
        `commit someone else can read back, not from a working tree.`
    );
  }
  return problems;
};
