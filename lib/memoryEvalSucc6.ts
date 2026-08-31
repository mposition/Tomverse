/**
 * `mem-eval-succ-6` — thirteen cases replaced: the B+ ten, and three more.
 *
 * ## A sample-changing successor, not a contract-only one
 *
 * `succ-5` shares `succ-4`'s case array by reference and records the same
 * dataset digest deliberately: only the contract descriptor moved, so the
 * sample had to be provably identical. `succ-6` is the other kind. Thirteen
 * cases leave and thirteen arrive, so the array really does diverge and the dataset
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
 * has reviewed **all thirteen** new cases — the B+ ten and the three
 * composition repairs — and signed the adoption
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
    SUBTYPE_REVIEW,
    subtypeTableDigest,
} from "@/lib/memoryEvalAssistantOnlySubtypes";
import {
    SUCC6_COMPOSITION_ADDITIONS,
    SUCC6_COMPOSITION_ADDITION_IDS,
    SUCC6_REMOVED_FOR_COMPOSITION,
} from "@/lib/memoryEvalSucc6CompositionRepairs";
import {
    SUCC6_REPLACEMENT_CASE_IDS,
    SUCC6_SUPERSEDED_CASE_IDS,
} from "@/lib/memoryEvalSucc6Transition";

export const MEMORY_EVAL_SUCC6_DATASET_VERSION = "mem-eval-succ-6";
export const MEMORY_EVAL_SUCC6_SUPERSEDES = "mem-eval-succ-5";
export const MEMORY_EVAL_SUCC6_CHANGE_REASON =
    "B+ isolation of ten rule-forming cases, plus three composition repairs " +
    "for the docs/ops/memory-extraction-eval-dataset.md §3.3 subtype floor; 1:1 replacements throughout";

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
 * The 1,137 cases carried over, in `succ-5`'s order.
 *
 * Order is preserved rather than rebuilt so that the inherited part of the
 * fingerprint is the inherited part of `succ-5`'s, and a diff of the two
 * datasets shows thirteen removals and thirteen additions rather than a
 * reshuffle.
 */
const INHERITED: readonly MemoryEvalCaseV3[] = MEMORY_EVAL_SUCC5_CASES.filter(
    (testCase) =>
        !SUCC6_SUPERSEDED_CASE_IDS.has(testCase.id) &&
        !SUCC6_REMOVED_FOR_COMPOSITION.has(testCase.id)
);

/**
 * Thirteen out, thirteen in, from two decisions that are kept apart.
 *
 * Ten are B+ (`lib/memoryEvalSucc6Transition.ts`), moved because they formed
 * the boundary rule and preserved with their history. Three are composition
 * repairs (`lib/memoryEvalSucc6CompositionRepairs.ts`), swapped because the
 * cells sat below the docs/ops/memory-extraction-eval-dataset.md §3.3 subtype floor. Merging the two lists would make
 * "why did this case leave" unanswerable, and the answers are not the same.
 */
