/**
 * Whether `mem-eval-succ-6` is structurally what its manifest says it is.
 *
 * Two tiers, and the difference between them is the whole point.
 *
 * **Structure** fails immediately. These are the facts a person cannot check
 * by reading — the total, the cell floors, that the ten originals are gone and
 * the ten replacements are present, that the decision set and the regression
 * corpus share no case, that the mapping is one to one, that the preservation
 * split is five corrected and five not, and that `succ-5`'s own digest did not
 * move underneath. A dataset that fails any of them is malformed, not
 * unreviewed.
 *
 * **Readiness** reports and does not fail. `frozen` is false until a person
 * has read the ten replacements and signed the adoption, and no script can do
 * that for them (AGENTS.md: what is left to a person is what only a person can
 * do). Reporting it as a failure would teach the operator to run this with a
 * flag that ignores failures, which is the opposite of what the structure tier
 * is for.
 *
 * Report and gate, not a writer: it changes no dataset, no register and no
 * manifest.
 */

import {
    MEMORY_EVAL_SUCC5_CASES,
    MEMORY_EVAL_SUCC5_MANIFEST,
} from "../lib/memoryEvalSucc5.ts";
import {
    MEMORY_EVAL_SUCC6_CASES,
    MEMORY_EVAL_SUCC6_DATASET_FROZEN,
    MEMORY_EVAL_SUCC6_MANIFEST,
    verifySucc6Manifest,
} from "../lib/memoryEvalSucc6.ts";
import { MEMORY_EVAL_SUCC6_REPLACEMENTS } from "../lib/memoryEvalSucc6Replacements.ts";
import {
    SUCC6_REGRESSION_CORPUS,
    SUCC6_GOLD_CORRECTIONS,
} from "../lib/memoryEvalSucc6Regression.ts";
import {
    SUCC6_REPLACEMENT_SUBTYPES,
    SUCC6_SUPERSEDED_SUBTYPES,
} from "../lib/memoryEvalSucc6Replacements.ts";
import { scoreCaseV3 } from "../lib/memoryEvalScoringV3.ts";
import { nearDuplicatePairs } from "../lib/memoryEvalNearDuplicates.ts";
import { SUCC6_REPLACEMENT_CASE_IDS, SUCC6_TRANSITIONS } from "../lib/memoryEvalSucc6Transition.ts";
import { MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM } from "../lib/memoryExtractionEvalCore.ts";
import {
    SUBTYPE_REVIEW,
    assistantOnlySubtypeFloor,
    unknownSubtypeRows,
} from "../lib/memoryEvalAssistantOnlySubtypes.ts";
import { MEMORY_EVAL_SUCC5_CASES as SUCC5_FOR_FLOOR } from "../lib/memoryEvalSucc5.ts";
import {
    regressionLeakViolations,
    succ6CorrectedGoldEvidenceFailures,
} from "../lib/memoryEvalSucc6Regression.ts";

const failures = [];
const notes = [];
const fail = (line) => failures.push(line);
const ok = (label, detail) =>
    console.log(`OK    ${label.padEnd(46)} ${detail ?? ""}`);

console.log(`\nmem-eval-succ-6 structural check\n${"=".repeat(34)}\n`);

/* ------------------------------------------------------------ the total -- */

const total = MEMORY_EVAL_SUCC6_CASES.length;
if (total !== 1150) fail(`case count is ${total}, and the decision set is 1,150`);
else ok("case count", "1150");

/* ------------------------------------------------------- the cell floors -- */

const cells = {};
for (const testCase of MEMORY_EVAL_SUCC6_CASES) {
    const cell = `${testCase.category}:${testCase.language}`;
    cells[cell] = (cells[cell] ?? 0) + 1;
}
// The floor is per category, not one number: `durable_facts` is 200 and the
// other three are 125. Comparing every cell against a single value would
// either wave 200-cell shortfalls through or fail the 125 cells for being
// themselves.
const short = Object.entries(cells)
    .filter(([cell, count]) => {
        const [category] = cell.split(":");
        return count < MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM[category];
    })
    .map(([cell, count]) => {
        const [category] = cell.split(":");
        return `${cell}=${count} (floor ${MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM[category]})`;
    });
