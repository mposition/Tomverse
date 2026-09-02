import { createHash } from "node:crypto";

import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";
import { datasetFingerprintInputV3 } from "@/lib/memoryEvalDatasetSchemaV3";
import {
    MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    scoringContractDescriptorInput,
} from "@/lib/memoryEvalScoringContractDigest";
import { MEMORY_EVAL_SUCC6_CASES } from "@/lib/memoryEvalSucc6";
import { MEMORY_EVAL_SUCC7_REPLACEMENTS } from "@/lib/memoryEvalSucc7Replacements";
import {
    SUCC7_RETIRED_CASE_IDS,
    SUCC7_TRANSITION,
} from "@/lib/memoryEvalSucc7Transition";

/**
 * `mem-eval-succ-7`, assembled and NOT frozen.
 *
 * Fifty-four out and fifty-four in against succ-6: ten carrying an approved
 * gold change, forty-four that selected the `mem-extract-v8` intervention. The
 * retired cases are preserved in `lib/memoryEvalSucc7Regression.ts`.
 *
 * ## Why there is no pinned manifest here
 *
 * succ-6 pins its manifest as an object literal, because a record that is
 * recomputed from the tree cannot disagree with the tree, and disagreeing with
 * the tree is the only thing a frozen record is for. That pin belongs to the
 * moment a person signs the dataset. Writing one now would assert a freeze
 * nobody has performed, and `verifySucc7Manifest()` would compare the tree
 * with itself — the exact tautology that went unnoticed in succ-6 until it was
 * found and fixed.
 *
 * So this module computes the manifest and reports `frozen: false`. Adoption
 * is a human act with its own record, and the pin arrives with it.
 */
export const MEMORY_EVAL_SUCC7_DATASET_VERSION = "mem-eval-succ-7";

/**
 * False, and load-bearing. `decideEvalRunMode()` refuses a decision-grade run
 * against an unfrozen dataset, which is what should happen to succ-7 until a
 * person adopts it.
 */
export const MEMORY_EVAL_SUCC7_DATASET_FROZEN = false;

export const MEMORY_EVAL_SUCC7_DATASET_PURPOSE: "development" | "decision" =
    "decision";

const RETIRED = new Set(SUCC7_RETIRED_CASE_IDS);

/**
 * The 1,096 carried over, in succ-6's order.
 *
 * Order is preserved rather than rebuilt so a diff of the two datasets reads
 * as fifty-four removals and fifty-four additions rather than a reshuffle.
 */
const INHERITED: readonly MemoryEvalCaseV3[] = MEMORY_EVAL_SUCC6_CASES.filter(
    (testCase) => !RETIRED.has(testCase.id)
);

export const MEMORY_EVAL_SUCC7_CASES: readonly MemoryEvalCaseV3[] = [
    ...INHERITED,
    ...MEMORY_EVAL_SUCC7_REPLACEMENTS,
];

export const MEMORY_EVAL_SUCC7_INHERITED_COUNT = INHERITED.length;

export const MEMORY_EVAL_SUCC7_CHANGE_REASON =
    "B+ for the ten approved gold changes and the forty-four cases the " +
    "mem-extract-v8 wording was selected from; 1:1 replacements throughout, " +
    "assistant_only subtype composition preserved";

const sha256 = (input: string): string =>
    createHash("sha256").update(input, "utf8").digest("hex");

export type Succ7DraftManifest = {
    datasetVersion: string;
    schemaVersion: 3;
    supersedes: string;
    composition: {
        kind: "case-replacement";
        sourceDatasetVersion: string;
        sourceDatasetDigest: string;
        inheritedCaseCount: number;
        replacedCaseCount: number;
        changeReason: string;
    };
    caseCount: number;
    cellCounts: Readonly<Record<string, number>>;
    datasetDigest: string;
    scoringContractDigest: string;
    scoringContractVersion: string;
    /** Always false here. A true would be a claim nobody has made. */
    frozen: false;
    manifestDigest: string;
};

