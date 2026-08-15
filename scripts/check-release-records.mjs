// The release checklist holds items; a release run holds results.
//
//   npm run check:release-records
//
// `scripts/release-record-policy.mjs` says why this is its own registry rather
// than a third entry in `staging-verification-features.mjs`, and what each
// rule is for. This file reads the filesystem and prints; every judgement is
// made there.
//
// What it refuses:
//
//   * a ticked box, a build SHA, or a filled header field in the template;
//   * a record not named release-<date>__<sha>.md;
//   * a record that leaves `Release SHA:` blank or short;
//   * a record byte-identical to the template, or with nothing ticked;
//   * unticked boxes with an empty section 8;
//   * a section 8 row whose owner names nobody.
//
// What it deliberately does not refuse: unticked boxes as such. A release can
// ship with items it could not verify -- that is what section 8 is for -- and
// a check that demanded every box would be answered by ticking them.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
    RELEASE_CHECKLIST_TEMPLATE,
    RELEASE_RECORDS_DIR,
    headerFields,
    releaseRecordProblems,
    releaseTemplateProblems,
    tickedBoxes,
    untickedBoxes,
    waiverRows,
} from "./release-record-policy.mjs";

const templateText = readFileSync(RELEASE_CHECKLIST_TEMPLATE, "utf8");

const problems = [...releaseTemplateProblems(templateText)];
const summaries = [];

const names = readdirSync(RELEASE_RECORDS_DIR)
    .filter((name) => name.startsWith("release-") && name.endsWith(".md"))
    .sort();

for (const name of names) {
    const text = readFileSync(join(RELEASE_RECORDS_DIR, name), "utf8");
    problems.push(...releaseRecordProblems(name, text, { templateText }));

    const sha = headerFields(text).get("Release SHA") ?? "(none)";
    summaries.push(
        `${name}: ${sha.slice(0, 8)}, ${tickedBoxes(text).length} ticked, ` +
            `${untickedBoxes(text).length} unticked, ${waiverRows(text).length} owned in section 8`
    );
}

if (names.length === 0) {
    // Not a failure. There is a first release for every repository, and this
    // check running before one has happened should say so rather than invent a
    // rule that the first run then has to argue with.
    summaries.push(
        `no records yet in ${RELEASE_RECORDS_DIR}/release-<date>__<sha>.md`
    );
}

if (problems.length > 0) {
    console.error("Release record check failed.\n");
    for (const problem of problems) console.error(`  ${problem}`);
    console.error(
        `\nCopy ${RELEASE_CHECKLIST_TEMPLATE} to ${RELEASE_RECORDS_DIR}/release-<date>__<sha>.md and fill in the copy.`
    );
    process.exit(1);
}

console.log("Release record check passed.");
for (const summary of summaries) console.log(`  ${summary}`);
