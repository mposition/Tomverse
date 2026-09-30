/**
 * The freeze conditions of docs/ops/memory-extraction-eval-dataset.md §7.1,
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

import { existsSync, readFileSync } from "node:fs";
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
    MEMORY_EVAL_SUCCESSOR_CASES,
    MEMORY_EVAL_SUCCESSOR_DATASET_FROZEN,
    MEMORY_EVAL_SUCCESSOR_DATASET_VERSION,
} from "../lib/memoryEvalSuccessorFixtures.ts";
import { SUCCESSOR_ADOPTED_BATCHES } from "../lib/memoryEvalSuccessorAdopted/index.ts";
import {
    MEMORY_EVAL_SUCC3_CASES,
    MEMORY_EVAL_SUCC3_DATASET_FROZEN,
    MEMORY_EVAL_SUCC3_DATASET_VERSION,
} from "../lib/memoryEvalSucc3Fixtures.ts";
import { SUCC3_ADOPTED_BATCHES } from "../lib/memoryEvalSucc3Adopted/index.ts";
import {
    MEMORY_EVAL_SUCC4_CASES,
    MEMORY_EVAL_SUCC4_DATASET_FROZEN,
    MEMORY_EVAL_SUCC4_DATASET_VERSION,
    MEMORY_EVAL_SUCC4_REPLACEMENT_CASES,
} from "../lib/memoryEvalSucc4Dataset.ts";
import { MEMORY_EVAL_SUCC4_MANIFEST } from "../lib/memoryEvalSucc4Manifest.ts";
import {
    readSucc4AdoptionRecord,
    succ4AdoptionConditions,
} from "../lib/memoryEvalSucc4AdoptionRecord.ts";
import {
    goldReviewCoverage,
    goldReviewFailures,
} from "../lib/memoryEvalGoldReviewJudgements.ts";
import { MEMORY_EVAL_DATASET_SCHEMA_VERSION } from "../lib/memoryEvalDatasetSchema.ts";
import {
    MEMORY_EVAL_SUCC5_APPROVAL,
    MEMORY_EVAL_SUCC5_DATASET_FROZEN,
    MEMORY_EVAL_SUCC5_DATASET_VERSION,
    MEMORY_EVAL_SUCC5_MANIFEST,
    verifySucc5Manifest,
} from "../lib/memoryEvalSucc5.ts";
import { MEMORY_EVAL_DATASET_SCHEMA_V3_VERSION } from "../lib/memoryEvalDatasetSchemaV3.ts";
import {
    MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    memoryEvalScoringContractPromptPending,
    memoryEvalScoringContractReadiness,
} from "../lib/memoryEvalScoringContractDigest.ts";
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

/**
 * Both datasets, checked the same way.
 *
 * The script used to read the seed-11 globals directly. There are two sets
 * now — the frozen schema-1 one, kept as a historical fact, and the schema-2
 * successor a decision-grade run will actually use — and a report that named
 * only the first would have said "all 7 conditions hold" on the very day the
 * second was the one anybody cared about.
 */