if (short.length > 0) {
    fail(
        `cells below the docs/policy/external-conversation-import-and-memory.md §12.2 ` +
            `floor: ${short.join(", ")}. Ten cases left one category, so this is what ` +
            "a missing replacement looks like."
    );
} else {
    ok(
        "every cell at or above its own floor",
        "durable_facts 200, the rest 125"
    );
}
// The two cells the transitions actually touch, named rather than left to the
// sweep above: they are the ones that would drop, and a reader checking this
// report wants to see them by name.
for (const cell of ["assistant_only:ko", "assistant_only:en"]) {
    ok(`  ${cell}`, String(cells[cell]));
}

/* --------------------------------------------------- in, out and mapping -- */

const ids = new Set(MEMORY_EVAL_SUCC6_CASES.map((testCase) => testCase.id));
const succ5Ids = new Set(MEMORY_EVAL_SUCC5_CASES.map((testCase) => testCase.id));

if (SUCC6_TRANSITIONS.length !== 10) {
    fail(`${SUCC6_TRANSITIONS.length} transitions are recorded, and the decision moved 10`);
} else {
    ok("transitions recorded", "10");
}

for (const transition of SUCC6_TRANSITIONS) {
    if (!succ5Ids.has(transition.originalId)) {
        fail(`${transition.originalId} is superseded and was never a succ-5 case`);
    }
    if (ids.has(transition.originalId)) {
        fail(`${transition.originalId} is superseded and still in the decision set`);
    }
    if (!ids.has(transition.replacementId)) {
        fail(`${transition.replacementId} is its replacement and is not in the set`);
    }
}

const replacementIds = SUCC6_TRANSITIONS.map((t) => t.replacementId);
if (new Set(replacementIds).size !== replacementIds.length) {
    fail("two transitions name the same replacement: the mapping is not one to one");
}
const originalIds = SUCC6_TRANSITIONS.map((t) => t.originalId);
if (new Set(originalIds).size !== originalIds.length) {
    fail("two transitions name the same original: the mapping is not one to one");
}
// Every authored replacement is claimed by a transition, and vice versa. An
// unclaimed replacement is a case nobody can say what it replaced.
const authored = new Set(MEMORY_EVAL_SUCC6_REPLACEMENTS.map((c) => c.id));
for (const id of authored) {
    if (!replacementIds.includes(id)) {
        fail(`${id} is authored as a replacement and no transition names it`);
    }
}
for (const id of replacementIds) {
    if (!authored.has(id)) fail(`${id} is named as a replacement and is not authored`);
}
if (failures.length === 0) ok("one replacement per superseded case", "10 → 10");

/* --------------------------------------------- decision and regression -- */

const regressionIds = new Set(
    SUCC6_REGRESSION_CORPUS.map((entry) => entry.originalCase.id)
);
const overlap = [...regressionIds].filter((id) => ids.has(id));
if (overlap.length > 0) {
    fail(`the decision set and the regression corpus share ${overlap.length}: ${overlap.join(", ")}`);
} else {
    ok("decision ∩ regression", "0");
}
if (regressionIds.size !== 10) {
    fail(`the regression corpus holds ${regressionIds.size} cases, and 10 moved`);
}

/* ------------------------------------------------- the preservation split -- */

const corrected = SUCC6_REGRESSION_CORPUS.filter(
    (entry) => entry.correctionRecord.length > 0
).map((entry) => entry.originalCase.id);
const unchanged = SUCC6_REGRESSION_CORPUS.filter(
    (entry) => entry.correctionRecord.length === 0
).map((entry) => entry.originalCase.id);
if (corrected.length !== 5 || unchanged.length !== 5) {
    fail(
        `preservation split is ${corrected.length} corrected / ${unchanged.length} unchanged, ` +
            "and the decision recorded 5 and 5"
    );
} else {
    ok("preserved with corrected expected", corrected.join(", "));
    ok("preserved unchanged", unchanged.join(", "));
}
if (SUCC6_GOLD_CORRECTIONS.length !== 5) {
    fail(`${SUCC6_GOLD_CORRECTIONS.length} gold corrections are recorded, and the decision made 5`);
}
// No correction may name a case that did not move.
for (const correction of SUCC6_GOLD_CORRECTIONS) {
    if (!regressionIds.has(correction.caseId)) {
        fail(`a gold correction names ${correction.caseId}, which is not in the corpus`);
    }
}

/* ------------------------------------------------------- succ-5 unmoved -- */

