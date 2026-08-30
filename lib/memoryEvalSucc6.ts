/**
 * `mem-eval-succ-6` — the decision set with the ten B+ cases replaced.
 *
 * ## A sample-changing successor, not a contract-only one
 *
 * `succ-5` shares `succ-4`'s case array by reference and records the same
 * dataset digest deliberately: only the contract descriptor moved, so the
 * sample had to be provably identical. `succ-6` is the other kind. Ten cases
 * leave and ten arrive, so the array really does diverge and the dataset
 * digest really is new — and `verifySucc6Manifest()` refuses a manifest whose
 * digest matches `succ-5`, which is the exact inverse of the check `succ-5`
 * carries.
 *
 * The scoring contract does not move with it. `mem-score-v3.4` and its digest
 * are carried across unchanged, because nothing about the scoring rules
 * changed here — what changed is which cases the decision set may score.
 *
 * ## Why ten leave
 *
 * The boundary rule of 2026-08-30 was formed while a reviewer was reading ten
 * `assistant_only` cases, and
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12.1 moves a case
 * out of the decision set when it formed a rule rather than merely being
 * scored by one. Five of the ten also had gold the decision found wrong. Both
 * halves are preserved in `lib/memoryEvalSucc6Regression.ts`, which this
 * module must never import: the decision set and the history it replaced are
 * kept apart by the module graph rather than by a flag.
 *
 * ## Why the replacements are not ten more examples of the rule
 *
 * `lib/memoryEvalSucc6Replacements.ts` says it at length. In short: they are
 * drawn from the cell's own question — does the model mistake material it
 * produced, or material the user framed as fiction, for a fact about the user
 * — rather than from the rule's clauses, so that the decision set tests the
 * rule instead of demonstrating it.
 *
 * ## Not frozen
 *
 * `MEMORY_EVAL_SUCC6_DATASET_FROZEN` is `false` and stays false until a person
 * has reviewed the ten replacements and signed the adoption
 * (.github/audits/memory-boundary-decision-2026-08-30.md §5.3 step 3). The
 * structural checks in `scripts/check-memory-eval-succ6.mjs` pass long before
 * that, and passing them is not the same as being adopted.
 */

import { createHash } from "node:crypto";

import {
    datasetFingerprintInputV3,
    type MemoryEvalCaseV3,
} from "@/lib/memoryEvalDatasetSchemaV3";
import {
    MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    scoringContractDescriptorInput,
} from "@/lib/memoryEvalScoringContractDigest";
import { MEMORY_EVAL_SUCC5_CASES } from "@/lib/memoryEvalSucc5";
import { MEMORY_EVAL_SUCC6_REPLACEMENTS } from "@/lib/memoryEvalSucc6Replacements";
import {
    SUCC6_REPLACEMENT_CASE_IDS,
    SUCC6_SUPERSEDED_CASE_IDS,
} from "@/lib/memoryEvalSucc6Transition";

export const MEMORY_EVAL_SUCC6_DATASET_VERSION = "mem-eval-succ-6";
export const MEMORY_EVAL_SUCC6_SUPERSEDES = "mem-eval-succ-5";
export const MEMORY_EVAL_SUCC6_CHANGE_REASON =
    "B+ isolation of ten rule-forming cases, with 1:1 replacements";

/**
 * False until a person adopts it.
 *
 * The gate that reads this is `decideEvalRunMode()`, and it refuses a
 * decision-grade run against an unfrozen decision sample. That refusal is the
 * point: the structural checks can pass on a set nobody has read.
 */
export const MEMORY_EVAL_SUCC6_DATASET_FROZEN = false;

export const MEMORY_EVAL_SUCC6_DATASET_PURPOSE: "development" | "decision" =
    "decision";

/**
 * The 1,140 cases carried over, in `succ-5`'s order.
 *
 * Order is preserved rather than rebuilt so that the inherited part of the
 * fingerprint is the inherited part of `succ-5`'s, and a diff of the two
 * datasets shows ten removals and ten additions instead of a reshuffle.
 */
const INHERITED: readonly MemoryEvalCaseV3[] = MEMORY_EVAL_SUCC5_CASES.filter(
    (testCase) => !SUCC6_SUPERSEDED_CASE_IDS.has(testCase.id)
);

export const MEMORY_EVAL_SUCC6_CASES: readonly MemoryEvalCaseV3[] = [
    ...INHERITED,
    ...MEMORY_EVAL_SUCC6_REPLACEMENTS,
];

export const MEMORY_EVAL_SUCC6_INHERITED_COUNT = INHERITED.length;

export type EvalDatasetCompositionCaseReplacement = {
    kind: "case-replacement";
    sourceDatasetVersion: string;
    /** `succ-5`'s digest, which this dataset's own must differ from. */
    sourceDatasetDigest: string;
    inheritedCaseCount: number;
    replacedCaseCount: number;
    changeReason: string;
};

export type Succ6DatasetManifest = {
    datasetVersion: "mem-eval-succ-6";
    schemaVersion: 3;
    supersedes: "mem-eval-succ-5";
    composition: EvalDatasetCompositionCaseReplacement;
    caseCount: number;
    cellCounts: Readonly<Record<string, number>>;
    datasetDigest: string;
    scoringContractDigest: string;
    scoringContractVersion: string;
    manifestDigest: string;
    /** False until a person adopts the ten replacements. */
    frozen: boolean;
};

