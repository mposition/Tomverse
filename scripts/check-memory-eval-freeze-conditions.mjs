/**
 * The seven freeze conditions of docs/ops/memory-extraction-eval-dataset.md §7.1,
 * checked rather than asserted.
 *
 *   npm run check:memory-eval-freeze
 *
 * That section lists what has to be true before `MEMORY_EVAL_DATASET_FROZEN`
 * may be set, and the section after it makes freezing a three-line edit.
 * Nothing stopped those three lines from being written while a condition was
 * unmet, and a frozen dataset is precisely the thing a verdict gets cited
 * against — so the freeze would have been believed.
 *
 * Two of the seven were already enforced elsewhere (the floors by the harness,
 * the duplicate check by `findDuplicateCases()`), and the remaining five lived
 * only in prose. This runs all seven in one place and exits non-zero on any
 * miss, so the condition list and the constant cannot drift apart.
 *
 * It reads; it writes nothing. Adoption, review and the freeze itself stay
 * human acts recorded in the batch records and the freeze table.
 */

import { readFileSync } from "node:fs";
import { ADOPTED_BATCHES } from "../lib/memoryExtractionEvalAdopted/index.ts";
import { CANDIDATE_BATCHES } from "../lib/memoryExtractionEvalCandidates/index.ts";
import {
    draftDisagreementRate,
    parseBatchRecord,
    promotionBlockers,
} from "../lib/memoryEvalBatchRecord.ts";
import {
    MEMORY_EVAL_CASES,
    MEMORY_EVAL_DATASET_FROZEN,
    MEMORY_EVAL_DATASET_VERSION,
} from "../lib/memoryExtractionEvalFixtures.ts";
import {
    MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM,
    findDuplicateCases,
} from "../lib/memoryExtractionEvalCore.ts";
import {
    LEGACY_DATASET_SCHEMA_VERSION as DATASET_SCHEMA_VERSION,
    LEGACY_DIAGNOSTIC_DATASET_VERSIONS,
    legacyDatasetRefusal,
} from "../lib/memoryEvalLegacyDataset.ts";