if (MEMORY_EVAL_SUCC5_MANIFEST.datasetDigest !== "0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0") {
    fail(
        "succ-5's dataset digest moved. It is frozen and this successor is built on " +
            "top of it, so a change there invalidates both records rather than one."
    );
} else {
    ok("succ-5 digest unmoved", MEMORY_EVAL_SUCC5_MANIFEST.datasetDigest.slice(0, 16) + "…");
}

/* ---------------------------------------------------------- the manifest -- */

for (const problem of verifySucc6Manifest()) fail(`manifest: ${problem}`);
if (MEMORY_EVAL_SUCC6_MANIFEST.datasetDigest === MEMORY_EVAL_SUCC5_MANIFEST.datasetDigest) {
    fail("succ-6 records succ-5's dataset digest: the sample was supposed to change");
} else {
    ok("dataset digest", MEMORY_EVAL_SUCC6_MANIFEST.datasetDigest);
}
ok("scoring contract carried across", `${MEMORY_EVAL_SUCC6_MANIFEST.scoringContractVersion} (unchanged)`);

/* ------------------------------------- a replacement stays in its own cell -- */

// A replacement in another cell would keep the total at 1,150 and move the
// shortfall somewhere else, which the floor check alone would not catch when
// both cells happen to sit above their floor.
const byId = new Map(
    [...MEMORY_EVAL_SUCC5_CASES, ...MEMORY_EVAL_SUCC6_REPLACEMENTS].map((c) => [c.id, c])
);
for (const transition of SUCC6_TRANSITIONS) {
    const original = byId.get(transition.originalId);
    const replacement = byId.get(transition.replacementId);
    if (!original || !replacement) continue;
    if (
        original.category !== replacement.category ||
        original.language !== replacement.language
    ) {
        fail(
            `${transition.replacementId} is ${replacement.category}:${replacement.language} ` +
                `and replaces a ${original.category}:${original.language} case`
        );
    }
}
if (failures.length === 0) ok("every replacement is in its original's cell", "10");

/* -------------------------------- the corrected gold is actually runnable -- */

// §12.2 asks for the corrected gold preserved *in corrected form*, and a kind
// and a polarity in a metadata row are not that. Each corrected case is scored
// against a candidate built from its own gold: if it does not match, the
// record is a note rather than a regression case.
for (const entry of SUCC6_REGRESSION_CORPUS) {
    if (entry.correctionRecord.length === 0) {
        if (entry.regressionCase !== entry.originalCase) {
            fail(`${entry.originalCase.id} has no correction and a rebuilt case`);
        }
        continue;
    }
    const gold = entry.regressionCase.expected[0];
    if (!gold) {
        fail(`${entry.originalCase.id} is corrected and its case carries no gold`);
        continue;
    }
    const outcome = scoreCaseV3(entry.regressionCase, [
        {
            kind: gold.kind,
            polarity: gold.polarity,
            statement: entry.correctionRecord[0].establishes,
            bulkSafe: true,
            disposition: "accepted",
            evidence: [
                {
                    evidenceMessageId: gold.evidence.evidenceMessageId,
                    evidenceQuote: gold.evidence.evidenceQuote,
                },
            ],
        },
    ]);
    if (outcome.goldMatched !== outcome.goldTotal) {
        fail(
            `${entry.originalCase.id}: its own corrected gold does not match a candidate ` +
                `built from it, so nothing can score this regression case`
        );
    }
    // The original is never edited in place.
    if (entry.originalCase.expected.length !== 0) {
        fail(`${entry.originalCase.id}: the preserved original was rewritten`);
    }
}
ok("corrected regression cases score", `${corrected.length} runnable`);

// Scoring and anchoring are different questions, and the first version of this
// corpus passed the first while failing the second: `succ-assistant-en-10`
// required the token `swimming` against the quote "I'm not going back.", which
// `goldEvidenceFailure()` rejects as `gold-evidence-covers-fact`. Nothing was
// looking, because every check written for the corpus asked whether the gold
// scored.
const evidenceFailures = succ6CorrectedGoldEvidenceFailures();
if (evidenceFailures.length > 0) {
    for (const failure of evidenceFailures) {
        fail(
            `${failure.caseId} gold ${failure.goldId}: ${failure.failure} — the corrected ` +
                "gold cannot be anchored, so no scorer can run it"
        );
    }
} else {
    ok("corrected golds anchor", `${corrected.length} × goldEvidenceFailure()`);
}