const evaluate = (target) => {
const { version, frozen, cases, batches, schemaVersion } = target;
const records = batches.map((batch) => ({
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
    for (const testCase of cases) {
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
            ? `${cases.length} cases across ${counts.size} cells`
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
    (batch) => batch.successorTo !== version
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
    const duplicates = findDuplicateCases(cases);
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
    datasetVersion: version,
    schemaVersion,
    use: "freeze",
});
const schemaExempt = LEGACY_DIAGNOSTIC_DATASET_VERSIONS.includes(version);

/* --- ⑧ no scoring rule left unimplemented --------------------------------- */
// A contract may be frozen with a rule nothing executes yet -- `mem-score-v3`
// was, because §10.2's rules 5 and 6 belong to the v6 prompt and to gold
// review. A **dataset** may not: a verdict produced under a contract whose
// rules nothing applies describes a bar that was never applied, and it would
// be cited as though it had been.
//
// Scoped to datasets the live contract actually governs. seed-11, succ-2 and
// succ-3 were frozen under earlier contracts and their records stand; asking
// them to satisfy a rule written after they were finished would turn a
// historical fact into a failing check.
{
    const governedByLiveContract =
        schemaVersion === MEMORY_EVAL_DATASET_SCHEMA_V3_VERSION;
    const pending = memoryEvalScoringContractReadiness();
    check(
        "no scoring rule left unimplemented",
        governedByLiveContract
            ? pending.length === 0
                ? `${MEMORY_EVAL_SCORING_CONTRACT_VERSION}: every rule has an implementation`
                : `${MEMORY_EVAL_SCORING_CONTRACT_VERSION} still pending: ${pending.join(", ")}`
            : `schema ${schemaVersion}: scored under an earlier contract, not ` +
              `${MEMORY_EVAL_SCORING_CONTRACT_VERSION}`,
        !governedByLiveContract || pending.length === 0
    );
}

/* ----------------------------------------------------------------- report -- */

console.log(
    `Freeze conditions for ${version} ` +
        `(currently ${frozen ? "frozen" : "not frozen"})\n`
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
if (frozen && missed.length > 0) {
    console.error(
        `\n${version} is marked frozen while a freeze condition is unmet.`
    );
    process.exit(1);
}

if (frozen && schemaRefusal && !schemaExempt) {
    console.error(`\n${schemaRefusal.detail}`);
    console.error(
        "A dataset that cannot be scored under the current contract cannot be frozen for it."
    );
    process.exit(1);
}

if (schemaRefusal && schemaExempt) {
    console.log(
        `\nNote: ${version} is schema ${schemaVersion}. ` +
            "Its freeze predates the 2026-08-25 scoring amendment and is kept as a\n" +
            "historical fact; it cannot support a decision-grade run, and the harness\n" +
            "refuses one (legacy_dataset_schema)."
    );
}
};

evaluate({
    version: MEMORY_EVAL_DATASET_VERSION,
    frozen: MEMORY_EVAL_DATASET_FROZEN,
    cases: MEMORY_EVAL_CASES,
    batches: ADOPTED_BATCHES,
    schemaVersion: DATASET_SCHEMA_VERSION,
});

console.log("\n" + "-".repeat(72) + "\n");

evaluate({
    version: MEMORY_EVAL_SUCCESSOR_DATASET_VERSION,
    frozen: MEMORY_EVAL_SUCCESSOR_DATASET_FROZEN,
    cases: MEMORY_EVAL_SUCCESSOR_CASES,
    batches: SUCCESSOR_ADOPTED_BATCHES,
    schemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
});

console.log("\n" + "-".repeat(72) + "\n");

// Every frozen version is re-checked, not only the current target. A dataset
// stops being frozen the moment it stops holding the conditions, and a
// superseded one that quietly moved would take the artifacts scored against
// it with it.
evaluate({
    version: MEMORY_EVAL_SUCC3_DATASET_VERSION,
    frozen: MEMORY_EVAL_SUCC3_DATASET_FROZEN,
    cases: MEMORY_EVAL_SUCC3_CASES,
    batches: SUCC3_ADOPTED_BATCHES,
    schemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
});

console.log("\n" + "-".repeat(72) + "\n");

/* ------------------------------------------- the successor, on §7.1a terms */

// succ-4 does not go through `evaluate()`. Its cases arrive two ways -- 1,047
// inherited from succ-3's adopted batches and 103 written as replacement
// tranches -- so the batch-shaped conditions would read the inherited half and
// say nothing at all about the other. That is worse than not checking: it
// would report "all conditions hold" while 103 cases had never been adopted by
// anyone. docs/ops/memory-extraction-eval-dataset.md §7.1a replaces those
// conditions with five of its own, and this runs them.
{
    const version = MEMORY_EVAL_SUCC4_DATASET_VERSION;
    const frozen = MEMORY_EVAL_SUCC4_DATASET_FROZEN;
    const results = [];
    const check = (condition, detail, ok) => results.push({ condition, detail, ok });

    /* --- the conditions succ-4 shares with every other dataset ------------ */
    {
        const counts = new Map();
        for (const testCase of MEMORY_EVAL_SUCC4_CASES) {
            const key = `${testCase.category}:${testCase.language}`;
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        const short = [...counts].filter(
            ([key, count]) =>
                count < MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM[key.split(":")[0]]
        );
        check(
            "cell floors",
            short.length === 0
                ? `${MEMORY_EVAL_SUCC4_CASES.length} cases across ${counts.size} cells`
                : `below floor: ${short.map(([k, n]) => `${k} ${n}`).join(", ")}`,
            short.length === 0
        );
    }
    {
        const duplicates = findDuplicateCases(MEMORY_EVAL_SUCC4_CASES);
        check(
            "findDuplicateCases()",
            duplicates.length === 0 ? "0" : `${duplicates.length}`,
            duplicates.length === 0
        );
    }
    {
        const pending = memoryEvalScoringContractReadiness();
        const promptPending = memoryEvalScoringContractPromptPending();
        check(
            "no scoring rule left unimplemented",
            pending.length === 0
                ? `${MEMORY_EVAL_SCORING_CONTRACT_VERSION}: every rule a dataset can satisfy has an implementation` +
                      (promptPending.length > 0
                          ? `; awaiting a prompt: ${promptPending.join(", ")}`
                          : "")
                : `${MEMORY_EVAL_SCORING_CONTRACT_VERSION} still pending: ${pending.join(", ")}`,
            pending.length === 0
        );
    }

    /* --- v3-unfixable-evidence-not-a-gold --------------------------------- */
    // Separate from `goldEvidenceFailure()`, which proves the anchor is a real
    // user message and an exact span and says nothing about whether its
    // polarity can be read at all.
    {
        const keys = [];
        const polarityByKey = new Map();
        for (const testCase of MEMORY_EVAL_SUCC4_CASES) {
            for (const gold of testCase.expected) {
                const key = `${testCase.id}:${gold.id}`;
                keys.push(key);
                polarityByKey.set(key, gold.polarity);
            }
        }
        const coverage = goldReviewCoverage({
            decisionSetGoldKeys: keys,
            polarityByKey,
        });
        const failures = goldReviewFailures(coverage);
        check(
            "every gold judged, and none judged unfixable",
            failures.length === 0
                ? `${coverage.judgements.size}/${keys.length} golds judged, 0 unfixable`
                : failures.join(" | "),
            failures.length === 0
        );
    }

    /* --- §7.1a's five --------------------------------------------------- */
    const recordPath = "docs/ops/memory-extraction-eval-succ4-adoption.md";
    if (!existsSync(recordPath)) {
        check(
            "unified adoption record present",
            `${recordPath} does not exist`,
            false
        );
    } else {
        for (const condition of succ4AdoptionConditions({
            record: readSucc4AdoptionRecord(recordPath),
            inherited: MEMORY_EVAL_SUCC4_MANIFEST.composition.inheritedComponents,
            sourceBatchIdsWithRecord: SUCC3_ADOPTED_BATCHES.filter((batch) =>
                existsSync(batch.record)
            ).map((batch) => batch.id),
            liveTranches:
                MEMORY_EVAL_SUCC4_MANIFEST.composition.replacementTranches,
            replacementCount: MEMORY_EVAL_SUCC4_REPLACEMENT_CASES.length,
        })) {
            check(condition.condition, condition.detail, condition.ok);
        }
    }

    // The header keeps the same shape the other three print. It is read by
    // `tests/memoryEvalFreezeGate.test.mjs`, which pairs each section with the
    // constant it claims, and a section whose header did not parse would be a
    // dataset nobody checked.
    console.log(
        `Freeze conditions for ${version} ` +
            `(currently ${frozen ? "frozen" : "not frozen"})`
    );
    console.log(
        "docs/ops/memory-extraction-eval-dataset.md §7.1a successor terms: the\n" +
            "batch conditions are replaced by five, because 103 of these cases\n" +
            "come from replacement tranches and not from an adopted batch.\n"
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
                "docs/ops/memory-extraction-eval-dataset.md §7.1a asks for all of them."
        );
    }
    if (frozen && missed.length > 0) {
        console.error(
            `\n${version} is marked frozen while a freeze condition is unmet.`
        );
        process.exit(1);
    }
}

console.log("\n" + "-".repeat(72) + "\n");

/* ------------------------------- the contract-only successor, on its terms */

// succ-5 does not go through `evaluate()` either, and for the opposite reason
// to succ-4's: it shares succ-4's cases exactly, so every case-level condition
// is already answered above and answering it twice would report one fact as
// two. What is unanswered is whether it is still the thing it claims to be --
// a successor that changed the contract and nothing else.
//
// Four conditions, and each one can fail in a way the others cannot see: the
// sample could drift from succ-4's, the contract could fail to move at all,
// the manifest could stop recomputing, and the human record could go missing.
{
    const version = MEMORY_EVAL_SUCC5_DATASET_VERSION;
    const frozen = MEMORY_EVAL_SUCC5_DATASET_FROZEN;
    const results = [];
    const check = (condition, detail, ok) => results.push({ condition, detail, ok });

    check(
        "the sample is succ-4's, unchanged",
        MEMORY_EVAL_SUCC5_MANIFEST.datasetDigest ===
            MEMORY_EVAL_SUCC4_MANIFEST.datasetDigest
            ? `${MEMORY_EVAL_SUCC5_MANIFEST.caseCount} cases, digest ${MEMORY_EVAL_SUCC5_MANIFEST.datasetDigest}`
            : `${MEMORY_EVAL_SUCC5_MANIFEST.datasetDigest} vs succ-4's ${MEMORY_EVAL_SUCC4_MANIFEST.datasetDigest}`,
        MEMORY_EVAL_SUCC5_MANIFEST.datasetDigest ===
            MEMORY_EVAL_SUCC4_MANIFEST.datasetDigest
    );

    check(
        "the contract did move",
        MEMORY_EVAL_SUCC5_MANIFEST.scoringContractDigest ===
            MEMORY_EVAL_SUCC4_MANIFEST.scoringContractDigest
            ? "identical to the superseded contract; this successor changes nothing"
            : `${MEMORY_EVAL_SUCC4_MANIFEST.scoringContractVersion} -> ${MEMORY_EVAL_SUCC5_MANIFEST.scoringContractVersion}`,
        MEMORY_EVAL_SUCC5_MANIFEST.scoringContractDigest !==
            MEMORY_EVAL_SUCC4_MANIFEST.scoringContractDigest
    );

    {
        const mismatches = verifySucc5Manifest();
        check(
            "the manifest recomputes from the tree",
            mismatches.length === 0
                ? `manifest digest ${MEMORY_EVAL_SUCC5_MANIFEST.manifestDigest}`
                : mismatches.join("; "),
            mismatches.length === 0
        );
    }

    {
        const approval = MEMORY_EVAL_SUCC5_APPROVAL;
        const filled =
            approval.approvedBy.startsWith("@") &&
            /^\d{4}-\d{2}-\d{2}$/.test(approval.approvedAt) &&
            approval.scope === "contract-only";
        check(
            "a human approved it as contract-only",
            filled
                ? `${approval.approvedBy} on ${approval.approvedAt}, scope ${approval.scope}`
                : "the approval record is incomplete or claims a scope it did not have",
            filled
        );
    }

    console.log(
        `Freeze conditions for ${version} ` +
            `(currently ${frozen ? "frozen" : "not frozen"})`
    );
    console.log(
        "A contract-only successor: succ-4's cases under the corrected\n" +
            "contract. The case-level conditions are answered by succ-4's\n" +
            "section above and are not repeated here.\n"
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
        console.log(`\n${missed.length} of ${results.length} conditions unmet.`);
    }
    if (frozen && missed.length > 0) {
        console.error(
            `\n${version} is marked frozen while a freeze condition is unmet.`
        );
        process.exit(1);
    }
}