/** The value of a named table row, stripped of the sheet's own annotations. */
const cell = (source, label) => {
    const match = new RegExp(`\\| ${label}[^|]*\\|([^|]*)\\|`).exec(source);
    if (!match) return "";
    return match[1]
        .replace(/\*\([^)]*\)\*/g, "")
        .replace(/[`*]/g, "")
        .trim();
};

const records = ADOPTED_BATCHES.map((batch) => ({
    batch,
    source: readFileSync(batch.record, "utf8"),
    record: parseBatchRecord(readFileSync(batch.record, "utf8")),
}));

const results = [];
const check = (condition, detail, ok) =>
    results.push({ condition, detail, ok });

/* --- ① cell floors — docs/policy/external-conversation-import-and-memory.md §12.2 --- */
{
    const counts = new Map();
    for (const testCase of MEMORY_EVAL_CASES) {
        const key = `${testCase.category}:${testCase.language}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const short = [...counts]
        .filter(
            ([key, count]) =>
                count < MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM[key.split(":")[0]]
        )
        .map(([key, count]) => `${key} ${count}`);
    check(
        "cell floors",
        short.length === 0
            ? `${MEMORY_EVAL_CASES.length} cases across ${counts.size} cells`
            : `below floor: ${short.join(", ")}`,
        short.length === 0
    );
}

/* --- ② no batch left unreviewed ------------------------------------------- */
// Only batches drafted FOR this dataset. A batch that declares itself the
// successor of this version is not waiting to join it -- it exists because
// this version is finished and its scoring contract was superseded -- so it
// says nothing about whether this one is frozen.
const pendingForThisDataset = CANDIDATE_BATCHES.filter(
    (batch) => batch.successorTo !== MEMORY_EVAL_DATASET_VERSION
);
const successorBatches = CANDIDATE_BATCHES.length - pendingForThisDataset.length;
check(
    "no batch left unreviewed",
    `${pendingForThisDataset.length} candidate batch(es)` +
        (successorBatches > 0
            ? `, plus ${successorBatches} for a successor version (not counted)`
            : ""),
    pendingForThisDataset.length === 0
);

/* --- ③ explicit adoption, verdicts, diversity and a date on every batch ---- */
{
    const blocked = records
        .map(({ batch, record }) => ({
            batch,
            blockers: promotionBlockers(record, batch.cases.length),
        }))
        .filter((entry) => entry.blockers.length > 0);
    check(
        "explicit adoption + verdicts + diversity + date on every batch",
        blocked.length === 0
            ? `${records.length} batches`
            : blocked
                  .map((e) => `${e.batch.id}: ${e.blockers.join("; ")}`)
                  .join(" | "),
        blocked.length === 0
    );
}

/* --- ④ draft disagreement on every batch — docs/ops/memory-extraction-eval-dataset.md §6.4 --- */
{
    const rates = records.map(({ batch, record }) => ({
        batch,
        rate: draftDisagreementRate(record),
    }));
    const missing = rates.filter((entry) => entry.rate === null);
    const highest = Math.max(0, ...rates.map((entry) => entry.rate ?? 0));
    check(
        "draft disagreement recorded for every batch",
        missing.length === 0
            ? `max ${Math.round(highest * 100)}%`
            : `no judged case in ${missing.map((e) => e.batch.id).join(", ")}`,
        missing.length === 0
    );
}

/* --- ⑤ findDuplicateCases() ----------------------------------------------- */
{
    const duplicates = findDuplicateCases(MEMORY_EVAL_CASES);
    check(
        "findDuplicateCases()",
        duplicates.length === 0
            ? "0"
            : `${duplicates.length}: ${duplicates.slice(0, 3).join(", ")}`,
        duplicates.length === 0
    );
}

/* --- ⑥ drafting tool, model and version — docs/ops/memory-extraction-eval-dataset.md §6.5 --- */
{
    const incomplete = records.filter(
        ({ source }) =>
            !/^ai-draft:[^/\s]+\/[^/\s]+\/[^/\s]+$/.test(cell(source, "초안 생성자"))
    );
    check(
        "초안 도구·모델·버전 기록",
        incomplete.length === 0
            ? `${records.length}/${records.length}`
            : `${incomplete.length}건 미완: ${incomplete
                  .map((e) => e.batch.id)
                  .join(", ")}`,
        incomplete.length === 0
    );
}

/* --- ⑦ a named reviewer on every batch ------------------------------------ */
{
    const missing = records.filter(({ source }) => !cell(source, "검수자"));
    check(
        "검수자 기록",
        missing.length === 0
            ? `${records.length}/${records.length}`
            : missing.map((e) => e.batch.id).join(", "),
        missing.length === 0
    );
}

/* ------------------------------------------------- schema, fail-closed -- */

// A freeze is one of the three uses the 2026-08-25 amendment closed to the
// legacy schema, alongside a decision-grade run and a pair approval: a
// dataset with no `expectedDisposition` and no `goldCompleteness` cannot
// support the metrics the amendment added, so freezing one would be freezing
// a sample nothing can score.
//
// `mem-eval-seed-11` is exempt because its freeze already happened, on
// 2026-08-24, under the contract in force then. That is a fixed list of one,
// not a rule: it grandfathers a historical fact and admits nothing new. A
// second schema-1 dataset cannot be frozen by adding itself to it -- the
// entry would have to be written here, deliberately, and there is no reason
// to write one.
const schemaRefusal = legacyDatasetRefusal({
    datasetVersion: MEMORY_EVAL_DATASET_VERSION,
    schemaVersion: DATASET_SCHEMA_VERSION,
    use: "freeze",
});
const schemaExempt = LEGACY_DIAGNOSTIC_DATASET_VERSIONS.includes(
    MEMORY_EVAL_DATASET_VERSION
);

/* ----------------------------------------------------------------- report -- */

console.log(
    `Freeze conditions for ${MEMORY_EVAL_DATASET_VERSION} ` +
        `(currently ${MEMORY_EVAL_DATASET_FROZEN ? "frozen" : "not frozen"})\n`
);
for (const result of results) {
    console.log(
        `${result.ok ? "OK  " : "MISS"}  ${result.condition}  — ${result.detail}`
    );
}

const missed = results.filter((result) => !result.ok);
if (missed.length === 0) {
    console.log(`\nAll ${results.length} conditions hold.`);
} else {
    console.log(
        `\n${missed.length} of ${results.length} conditions unmet. ` +
            "docs/ops/memory-extraction-eval-dataset.md §7.1 asks for all of them."
    );
}

// Unmet conditions are only a failure once the constant claims otherwise.
// Before the freeze this script is a progress report, and exiting non-zero on
// a half-authored dataset would make it useless during the months it is most
// worth running.
if (MEMORY_EVAL_DATASET_FROZEN && missed.length > 0) {
    console.error(
        "\nMEMORY_EVAL_DATASET_FROZEN is true while a freeze condition is unmet."
    );
    process.exit(1);
}

if (MEMORY_EVAL_DATASET_FROZEN && schemaRefusal && !schemaExempt) {
    console.error(`\n${schemaRefusal.detail}`);
    console.error(
        "A dataset that cannot be scored under the current contract cannot be frozen for it."
    );
    process.exit(1);
}

if (schemaRefusal && schemaExempt) {
    console.log(
        `\nNote: ${MEMORY_EVAL_DATASET_VERSION} is schema ${DATASET_SCHEMA_VERSION}. ` +
            "Its freeze predates the 2026-08-25 scoring amendment and is kept as a\n" +
            "historical fact; it cannot support a decision-grade run, and the harness\n" +
            "refuses one (legacy_dataset_schema)."
    );
}
