import { createHash } from "node:crypto";

import { datasetFingerprintInputV4 } from "@/lib/memoryEvalDatasetFingerprintV4";
import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";
import {
    MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    scoringContractDescriptorInput,
} from "@/lib/memoryEvalScoringContractDigest";
import {
    MEMORY_EVAL_SUCC7_CASES,
    MEMORY_EVAL_SUCC7_DATASET_VERSION,
    MEMORY_EVAL_SUCC7_MANIFEST,
    MEMORY_EVAL_SUCC7_SCORING_CONTRACT,
} from "@/lib/memoryEvalSucc7";

/**
 * `mem-eval-succ-8` — succ-7's 1,150 cases under a contract that reads Korean
 * numerals as words.
 *
 * ## What this dataset is for
 *
 * Nothing about the sample. Every case, every gold, every anchor is succ-7's,
 * unchanged and not re-reviewed, and the dataset digest is the same value.
 * What changes is the contract it is bound to.
 *
 * `mem-score-v3.4` rewrote a Korean numeral wherever a counter followed it,
 * including when the numeral was the last syllable of an ordinary word. So
 * `토요일 일정` canonicalised to `토요1일정` and the token `격주토요일` existed in
 * no candidate that phrased it that way: `succ-durable-ko-611` could only
 * score a false negative for three of five plausible phrasings of the fact it
 * tests. `.github/audits/memory-eval-korean-numeral-amendment-2026-09-03.md`
 * has the evidence and the five phrasings.
 *
 * ## Why the contract moved and the gold did not
 *
 * Shortening the gold to `["격주", "일정"]` or `["격주", "토요"]` makes all five
 * phrasings pass, and both were refused: the first drops 토요일, which is the
 * condition being tested, and the second only routes around the defect. A gold
 * adapted to a scorer bug is a gold that has stopped describing the fact.
 *
 * succ-7 is also frozen and signed. Editing a case would move its dataset
 * digest, and re-signing a moved sample under the same `datasetVersion` is
 * what docs/ops/memory-extraction-eval-dataset.md section 7.3 forbids.
 *
 * ## Why a new dataset version rather than a re-binding
 *
 * Because succ-7's manifest is frozen, and frozen has to mean the bytes rather
 * than the intent. Editing its `scoringContractDigest` would leave every
 * artifact resolved against it describing a binding that no longer exists, and
 * would make the freeze revisable — the one property a freeze is for. succ-7
 * stays bound to `mem-score-v3.4` for good; the same cases are scored under
 * v3.5 here.
 *
 * ## What a reader should NOT conclude
 *
 * That the cases were re-reviewed. They were not, and this record says so:
 * `MEMORY_EVAL_SUCC8_APPROVAL.scope` is `contract-only`. The case-level
 * adoption behind these 1,150 cases is succ-7's, signed by `@mposition` on
 * 2026-09-03 and recorded in
 * `.github/audits/memory-eval-succ7-adoption-2026-09-02.md`. It is not
 * restated here — restating it would make a second record of one human act.
 */

const sha256 = (input: string): string =>
    createHash("sha256").update(input, "utf8").digest("hex");

export const MEMORY_EVAL_SUCC8_DATASET_VERSION = "mem-eval-succ-8";
export const MEMORY_EVAL_SUCC8_SUPERSEDES = MEMORY_EVAL_SUCC7_DATASET_VERSION;

/**
 * Why this version exists, as a value rather than as prose.
 *
 * A successor that carries no case change has to say what it *did* change, or
 * the next reader assumes the sample moved and goes looking for the diff.
 */
export const MEMORY_EVAL_SUCC8_CHANGE_REASON =
    "Korean numeral canonicalisation bounded to word starts";

/**
 * False, pending a signature.
 *
 * A contract-only successor inherits its sample's adoption but not its freeze:
 * what has to be approved here is the contract change and the claim that the
 * cases are carried whole, which is a person's decision like any other.
 * `decideEvalRunMode()` refuses a decision-grade run against an unfrozen
 * sample, which is what should happen until then.
 */
export const MEMORY_EVAL_SUCC8_DATASET_FROZEN = false;

export const MEMORY_EVAL_SUCC8_DATASET_PURPOSE: "development" | "decision" =
    "decision";