export const MEMORY_EVAL_SUCC6_CASES: readonly MemoryEvalCaseV3[] = [
    ...INHERITED,
    ...MEMORY_EVAL_SUCC6_REPLACEMENTS,
    ...SUCC6_COMPOSITION_ADDITIONS,
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
    /**
     * Digest of the subtype classification the docs/ops/memory-extraction-eval-dataset.md §3.3 floor is measured against.
     *
     * Not covered by `datasetDigest`, which fingerprints cases: a subtype is a
     * judgement about a case, not part of it. Without this a freeze would pin
     * the sample and leave the reading of it free to move, and the floor is
     * decided by the reading.
     */
    subtypeTableDigest: string;
    caseCount: number;
    cellCounts: Readonly<Record<string, number>>;
    datasetDigest: string;
    scoringContractDigest: string;
    scoringContractVersion: string;
    manifestDigest: string;
    /** False until a person adopts all thirteen new cases. */
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
        `subtypeTableDigest=${manifest.subtypeTableDigest}`,
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
            replacedCaseCount:
                MEMORY_EVAL_SUCC6_REPLACEMENTS.length +
                SUCC6_COMPOSITION_ADDITIONS.length,
            changeReason: MEMORY_EVAL_SUCC6_CHANGE_REASON,
        },
        subtypeTableDigest: subtypeTableDigest(),
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
 * moved by exactly the thirteen swaps recorded — the B+ ten and the three
 * composition repairs, each checked against its own list.
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
    // `frozen` is deliberately outside the digest (see
    // `succ6ManifestFingerprintInput()`), so the digest checks above cannot
    // notice it. That is exactly why it is compared here on its own: a record
    // claiming adoption while the tree still says `false` would otherwise pass
    // every check in this function, and adoption is the one field a person —
    // not this file — sets.
    if (manifest.frozen !== MEMORY_EVAL_SUCC6_DATASET_FROZEN) {
        failures.push(
            `frozen: the manifest records ${manifest.frozen}, the tree declares ` +
                `${MEMORY_EVAL_SUCC6_DATASET_FROZEN}. This field is outside the ` +
                "digest, so nothing else here would have caught it."
        );
    }
    // Freezing is a claim about two artefacts, and only one of them is the
    // sample. A dataset frozen over a classification nobody signed would carry
    // a floor measured by an AI draft into every later citation of it, and the
    // docs/ops/memory-extraction-eval-dataset.md §3.3 floor is decided by the classification.
    //
    // This also fixes the order the freeze has to run in. The review status,
    // reviewer and date are inside `subtypeTableDigest`, so recording the
    // signature *moves* that digest and the manifest digest with it. Pinning
    // the draft's values first and signing afterwards produces a record whose
    // digests describe a table that no longer exists: sign, recompute, then
    // pin.
    if (MEMORY_EVAL_SUCC6_DATASET_FROZEN) {
        if (SUBTYPE_REVIEW.status !== "human_confirmed") {
            failures.push(
                `frozen with the subtype table still ${SUBTYPE_REVIEW.status}: the ` +
                    "docs/ops/memory-extraction-eval-dataset.md §3.3 floor rests on " +
                    "that table, and freezing over an unsigned reading freezes the " +
                    "reading too"
            );
        }
        if (!SUBTYPE_REVIEW.reviewer || !SUBTYPE_REVIEW.reviewedAt) {
            failures.push(
                "frozen with a subtype table confirmed by nobody, or on no date"
            );
        }
    }
    if (manifest.subtypeTableDigest !== built.subtypeTableDigest) {
        failures.push(
            `subtypeTableDigest: recorded ${manifest.subtypeTableDigest}, tree computes ` +
                `${built.subtypeTableDigest}. The classification moved under a record ` +
                "that pinned it, and the docs/ops/memory-extraction-eval-dataset.md §3.3 floor is decided by the classification."
        );
    }
    // A sample-changing successor whose sample did not change is a version
    // number and nothing else.
    if (manifest.datasetDigest === manifest.composition.sourceDatasetDigest) {
        failures.push(
            "the dataset digest equals succ-5's: this successor replaced thirteen cases and " +
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
    for (const removed of SUCC6_REMOVED_FOR_COMPOSITION) {
        if (ids.has(removed)) {
            failures.push(`${removed} was swapped for composition and is still present`);
        }
    }
    for (const added of SUCC6_COMPOSITION_ADDITION_IDS) {
        if (!ids.has(added)) {
            failures.push(`${added} is a composition repair and is missing`);
        }
    }
    return failures;
}

/**
 * The manifest, computed — and this is a draft, not the frozen record.
 *
 * While `MEMORY_EVAL_SUCC6_DATASET_FROZEN` is `false` the manifest may be a
 * view over the tree, because there is nothing yet to be inconsistent with:
 * every edit to the cases moves the digest and the record follows it.
 *
 * **At freeze this must become a literal.** A computed manifest cannot be
 * wrong about the tree, which sounds like a virtue and is the defect: what a
 * frozen record is for is to disagree when the cases move afterwards, and
 * `verifySucc6Manifest()` — whose entire job is to report that disagreement —
 * compares its argument against `buildSucc6Manifest()` and would then be
 * comparing the tree with itself. So the freeze commit replaces this with the
 * object literal `buildSucc6Manifest()` produced at that commit, digests
 * included, alongside `MEMORY_EVAL_SUCC6_DATASET_FROZEN = true` and the signed
 * adoption. `mem-eval-succ-5` carries the same pinned shape, for the same
 * reason.
 */
export const MEMORY_EVAL_SUCC6_MANIFEST: Succ6DatasetManifest =
    buildSucc6Manifest();
