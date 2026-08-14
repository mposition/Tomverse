// Start a staging verification run: a blank record with every checklist item.
//
//   node scripts/new-staging-verification-record.mjs --feature <key> --sha <40 chars> [--date YYYY-MM-DD]
//   node scripts/new-staging-verification-record.mjs --feature <key> --sha <40 chars> --preview
//
// Reads the named feature's checklist (see
// `scripts/staging-verification-features.mjs`) and writes one record under that
// feature's records directory, with one row per item and every result empty.
//
// `--feature` is required rather than defaulted. There are two checklists now,
// and a default would silently write a run of the wrong one -- a record that
// names the right SHA and the wrong items reads as a completed verification.
//
// Generated rather than hand-copied for the reason the split exists at all:
// the blank record told executors to copy "A–G" for eight days after section
// H was added, and a hand-copied item list would drift the same way one row at
// a time. A missing row reads exactly like a section nobody ran.
//
// It refuses to overwrite. A record is a record of one run; a second run is a
// second file.
//
// Fills in nothing a human has to decide: results, evidence, timings,
// signatures and the freeze are all left empty. The full SHA is required and
// is not read from git, because the SHA that matters is what staging is
// actually serving, which this machine has no way to know.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { checklistItems, renderRecord } from "./staging-verification-record-core.mjs";
import {
  STAGING_VERIFICATION_FEATURES,
  stagingVerificationFeature,
} from "./staging-verification-features.mjs";

const argument = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1] ?? null;
};

const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const featureKey = argument("feature");
if (!featureKey) {
  fail(
    "--feature is required. Known features:\n" +
      STAGING_VERIFICATION_FEATURES.map(
        (entry) => `  ${entry.key}  -- ${entry.label}`
      ).join("\n")
  );
}
let feature;
try {
  feature = stagingVerificationFeature(featureKey);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const CHECKLIST = feature.checklist;
const RECORDS = feature.records;
const TEMPLATE = join(RECORDS, "_record-template.md");

const sha = argument("sha");
if (!sha || !/^[0-9a-f]{40}$/.test(sha)) {
  fail(
    "--sha requires the full 40-character commit SHA that staging is serving.\n" +
      "A short SHA sends the next reader looking, and this machine cannot see\n" +
      "which commit staging is actually on."
  );
}

const date = argument("date") ?? new Date().toISOString().slice(0, 10);
if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
  fail("--date must be YYYY-MM-DD.");
}

const checklist = readFileSync(CHECKLIST, "utf8");
const template = readFileSync(TEMPLATE, "utf8");

const revision = /template revision.*?`(\d{4}-\d{2}-\d{2}[a-z]?)`/s.exec(
  checklist
)?.[1];
if (!revision) {
  fail(`${CHECKLIST} declares no template revision; a record cannot say which items it ran.`);
}

const items = checklistItems(checklist);
if (items.length === 0) {
  fail(`${CHECKLIST} yielded no items. Refusing to write an empty record.`);
}

const record = renderRecord({ template, items, date, deploySha: sha, revision });

if (process.argv.includes("--preview")) {
  console.log(record);
  process.exit(0);
}

const path = join(RECORDS, `${date}__${sha}.md`);
if (existsSync(path)) {
  fail(
    `${path} already exists. A record is the record of one run; a second run is\n` +
      "a second file. Nothing here overwrites one."
  );
}
writeFileSync(path, record, "utf8");

console.log(
  `Wrote ${path}\n` +
    `  template revision ${revision}, ${items.length} item(s) from ${CHECKLIST}\n` +
    "  Results, evidence, timings and signatures are blank: fill them in as you go.\n" +
    "  When the run is signed, set `frozen: true` and record the digest with\n" +
    "  `node scripts/check-staging-verification-records.mjs --digest <file>`."
);