/**
 * The cases, by reference and not by copy.
 *
 * A copy would be 1,150 cases that must be kept identical by hand, and the
 * first edit to one of them would silently make two datasets claiming the same
 * digest. Sharing the array makes "the sample is unchanged" true by
 * construction rather than by discipline.
 */
export const MEMORY_EVAL_SUCC8_CASES: readonly MemoryEvalCaseV3[] =
    MEMORY_EVAL_SUCC7_CASES;

/** The human record. A contract-only successor still needs one. */
export const MEMORY_EVAL_SUCC8_APPROVAL: {
    approvedBy: string | null;
    approvedAt: string | null;
    scope: "contract-only";
    record: string;
} = {
    approvedBy: null,
    approvedAt: null,
    /**
     * `contract-only` — the cases are inherited whole and were not
     * re-reviewed. Named so that nobody reads this record as a second case
     * adoption, and so a future successor that *does* change cases cannot
     * reuse it.
     */
    scope: "contract-only",
    record: ".github/audits/memory-eval-korean-numeral-amendment-2026-09-03.md",
};

export type Succ8Composition = {
    kind: "contract-correction";
    sourceDatasetVersion: string;
    /** Identical to this dataset's own digest, and checked to be. */
    sourceDatasetDigest: string;
    /**
     * succ-7's pairing digest, carried rather than recomputed.
     *
     * The sample says which cases exist; it cannot say which replacement stood
     * in for which original, and that is what fifty-three of succ-7's verdicts
     * were about. A contract-only successor that dropped it would inherit the
     * cases and lose what a reviewer actually judged.
     */
    sourceTransitionDigest: string;
    /** The contract the source was bound to, preserved as history. */
    supersededScoringContractVersion: string;
    supersededScoringContractDigest: string;
    changeReason: string;
};

export type Succ8DatasetManifest = {
    datasetVersion: "mem-eval-succ-8";
    schemaVersion: 3;
    supersedes: "mem-eval-succ-7";
    composition: Succ8Composition;
    caseCount: number;
    cellCounts: Readonly<Record<string, number>>;
    /** v4, as succ-7 is: the fingerprint covers `conversation.title`. */
    fingerprintVersion: 4;
    /** The same value succ-7 records. Equality is the point, not a coincidence. */
    datasetDigest: string;
    scoringContractDigest: string;
    scoringContractVersion: string;
    /**
     * Lifecycle state, reported but NOT part of `manifestDigest` — as in
     * succ-7, so the digest a reviewer signs is the digest that gets frozen.
     */
    frozen: boolean;
    manifestDigest: string;
};

/**
 * The manifest's identity, serialized.
 *
 * `frozen` is deliberately absent, for the reason succ-7 states: inside the
 * fingerprint, the digest signed off on (`frozen=false`) is not the digest
 * that exists a moment later (`frozen=true`), so nobody ever signs the thing
 * that gets frozen.
 */
