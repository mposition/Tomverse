// The staging checklist holds no results, and a finished record is not edited.
//
//   npm run check:staging-verification-records
//   node scripts/check-staging-verification-records.mjs --digest <file>
//
// ## The failure this exists for
//
// The checklist used to carry its own approval table. That table said
// `8c43430` / `통과` / signed, while every checkbox above it was empty — and
// then the release-A surface changed underneath it: a new checklist item for
// seal→finalize, a whole snapshot-lock surface, a settings regrouping. The
// table did not move, because a table cannot say which commit it covers. What
// was left was a signature that read as current and was not.
//
// So the checklist is a template with no results in it, and each run is its
// own file named for the day and the full deploy SHA. This checks that the
// split holds:
//
//   * the template carries no ticked box and no result table;
//   * every record names a full 40-character SHA, in its filename and in its
//     own front matter, and the two agree;
//   * every record declares which template revision it was run against, so a
//     later item is legible as one that did not exist yet;
//   * a record marked `frozen: true` still hashes to its recorded digest.
//
// The digest is a record, not a lock. Anyone can recompute it; doing so is a
// line in a diff that says "this finished record was edited", which is the
// thing that needs to be visible.

import { readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const CHECKLIST = "docs/ops/external-import-staging-checklist.md";
const RECORDS = "docs/ops/staging-verification-records";
const TEMPLATE = "_record-template.md";
const README = "README.md";

const RECORD_NAME = /^(\d{4}-\d{2}-\d{2})__([0-9a-f]{40})\.md$/;

/** Everything after the front matter, which is what a digest covers. */
const bodyOf = (text) => {
  if (!text.startsWith("---")) return text;
  const end = text.indexOf("---", 3);
  return end === -1 ? text : text.slice(end + 4);
};

export const recordDigest = (text) =>
  createHash("sha256").update(bodyOf(text), "utf8").digest("hex").slice(0, 32);

const frontMatter = (text) => {
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

const digestArgument = process.argv.indexOf("--digest");
if (digestArgument !== -1) {
  const path = process.argv[digestArgument + 1];
  if (!path) {
    console.error("--digest needs a file path.");
    process.exit(1);
  }
  console.log(recordDigest(readFileSync(path, "utf8")));
  process.exit(0);
}

const problems = [];

/* ------------------------------------------------ the template is empty */

const checklist = readFileSync(CHECKLIST, "utf8");
const ticked = checklist
  .split("\n")
  .map((line, index) => ({ line, index }))
  .filter(({ line }) => /^\s*-\s*\[[^ \]]\]/.test(line));
for (const { index } of ticked) {
  problems.push(
    `${CHECKLIST}:${index + 1}  a ticked box in the template. Results belong in ${RECORDS}/.`
  );
}
if (/^\|\s*(검증 대상 커밋 SHA|승인자 서명)\s*\|/m.test(checklist)) {
  problems.push(
    `${CHECKLIST}  still carries an approval table. That table is what could not say which commit it covered.`
  );
}
// A date, optionally with a suffix: the items can change twice in a day, and
// a bare date cannot tell those two versions apart -- which is the one thing
// the revision exists to do.
const revision = /template revision.*?`(\d{4}-\d{2}-\d{2}[a-z]?)`/s.exec(checklist);
if (!revision) {
  problems.push(
    `${CHECKLIST}  declares no template revision, so a record cannot say which version of the items it ran.`
  );
}

/* ------------------------------------- the blank record matches the items */

// The drift this catches actually happened: a Gemini section `H` was added to
// the checklist and its revision was bumped, while `_record-template.md` still
// said `A–G` and carried the previous revision. A run started from that
// template would have recorded a revision the checklist no longer had, and
// nobody could tell an execution from before the section was added from one
// after it.
const templatePath = join(RECORDS, TEMPLATE);
const blank = readFileSync(templatePath, "utf8");
const blankRevision = frontMatter(blank).get("templateRevision");
if (revision && blankRevision !== revision[1]) {
  problems.push(
    `${templatePath}  declares templateRevision ${blankRevision ?? "(none)"} ` +
      `while the checklist is at ${revision[1]}. A run started from it would ` +
      `record a revision the checklist does not have.`
  );
}
const sectionsInChecklist = [
  ...checklist.matchAll(/^##\s+([A-Z])\.\s/gm),
].map((match) => match[1]);
if (sectionsInChecklist.length > 0) {
  const first = sectionsInChecklist[0];
  const last = sectionsInChecklist[sectionsInChecklist.length - 1];
  const span = new RegExp(`${first}[–-]${last}\\s*구획`);
  if (!span.test(blank)) {
    problems.push(
      `${templatePath}  does not tell the executor to copy ${first}–${last}, ` +
        `which is what the checklist now has.`
    );
  }
}

/* ---------------------------------------------------- the records hold */

const entries = readdirSync(RECORDS).filter((name) => name.endsWith(".md"));
let records = 0;
let frozen = 0;

for (const name of entries) {
  if (name === TEMPLATE || name === README) continue;
  const path = join(RECORDS, name);
  const matched = RECORD_NAME.exec(name);
  if (!matched) {
    problems.push(
      `${path}  is not named YYYY-MM-DD__<40-character sha>.md. A short SHA sends the reader looking.`
    );
    continue;
  }
  records += 1;
  const text = readFileSync(path, "utf8");
  const fields = frontMatter(text);

  const declared = fields.get("deploySha");
  if (declared !== matched[2]) {
    problems.push(
      `${path}  names ${matched[2]} in its filename and ${declared ?? "nothing"} in its front matter.`
    );
  }
  if (!fields.get("templateRevision")) {
    problems.push(
      `${path}  declares no templateRevision, so a later checklist item cannot be told from one it skipped.`
    );
  }
  // Required whether or not the record is frozen. A blank record in the
  // repository looks official and says nothing, which is the state this whole
  // split exists to prevent -- so a run in progress stays uncommitted until
  // there is something to report. `npm run new:staging-verification-record`
  // writes one; committing it before it is filled in is the mistake.
  for (const required of ["executor", "result"]) {
    if (!fields.get(required)) {
      problems.push(
        `${path}  has no ${required}. A record with none is a blank page that ` +
          `reads as a completed run; keep it out of the repository until the ` +
          `run has an executor and an outcome.`
      );
    }
  }

  if (fields.get("frozen") !== "true") continue;
  frozen += 1;
  const recorded = fields.get("digest");
  const actual = recordDigest(text);
  if (recorded !== actual) {
    problems.push(
      `${path}  is frozen but its body hashes to ${actual}, not the recorded ${recorded ?? "(none)"}. ` +
        `A finished record is not edited; if the change is deliberate, recompute the digest so the diff says so.`
    );
  }
}

if (problems.length > 0) {
  console.error("Staging verification record check failed.\n");
  for (const problem of problems) console.error(`  ${problem}`);
  console.error(
    `\nSee ${RECORDS}/README.md. The checklist holds items; a run holds results.`
  );
  process.exit(1);
}

console.log(
  `Staging verification record check passed: template revision ${revision[1]}, ` +
    `${records} record(s), ${frozen} frozen and matching their digest.`
);