const cellCountsOf = (
    cases: readonly MemoryEvalCaseV3[]
): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const testCase of cases) {
        const cell = `${testCase.category}:${testCase.language}`;
        counts[cell] = (counts[cell] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort());
};

const manifestFingerprintInput = (
    manifest: Omit<Succ7DraftManifest, "manifestDigest">
): string =>
    [
        manifest.datasetVersion,
        `schema=${manifest.schemaVersion}`,
        `supersedes=${manifest.supersedes}`,
        `kind=${manifest.composition.kind}`,
        `from=${manifest.composition.sourceDatasetVersion}`,
        `fromDigest=${manifest.composition.sourceDatasetDigest}`,
        `inherited=${manifest.composition.inheritedCaseCount}`,
        `replaced=${manifest.composition.replacedCaseCount}`,
        `reason=${manifest.composition.changeReason}`,
        `cases=${manifest.caseCount}`,
        ...Object.entries(manifest.cellCounts).map(
            ([cell, n]) => `cell=${cell}:${n}`
        ),
        `dataset=${manifest.datasetDigest}`,
        `contract=${manifest.scoringContractVersion}`,
        `contractDigest=${manifest.scoringContractDigest}`,
        `frozen=${manifest.frozen}`,
    ].join("\n");

export function buildSucc7DraftManifest(): Succ7DraftManifest {
    const withoutDigest: Omit<Succ7DraftManifest, "manifestDigest"> = {
        datasetVersion: MEMORY_EVAL_SUCC7_DATASET_VERSION,
        schemaVersion: 3,
        supersedes: "mem-eval-succ-6",
        composition: {
            kind: "case-replacement",
            sourceDatasetVersion: "mem-eval-succ-6",
            sourceDatasetDigest: sha256(
                datasetFingerprintInputV3(MEMORY_EVAL_SUCC6_CASES)
            ),
            inheritedCaseCount: INHERITED.length,
            replacedCaseCount: MEMORY_EVAL_SUCC7_REPLACEMENTS.length,
            changeReason: MEMORY_EVAL_SUCC7_CHANGE_REASON,
        },
        caseCount: MEMORY_EVAL_SUCC7_CASES.length,
        cellCounts: cellCountsOf(MEMORY_EVAL_SUCC7_CASES),
        datasetDigest: sha256(
            datasetFingerprintInputV3(MEMORY_EVAL_SUCC7_CASES)
        ),
        scoringContractDigest: sha256(scoringContractDescriptorInput()),
        scoringContractVersion: MEMORY_EVAL_SCORING_CONTRACT_VERSION,
        frozen: false,
    };
    return {
        ...withoutDigest,
        manifestDigest: sha256(manifestFingerprintInput(withoutDigest)),
    };
}

/**
 * Structural problems a draft can still have. Not a freeze check.
 */
export function succ7AssemblyProblems(): readonly string[] {
    const problems: string[] = [];
    const ids = new Set(MEMORY_EVAL_SUCC7_CASES.map((c) => c.id));
    if (ids.size !== MEMORY_EVAL_SUCC7_CASES.length) {
        problems.push("succ-7 contains duplicate case ids");
    }
    for (const row of SUCC7_TRANSITION) {
        if (ids.has(row.retired)) {
            problems.push(`${row.retired} is retired but still present`);
        }
        if (!ids.has(row.replacement)) {
            problems.push(`${row.replacement} is a replacement and is missing`);
        }
    }
    // The sample must have moved. A successor whose digest matches its source
    // is a rename, and would be indistinguishable from one in every artifact
    // that records only the version string.
    const before = sha256(datasetFingerprintInputV3(MEMORY_EVAL_SUCC6_CASES));
    const after = sha256(datasetFingerprintInputV3(MEMORY_EVAL_SUCC7_CASES));
    if (before === after) {
        problems.push("succ-7's digest equals succ-6's — the sample did not move");
    }
    return problems;
}