// A leak the score cannot see. `candidateMatchesGoldV3()` is monotone in
// words, so a statement naming the withheld value scores 1/1 against the very
// gold written to keep it out. The prohibition is a separate layer and this
// asserts it is actually wired, not merely declared: each forbidden value is
// pushed through a statement that matches the gold and names it.
let leakChecks = 0;
for (const entry of SUCC6_REGRESSION_CORPUS) {
    for (const [index, correction] of entry.correctionRecord.entries()) {
        for (const forbidden of correction.forbiddenValues ?? []) {
            const gold = entry.regressionCase.expected[index];
            const leaking = {
                kind: gold.kind,
                polarity: gold.polarity,
                statement: `${gold.factValueAll.join(" ")} ${gold.factValueAny?.[0] ?? ""} ${forbidden}`,
            };
            const violations = regressionLeakViolations(entry, leaking);
            if (!violations.some((v) => v.forbiddenValue === forbidden)) {
                fail(
                    `${correction.caseId}: a statement naming the withheld ${forbidden} is not ` +
                        "reported as a leak, so the prohibition is declared and not enforced"
                );
            }
            if (!violations.some((v) => v.scoredAsMatch)) {
                fail(
                    `${correction.caseId}: the leaking statement does not score, so this check ` +
                        "is not exercising the case the prohibition exists for"
                );
            }
            // And a clean statement must not be reported.
            const clean = { ...leaking, statement: leaking.statement.replace(forbidden, "") };
            if (regressionLeakViolations(entry, clean).length > 0) {
                fail(`${correction.caseId}: a statement without the withheld value is reported as a leak`);
            }
            leakChecks += 1;
        }
    }
}
ok("withheld values rejected by the prohibition", `${leakChecks} value(s), leak scores as a match`);

// The two privacy-preference golds may not require the value the user
// withheld. Checked as an absence rather than trusted to the comment.
const WITHHELD = {
    "succ-assistant-ko-23": ["강서구", "서울"],
    "succ-assistant-en-311": ["lisbon"],
};
for (const correction of SUCC6_GOLD_CORRECTIONS) {
    const withheld = WITHHELD[correction.caseId];
    if (!withheld) continue;
    if (!correction.withheldValueMustNotAppear) {
        fail(`${correction.caseId} withholds a value and is not flagged`);
    }
    const tokens = [
        ...correction.expected.factValueAll,
        ...(correction.expected.factValueAny ?? []),
    ].map((t) => t.toLowerCase());
    for (const value of withheld) {
        if (tokens.some((t) => t.includes(value.toLowerCase()))) {
            fail(
                `${correction.caseId}'s gold requires "${value}", which is the value the ` +
                    "user withheld: only a sentence repeating it could satisfy this gold"
            );
        }
    }
}
ok("withheld values absent from their golds", "2 checked");

/* ------------------------------------------------------------- subtypes -- */

// Declared, not inferred. A keyword classifier over this cell left 66 of 125
// unclassified and failed to recognise the cases written here, so the cell-wide
// floor of docs/ops/memory-extraction-eval-dataset.md §3.3 is a reviewer's
// judgement and is reported below rather than gated. What *is* mechanical is
// the like-for-like comparison: the replacements must not carry fewer hard
// subtypes than the cases they replace.
const hard = (subtype) => subtype === 3 || subtype === 4;
for (const [cellLang, label] of [["ko", "assistant_only:ko"], ["en", "assistant_only:en"]]) {
    const out = SUCC6_TRANSITIONS.filter((t) => t.originalId.includes(`-${cellLang}-`));
    const leftHard = out.filter((t) => hard(SUCC6_SUPERSEDED_SUBTYPES[t.originalId])).length;
    const arrivedHard = out.filter((t) => hard(SUCC6_REPLACEMENT_SUBTYPES[t.replacementId])).length;
    if (arrivedHard < leftHard) {
        fail(
            `${label}: ${leftHard} subtype 3/4 cases left and only ${arrivedHard} arrived, ` +
                "so the cell's hard-case share fell"
        );
    } else {
        ok(`${label} subtype 3/4, out → in`, `${leftHard} → ${arrivedHard}`);
    }
}
for (const [id, subtype] of Object.entries(SUCC6_REPLACEMENT_SUBTYPES)) {
    if (![1, 2, 3, 4].includes(subtype)) fail(`${id} declares subtype ${subtype}`);
}