/** The manifest's identity, serialized. `manifestDigest` cannot cover itself. */
export function succ6ManifestFingerprintInput(
    manifest: Omit<Succ6DatasetManifest, "manifestDigest">
): string {
    const cells = Object.keys(manifest.cellCounts)
        .sort()
        .map((cell) => `${cell}=${manifest.cellCounts[cell]}`)
        .join(",");
    return [
        `datasetVersion=${manifest.datasetVersion}`,
        `schemaVersion=${manifest.schemaVersion}`,
        `supersedes=${manifest.supersedes}`,
        `kind=${manifest.composition.kind}`,
        `changeReason=${manifest.composition.changeReason}`,
        `sourceDatasetVersion=${manifest.composition.sourceDatasetVersion}`,
        `sourceDatasetDigest=${manifest.composition.sourceDatasetDigest}`,
        `inherited=${manifest.composition.inheritedCaseCount}`,
        `replaced=${manifest.composition.replacedCaseCount}`,
        `caseCount=${manifest.caseCount}`,
        `cells=${cells}`,
        `datasetDigest=${manifest.datasetDigest}`,
        `scoringContractVersion=${manifest.scoringContractVersion}`,
        `scoringContractDigest=${manifest.scoringContractDigest}`,
        // Deliberately excluded: `frozen`. Adoption is a state the record
        // moves through, not part of which record it is — folding it into the
        // digest would change the manifest's identity at the moment somebody
        // signs it, and the signature would then be of a different manifest.
    ].join(" ");
}

const cellCountsOf = (
    cases: readonly { category: string; language: string }[]
): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const testCase of cases) {
        const cell = `${testCase.category}:${testCase.language}`;
        counts[cell] = (counts[cell] ?? 0) + 1;
    }
    return counts;
};

const sha256 = (input: string): string =>
    createHash("sha256").update(input, "utf8").digest("hex");

/** The manifest as the tree computes it now. */
export function buildSucc6Manifest(): Succ6DatasetManifest {
    const datasetDigest = sha256(
        datasetFingerprintInputV3(MEMORY_EVAL_SUCC6_CASES)
    );
    const withoutDigest: Omit<Succ6DatasetManifest, "manifestDigest"> = {
        datasetVersion: "mem-eval-succ-6",
        schemaVersion: 3,
        supersedes: "mem-eval-succ-5",
        composition: {
            kind: "case-replacement",
            sourceDatasetVersion: "mem-eval-succ-5",
            sourceDatasetDigest: sha256(
                datasetFingerprintInputV3(MEMORY_EVAL_SUCC5_CASES)
            ),
            inheritedCaseCount: INHERITED.length,
            replacedCaseCount: MEMORY_EVAL_SUCC6_REPLACEMENTS.length,
            changeReason: MEMORY_EVAL_SUCC6_CHANGE_REASON,
        },
        caseCount: MEMORY_EVAL_SUCC6_CASES.length,
        cellCounts: cellCountsOf(MEMORY_EVAL_SUCC6_CASES),
        datasetDigest,
        // Computed from the contract, not copied from succ-5's manifest: the
        // contract did not move here, and a copied value would still read
        // "unchanged" on the day it did.
        scoringContractDigest: sha256(scoringContractDescriptorInput()),
        scoringContractVersion: MEMORY_EVAL_SCORING_CONTRACT_VERSION,
        frozen: MEMORY_EVAL_SUCC6_DATASET_FROZEN,
    };
    return {
        ...withoutDigest,
        manifestDigest: sha256(succ6ManifestFingerprintInput(withoutDigest)),
    };
}

/**
 * Everything about this manifest the tree does not reproduce.
 *
 * Empty means the record describes the dataset this tree holds. The two
 * negative checks are the ones a case-replacement successor needs and a
 * contract-only one does not: the sample must have moved, and it must have
 * moved by exactly the ten transitions recorded.
 */
export function verifySucc6Manifest(
    manifest: Succ6DatasetManifest = buildSucc6Manifest()
): readonly string[] {
    const failures: string[] = [];
    const built = buildSucc6Manifest();

    if (manifest.datasetDigest !== built.datasetDigest) {
        failures.push(
            `datasetDigest: recorded ${manifest.datasetDigest}, tree computes ${built.datasetDigest}`
        );
    }
    if (manifest.manifestDigest !== built.manifestDigest) {
        failures.push(
            `manifestDigest: recorded ${manifest.manifestDigest}, tree computes ${built.manifestDigest}`
        );
    }
    // A sample-changing successor whose sample did not change is a version
    // number and nothing else.
    if (manifest.datasetDigest === manifest.composition.sourceDatasetDigest) {
        failures.push(
            "the dataset digest equals succ-5's: this successor replaced ten cases and " +
                "its sample is supposed to differ, so an equal digest means it did not."
        );
    }
    if (
        manifest.composition.inheritedCaseCount +
            manifest.composition.replacedCaseCount !==
        manifest.caseCount
    ) {
        failures.push(
            `composition: ${manifest.composition.inheritedCaseCount} inherited + ` +
                `${manifest.composition.replacedCaseCount} replaced does not make ` +
                `${manifest.caseCount}`
        );
    }
    // The dataset must contain every replacement and none of the originals.
    const ids = new Set(MEMORY_EVAL_SUCC6_CASES.map((testCase) => testCase.id));
    for (const superseded of SUCC6_SUPERSEDED_CASE_IDS) {
        if (ids.has(superseded)) {
            failures.push(`${superseded} is superseded and still in the decision set`);
        }
    }
    for (const replacement of SUCC6_REPLACEMENT_CASE_IDS) {
        if (!ids.has(replacement)) {
            failures.push(`${replacement} is a recorded replacement and is missing`);
        }
    }
    return failures;
}

/** The recorded manifest. Regenerate with `buildSucc6Manifest()`. */
export const MEMORY_EVAL_SUCC6_MANIFEST: Succ6DatasetManifest =
    buildSucc6Manifest();
