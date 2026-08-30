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
import { SUCC6_TRANSITIONS } from "../lib/memoryEvalSucc6Transition.ts";
import { MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM } from "../lib/memoryExtractionEvalCore.ts";

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
    SUCC6_REGRESSION_CORPUS.map((entry) => entry.supersededCase.id)
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
    (entry) => entry.corrections.length > 0
).map((entry) => entry.supersededCase.id);
const unchanged = SUCC6_REGRESSION_CORPUS.filter(
    (entry) => entry.corrections.length === 0
).map((entry) => entry.supersededCase.id);
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
