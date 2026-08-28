// Assemble the succ-4 cases that stay, and report what only a person can settle.
//
//   npm run report:memory-eval-succ4-assembly
//   npm run report:memory-eval-succ4-assembly -- --sample
//
// The assembler refuses rather than guesses, so a clean run means every gold
// had a recorded polarity, a recorded mustIncludeAny decision, and an anchor
// that resolves. It does NOT mean the anchors are right: goldEvidenceFailure
// proves a user message, an exact span and the fact's presence, and says
// nothing about whether the quote carries the polarity.
//
// So this reports one diagnostic on top. A negated gold whose quote holds no
// negation marker, while some other user message in the same case does, is the
// shape that put succ-assistant-en-306 on «the checklist has a section on
// sibling carer leave» instead of «I have no siblings». The marker scan cannot
// decide it -- .github/audits/memory-eval-gold-contract-2026-08-27.md §9.2
// disqualified that rule -- but it can point, and here
// it is pointing at anchors rather than at labels.

import { MEMORY_EVAL_SUCC3_CASES } from "../lib/memoryEvalSucc3Fixtures.ts";
import {
    assembleCases,
    containsAll,
    goldKey,
    proposeAnchor,
} from "../lib/memoryEvalSucc4Assembly.ts";
import { SUCC4_ANCHORS } from "../lib/memoryEvalSucc4Review/anchors.ts";
import { SUCC4_READINGS } from "../lib/memoryEvalSucc4Review/readings.ts";
import { canonMatch } from "../lib/memoryEvalCanonicalisation.ts";
import { POLARITY_MARKERS } from "../lib/memoryEvalPolarityCalibration/distance.ts";
import { SUCC4_B_PLUS_MOVES } from "../lib/memoryEvalSucc4Review/bPlusMoves.ts";

const sampleOnly = process.argv.includes("--sample");

const moving = new Set(SUCC4_B_PLUS_MOVES.map((move) => move.originalId));
const staying = MEMORY_EVAL_SUCC3_CASES.filter((testCase) => !moving.has(testCase.id));

// One of each thing that can vary, so a change to the assembler shows up
// against a case that exercises it rather than against the average.
const SAMPLE = [
    "succ-durable-ko-144", // ko, two golds, one affirmed and one negated
    "succ-durable-en-143", // en, two golds off one sentence
    "succ-durable-ko-307", // factValueAny carried over
    "succ-assistant-ko-307", // negated, criticalGoldMode
    "succ-assistant-en-306", // negated, anchor overridden to a later turn
    "succ-durable-ko-1", // sensitive_review
    "succ-injection-ko-119", // critical category carrying a gold
    "succ-durable-ko-104", // two fact values in one gold
];

const chosen = sampleOnly
    ? SAMPLE.map((id) => staying.find((testCase) => testCase.id === id))
    : staying;

const missing = sampleOnly ? SAMPLE.filter((id, index) => !chosen[index]) : [];
if (missing.length > 0) {
    console.error(`sample names cases that are not in the staying set: ${missing.join(", ")}`);
    process.exit(1);
}

const { cases, refusals } = assembleCases(chosen);

console.log(
    `succ-4 assembly — ${chosen.length} cases in, ${cases.length} assembled, ` +
        `${refusals.length} refused\n`
);
if (refusals.length > 0) {
    console.log("## Refusals\n");
    for (const refusal of refusals) console.log(`   ${refusal}`);
    console.log(
        "\nNothing was assembled. A partial dataset is what the assembler exists\n" +
            "to not produce.\n"
    );
    process.exit(1);
}

/* --- the record, and where the proposal has drifted from it ------------ */