/* ------------------------------------------------------ near duplicates -- */

// Reported, never gated: docs/ops/memory-extraction-eval-dataset.md §6.5 makes
// diversity a reviewer's call, and a threshold here would decide it for them.
const pairs = nearDuplicatePairs(MEMORY_EVAL_SUCC6_CASES)
    .filter(
        (pair) =>
            SUCC6_REPLACEMENT_CASE_IDS.has(pair.a) ||
            SUCC6_REPLACEMENT_CASE_IDS.has(pair.b)
    )
    .slice(0, 8);
notes.push(
    pairs.length === 0
        ? "No near-duplicate pair involving a replacement was reported."
        : "Near-duplicate pairs involving a replacement, highest first — a reviewer " +
          "decides whether any is too close:\n" +
          pairs
              .map(
                  (pair) =>
                      `        token ${pair.token.toFixed(2)}  shape ${pair.shape.toFixed(2)}  ${pair.a} ~ ${pair.b}`
              )
              .join("\n")
);
/* ----------------------------------------------- the docs/ops/memory-extraction-eval-dataset.md §3.3 subtype floor -- */

// A row naming a case the dataset does not hold is the one part of this a
// check can settle, and it fails: a stale row lowers the count silently.
const stale = unknownSubtypeRows(MEMORY_EVAL_SUCC6_CASES);
if (stale.length > 0) {
    fail(
        `the subtype table names ${stale.length} case(s) succ-6 does not hold: ` +
            `${stale.join(", ")}`
    );
} else {
    ok("subtype table rows all resolve", "no stale ids");
}

// The floor itself reports. It rests on a reading of 250 conversations, and a
// gate over that reading would fail the build on one person's judgement of a
// handful of borderline cases.
const floorRows = assistantOnlySubtypeFloor(MEMORY_EVAL_SUCC6_CASES);
const succ5Rows = new Map(
    assistantOnlySubtypeFloor(SUCC5_FOR_FLOOR).map((row) => [row.cell, row])
);
const floorLines = floorRows.map((row) => {
    const before = succ5Rows.get(row.cell);
    const delta = before ? row.hard - before.hard : 0;
    return (
        `        ${row.cell.padEnd(20)} ${String(row.hard).padStart(3)}/${row.floor}` +
        `  (3:${row.subtype3.length} 4:${row.subtype4.length})` +
        `  succ-5 was ${before ? before.hard : "?"}${delta >= 0 ? " +" : " "}${delta}` +
        `  ${row.meetsFloor ? "MEETS" : `SHORT BY ${row.shortfall}`}`
    );
});
notes.push(
    "docs/ops/memory-extraction-eval-dataset.md §3.3 asks each assistant_only cell " +
        "for at least 30% in subtypes 3 and 4 — 38 of 125. Measured against the " +
        `declared table in lib/memoryEvalAssistantOnlySubtypes.ts (status: ${SUBTYPE_REVIEW.status}):\n` +
        floorLines.join("\n") +
        "\n\n        NEITHER CELL MEETS IT, and neither did succ-5: the shortfall is " +
        "inherited, not introduced. The ten B+ replacements moved both cells toward " +
        "the floor rather than away from it. Closing the remaining gap means changing " +
        "cases the B+ decision did not touch, which is a decision outside this " +
        "dataset's scope. The table is an AI draft and the margin is a few rows wide, " +
        "so confirming or correcting it is the first step, not the last."
);

/* ------------------------------------------------------------ readiness -- */

if (!MEMORY_EVAL_SUCC6_DATASET_FROZEN) {
    notes.push(
        "FROZEN=false — the ten replacements have not been reviewed and the adoption " +
            "is unsigned. Structure passing is not adoption; a decision-grade run against " +
            "an unfrozen decision sample is refused by `decideEvalRunMode()`, and that " +
            "refusal is what this state is for."
    );
}

console.log("");
for (const note of notes) console.log(`NOTE  ${note}\n`);

if (failures.length > 0) {
    console.error(`\n${failures.length} structural problem(s):\n`);
    for (const problem of failures) console.error(`  ${problem}`);
    console.error("");
    process.exit(1);
}
console.log(
    `All structural checks hold. Readiness: ${
        MEMORY_EVAL_SUCC6_DATASET_FROZEN ? "frozen" : "not frozen (see NOTE)"
    }.\n`
);