export function succ8ManifestFingerprintInput(
    manifest: Omit<Succ8DatasetManifest, "manifestDigest">
): string {
    const cells = Object.keys(manifest.cellCounts)
        .sort()
        .map((cell) => `${cell}=${manifest.cellCounts[cell]}`)
        .join(",");
    return [
        `datasetVersion=${manifest.datasetVersion}`,
        `schemaVersion=${manifest.schemaVersion}`,
        `supersedes=${manifest.supersedes}`,
        `changeReason=${manifest.composition.changeReason}`,
        `kind=${manifest.composition.kind}`,
        `sourceDatasetVersion=${manifest.composition.sourceDatasetVersion}`,
        `sourceDatasetDigest=${manifest.composition.sourceDatasetDigest}`,
        `sourceTransitionDigest=${manifest.composition.sourceTransitionDigest}`,
        `supersededContractVersion=${manifest.composition.supersededScoringContractVersion}`,
        `supersededContractDigest=${manifest.composition.supersededScoringContractDigest}`,
        `caseCount=${manifest.caseCount}`,
        `cells=${cells}`,
        `fingerprint=v${manifest.fingerprintVersion}`,
        `datasetDigest=${manifest.datasetDigest}`,
        `scoringContractVersion=${manifest.scoringContractVersion}`,
        `scoringContractDigest=${manifest.scoringContractDigest}`,
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
    return Object.fromEntries(Object.entries(counts).sort());
};

/** The manifest as the tree computes it now. */
export function buildSucc8Manifest(): Succ8DatasetManifest {
    const datasetDigest = sha256(
        datasetFingerprintInputV4(MEMORY_EVAL_SUCC8_CASES)
    );
    const withoutDigest: Omit<Succ8DatasetManifest, "manifestDigest"> = {
        datasetVersion: "mem-eval-succ-8",
        schemaVersion: 3,
        supersedes: "mem-eval-succ-7",
        composition: {
            kind: "contract-correction",
            sourceDatasetVersion: MEMORY_EVAL_SUCC7_DATASET_VERSION,
            sourceDatasetDigest: datasetDigest,
            sourceTransitionDigest: MEMORY_EVAL_SUCC7_MANIFEST.transitionDigest,
            supersededScoringContractVersion:
                MEMORY_EVAL_SUCC7_SCORING_CONTRACT.version,
            supersededScoringContractDigest:
                MEMORY_EVAL_SUCC7_SCORING_CONTRACT.digest,
            changeReason: MEMORY_EVAL_SUCC8_CHANGE_REASON,
        },
        caseCount: MEMORY_EVAL_SUCC8_CASES.length,
        cellCounts: cellCountsOf(MEMORY_EVAL_SUCC8_CASES),
        fingerprintVersion: 4,
        datasetDigest,
        scoringContractDigest: sha256(scoringContractDescriptorInput()),
        scoringContractVersion: MEMORY_EVAL_SCORING_CONTRACT_VERSION,
        frozen: MEMORY_EVAL_SUCC8_DATASET_FROZEN,
    };
    return {
        ...withoutDigest,
        manifestDigest: sha256(succ8ManifestFingerprintInput(withoutDigest)),
    };
}

/**
 * Everything a contract-only successor can be wrong about.
 *
 * Two invariants and they pull in opposite directions, which is the whole
 * shape of this kind of successor: the sample must NOT have moved, and the
 * contract MUST have. A record failing the first is a case change wearing a
 * contract label; one failing the second changes nothing and should not exist.
 */
export function succ8Problems(
    manifest: Succ8DatasetManifest = buildSucc8Manifest()
): readonly string[] {
    const problems: string[] = [];
    if (manifest.datasetDigest !== MEMORY_EVAL_SUCC7_MANIFEST.datasetDigest) {
        problems.push(
            `dataset digest differs from ${MEMORY_EVAL_SUCC7_MANIFEST.datasetVersion}: ` +
                `${manifest.datasetDigest} vs ${MEMORY_EVAL_SUCC7_MANIFEST.datasetDigest}. ` +
                "A contract-only successor whose sample moved is not one."
        );
    }
    if (
        manifest.composition.sourceTransitionDigest !==
        MEMORY_EVAL_SUCC7_MANIFEST.transitionDigest
    ) {
        problems.push(
            "the carried transition digest is not succ-7's, so the pairing " +
                "fifty-three verdicts were about is no longer bound"
        );
    }
    if (
        manifest.scoringContractDigest ===
        MEMORY_EVAL_SUCC7_SCORING_CONTRACT.digest
    ) {
        problems.push(
            "the scoring contract digest is identical to the superseded one; a " +
                "contract correction that corrected nothing is not a successor."
        );
    }
    if (manifest.scoringContractVersion === MEMORY_EVAL_SUCC7_SCORING_CONTRACT.version) {
        problems.push(
            `the contract version is still ${MEMORY_EVAL_SUCC7_SCORING_CONTRACT.version}`
        );
    }
    if (MEMORY_EVAL_SUCC8_CASES !== MEMORY_EVAL_SUCC7_CASES) {
        problems.push(
            "the cases are a copy rather than succ-7's array; two datasets that " +
                "agree today can disagree after one edit"
        );
    }
    if (MEMORY_EVAL_SUCC8_DATASET_FROZEN && !MEMORY_EVAL_SUCC8_APPROVAL.approvedBy) {
        problems.push("frozen with nobody's name on it");
    }
    return problems;
}