// .github/audits/memory-eval-gold-contract-2026-08-27.md §12.11. The assembled
// anchor must be the reviewed one, exactly. This does
// not re-derive it -- re-deriving is what the record replaced -- it checks
// that assembly used the record and nothing else.
const anchorByKey = new Map(SUCC4_ANCHORS.map((anchor) => [anchor.key, anchor]));
const readingByKey = new Map(
    SUCC4_READINGS.filter((reading) => reading.evidenceMessageId).map((reading) => [
        goldKey(reading.caseId, reading.goldId),
        reading,
    ])
);
const mismatched = [];
const drifted = [];
for (const testCase of cases) {
    for (const gold of testCase.expected) {
        const key = goldKey(testCase.id, gold.id);
        const record = readingByKey.get(key) ?? anchorByKey.get(key);
        if (!record) {
            mismatched.push({ key, why: "assembled with no reviewed anchor" });
            continue;
        }
        if (
            gold.evidence.evidenceMessageId !== record.evidenceMessageId ||
            gold.evidence.evidenceQuote !== record.evidenceQuote
        ) {
            mismatched.push({ key, why: "assembled anchor differs from the record" });
            continue;
        }
        // Not adopted, only reported: if the heuristic would now choose
        // differently, the record is what stands and somebody should know the
        // two have parted.
        const proposal = proposeAnchor(testCase, gold.factValueAll);
        if (
            proposal &&
            (proposal.evidenceMessageId !== record.evidenceMessageId ||
                proposal.evidenceQuote !== record.evidenceQuote)
        ) {
            drifted.push({ key, record, proposal });
        }
    }
}

if (mismatched.length > 0) {
    console.log("## Assembled anchor does not match the reviewed record\n");
    for (const row of mismatched) console.log(`   ${row.key}  ${row.why}`);
    console.log();
    process.exitCode = 1;
}

/* --- what the assembler cannot check ---------------------------------- */

const suspect = [];
for (const testCase of cases) {
    const language = testCase.language;
    const markers = POLARITY_MARKERS[language];
    const userMessages = testCase.conversations
        .flatMap((conversation) => conversation.messages)
        .filter((message) => message.role === "user");
    for (const gold of testCase.expected) {
        if (gold.polarity !== "negated") continue;
        const quote = canonMatch(gold.evidence.evidenceQuote, language);
        if (markers.some((marker) => quote.includes(canonMatch(marker, language)))) continue;
        // The quote holds no marker. That is only worth a look when some other
        // user message carrying the fact does -- otherwise the denial is
        // simply phrased without one, which is most of them.
        const elsewhere = userMessages.find(
            (message) =>
                message.externalMessageId !== gold.evidence.evidenceMessageId &&
                containsAll(message.content, gold.factValueAll, language) &&
                markers.some((marker) =>
                    canonMatch(message.content, language).includes(canonMatch(marker, language))
                )
        );
        if (elsewhere) {
            suspect.push({
                key: `${testCase.id}:${gold.id}`,
                anchored: gold.evidence.evidenceQuote,
                elsewhere: elsewhere.content,
            });
        }
    }
}

console.log("## Coverage\n");
const cells = {};
for (const testCase of cases) {
    const cell = `${testCase.category}:${testCase.language}`;
    cells[cell] = (cells[cell] ?? 0) + 1;
}
for (const [cell, count] of Object.entries(cells).sort()) {
    console.log(`   ${String(count).padStart(4)}  ${cell}`);
}
const golds = cases.reduce((total, testCase) => total + testCase.expected.length, 0);
const negated = cases.reduce(
    (total, testCase) =>
        total + testCase.expected.filter((gold) => gold.polarity === "negated").length,
    0
);
const withAny = cases.reduce(
    (total, testCase) => total + testCase.expected.filter((gold) => gold.factValueAny).length,
    0
);
console.log(
    `\n   ${golds} golds — ${negated} negated, ${golds - negated} affirmed, ` +
        `${withAny} with factValueAny\n`
);

console.log("## The automatic proposal against the record\n");
if (drifted.length === 0) {
    console.log("   they agree on all " + cases.reduce((n, c) => n + c.expected.length, 0) + " golds\n");
} else {
    for (const row of drifted) {
        console.log(`   ${row.key}`);
        console.log(`      record   ${row.record.evidenceMessageId} «${row.record.evidenceQuote}»`);
        console.log(`      proposal ${row.proposal.evidenceMessageId} «${row.proposal.evidenceQuote}»`);
    }
    console.log("\n   The record stands. Reported so a heuristic change cannot re-anchor\n   a reviewed gold in silence.\n");
}

console.log("## A negated gold anchored on a quote with no negation in it\n");
if (suspect.length === 0) {
    console.log("   none, where another user message carrying the fact has one\n");
} else {
    for (const row of suspect) {
        console.log(`   ${row.key}`);
        console.log(`      anchored on «${row.anchored}»`);
        console.log(`      but «${row.elsewhere}» is also the user's`);
    }
    console.log(
        "\n   Not a failure. The scan cannot decide a polarity and is not deciding\n" +
            "   one here — it is asking whether the anchor is on the turn that states\n" +
            "   the fact.\n"
    );
}
