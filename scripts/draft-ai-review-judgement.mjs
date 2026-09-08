// Prepare a judgement record for a person to fill in, and check one they have.
//
// docs/ops/ai-review-eval-scoring-contract.md.
//
//   npm run draft:ai-review-judgement -- --dir <directory>
//
// The directory is the one `score:ai-review-judgements` reads:
//
//   case.json         the case, its requirement catalogue and its gold
//   observation.json  the reviewer output that was read
//   record.json       written here as a skeleton, filled in by a person
//
// ## What this does NOT do
//
// **It does not judge.** It cannot: every axis this contract added exists
// because the question needs reading -- which answer, missing or present, a
// finding or an explanation, enough or too vague. A tool that guessed at them
// would be the keyword scorer again, wearing new field names.
//
// What it does is the part that is not judgement. It enumerates the submitted
// findings so none is skipped, writes one `pending` claim per submitted item
// with its provenance already correct, states the extraction rules beside the
// work, and -- once a person has filled it in -- runs the same checks the
// scorer runs and says what is still missing.
//
// Nothing here calls a provider.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
    AI_REVIEW_SCORING_CONTRACT_VERSION,
    judgedCaseShapeProblems,
    judgementRecordShapeProblems,
    observationRefFor,
    observationShapeProblems,
    validateJudgedCase,
    verifyJudgementRecord,
    verifyRecordAgainstObservation,
} from "../lib/aiReviewEvalJudgement.ts";

/**
 * A named argument, in either form the header documents.
 *
 * `--dir=<path>` and `--dir <path>` both work. Only the first was accepted,
 * while every usage line in this repository writes the second -- so the
 * documented command failed with "--dir=<directory> is required", which reads
 * as the argument being absent rather than being spelled the other way.
 * A following token starting with `--` is the next flag, never this value.
 */
const argValue = (name) => {
    const args = process.argv.slice(2);
    const inline = args.find((argument) => argument.startsWith(`--${name}=`));
    if (inline !== undefined) return inline.slice(name.length + 3);
    const at = args.indexOf(`--${name}`);
    if (at === -1) return undefined;
    const next = args[at + 1];
    return next === undefined || next.startsWith("--") ? undefined : next;
};

const die = (message) => {
    console.error(message);
    process.exit(1);
};

const directory = argValue("dir");
if (!directory) die("--dir=<directory> is required.");
const root = resolve(process.cwd(), directory);

const readJson = (name) => {
    const path = join(root, name);
    if (!existsSync(path)) die(`${join(directory, name)} does not exist.`);
    try {
        return JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
        die(`${join(directory, name)} is not valid JSON: ${error.message}`);
    }
    return undefined;
};

const testCase = readJson("case.json");
const observation = readJson("observation.json");

const shape = [
    ...judgedCaseShapeProblems(testCase),
    ...observationShapeProblems(observation),
];
if (shape.length > 0) {
    console.log("file shapes");
    for (const problem of shape) console.log(`  - ${problem}`);
    die("\nNothing was read further.");
}
const registration = validateJudgedCase(testCase);
if (registration.length > 0) {
    console.log("case registration");
    for (const problem of registration) console.log(`  - ${problem}`);
    die("\nFix the case before judging against it.");
}

// The rules, printed beside the work rather than kept in a document nobody has
// open. Each one is a decision that was made because getting it wrong produced
// a wrong number -- see the contract's own sections.
const RULES = [
    "One claim per INDEPENDENT assertion. A submission naming two faults gets two.",
    "Never merge opposite assertions under one claim: the triple is a key, not a licence.",
    "Grounds, explanation and quotation inside a submitted finding get role: \"support\".",
    "role: \"support\" only excludes a claim when an independent claim sits in the SAME item.",
    "A submission that is only a quotation is a finding. Leave it role: \"finding\".",
    "A finding aimed at a gold requirement that names nothing: sufficiency: \"insufficient\".",
    "Do not use \"insufficient\" for something outside the gold -- that is outsideGoldVerdict.",
    "A claim about a triple the gold does not contain needs an outsideGoldVerdict.",
    "status stays \"pending\" until a person confirms it, with a name and a time.",
];

const recordPath = join(root, "record.json");

if (!existsSync(recordPath)) {
    const claims = [];
    for (const [kind, items] of Object.entries(observation.findings ?? {})) {
        for (const [index, item] of (items ?? []).entries()) {
            claims.push({
                targetLabel: "",
                requirementId: "",
                assertion: "missing",
                speechAct: "finding",
                submittedAs: kind,
                sourceIndex: index,
                // Not filled in: the quote is the sentence the judgement rests
                // on, and choosing it is reading. The submitted item is echoed
                // beside it so the person has it in front of them.
                evidenceQuote: "",
                role: "finding",
                sufficiency: "sufficient",
                status: "pending",
                confirmedBy: null,
                confirmedAt: null,
                _submittedText: item,
            });
        }
    }
    const skeleton = {
        caseId: testCase.caseId,
        contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
        // Derived, not judged, so it is filled in here. A hand-written
        // reference is a label, and a label keeps matching after the thing it
        // points at has changed; the scorer compares this against the same
        // digest and refuses when they differ.
        observationRef: observationRefFor(observation),
        reviewedBy: "",
        reviewedAt: "",
        sourceCaseDigest: testCase.sourceCaseDigest,
        claims,
        _rules: RULES,
    };
    writeFileSync(recordPath, `${JSON.stringify(skeleton, null, 2)}\n`, "utf8");
    console.log(`\nWrote ${join(directory, "record.json")}: ${claims.length} submitted `
        + `finding(s), one pending claim each.\n`);
    console.log("Split any submission that makes more than one assertion into more claims.");
    console.log("Remove the `_submittedText` and `_rules` keys when the record is filled in.\n");
    for (const rule of RULES) console.log(`  - ${rule}`);
    console.log("\nNo provider was called.");
    process.exit(0);
}

// A record already exists. Say what is still missing, and nothing else -- this
// script never edits a judgement somebody has started.
const record = readJson("record.json");
const scratch = ["_submittedText", "_rules"];
const leftovers = [];
if (Array.isArray(record?.claims)) {
    for (const [index, claim] of record.claims.entries()) {
        for (const key of scratch) {
            if (claim && typeof claim === "object" && key in claim) {
                leftovers.push(`record.json: claims[${index}].${key} is still there`);
            }
        }
    }
}
if (record && typeof record === "object" && "_rules" in record) {
    leftovers.push("record.json: _rules is still there");
}

const problems = [
    ...judgementRecordShapeProblems(record),
    ...leftovers,
];
const deeper =
    problems.length === 0
        ? [
              // The same comparison the scorer makes, including the output
              // reference. Without it this script said "nothing is missing"
              // about a record the scorer then refused -- a checker that
              // passes what the real check fails is worse than no checker.
              ...verifyJudgementRecord(testCase, record, {
                  observationRef: observationRefFor(observation),
              }),
              ...verifyRecordAgainstObservation(observation, record),
          ]
        : [];

const all = [...problems, ...deeper];
console.log(`\n${join(directory, "record.json")} exists; it was not changed.\n`);
if (all.length === 0) {
    console.log("Nothing is missing. Score it with:");
    console.log(`  npm run score:ai-review-judgements -- --dir ${directory}`);
} else {
    console.log("Still to do:");
    for (const problem of all) console.log(`  - ${problem}`);
}
console.log("\nNo provider was called.");
