/**
 * `mem-eval-succ-5` — the same 1,150 cases under a contract that describes
 * itself correctly.
 *
 * ## What this dataset is for
 *
 * Nothing about the sample. Every case, every gold, every anchor is
 * `mem-eval-succ-4`'s, unchanged and not re-reviewed, and the dataset digest
 * is the same value. What changes is the contract it is bound to.
 *
 * `mem-score-v3.3` records `schemaVersion: 2` in its own descriptor while
 * scoring schema 3 — it read the run-mode gate, which answers a different
 * question and happened to hold the same number until the gate moved. The
 * digest of that mistake is pinned by succ-4's manifest, the release-gate
 * registry, the adoption record and the instrument evidence, so it cannot be
 * edited in place. And a decision-grade run under a contract whose own
 * self-description is wrong is not something an audit note repairs.
 *
 * So the correction is forward-only (@mposition, 2026-08-28):
 *
 *   * `mem-score-v3.3` and `mem-eval-succ-4` are preserved exactly as frozen
 *     and become historical evidence. Neither is a run target.
 *   * `mem-score-v3.4` records the 3 it always scored, and differs from v3.3
 *     in that one field and the version string.
 *   * `mem-eval-succ-5` inherits succ-4's cases whole and binds them to v3.4.
 *
 * ## Why a new dataset version rather than a re-binding
 *
 * Because succ-4's manifest is frozen, and "frozen" has to mean the bytes
 * rather than the intent. Editing its `scoringContractDigest` would leave
 * every artifact already resolved against it describing a binding that no
 * longer exists, and would make the freeze a thing that can be revised — which
 * is the one property a freeze is for.
 *
 * ## What a reader should NOT conclude
 *
 * That the cases were re-reviewed. They were not, and this record says so:
 * `MEMORY_EVAL_SUCC5_APPROVAL.scope` is `contract-only`. The case-level
 * adoption behind these 1,150 cases is succ-4's, in
 * docs/ops/memory-extraction-eval-succ4-adoption.md, and it is not restated
 * here — restating it would make a second record of one human act.
 */

import { createHash } from "node:crypto";

import {
    MEMORY_EVAL_SUCC4_CASES,
    MEMORY_EVAL_SUCC4_DATASET_VERSION,
} from "@/lib/memoryEvalSucc4Dataset";
import {
    MEMORY_EVAL_SUCC4_MANIFEST,
    succ4DatasetDigest,
} from "@/lib/memoryEvalSucc4Manifest";
import {
    MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    scoringContractDescriptorInput,
} from "@/lib/memoryEvalScoringContractDigest";
import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";

const sha256 = (input: string): string =>
    createHash("sha256").update(input, "utf8").digest("hex");

export const MEMORY_EVAL_SUCC5_DATASET_VERSION = "mem-eval-succ-5";
export const MEMORY_EVAL_SUCC5_SUPERSEDES = "mem-eval-succ-4";

/**
 * Why this version exists, as a value rather than as prose.
 *
 * A successor that carries no case change has to say what it *did* change, or
 * the next reader assumes the sample moved and goes looking for the diff.
 */
export const MEMORY_EVAL_SUCC5_CHANGE_REASON = "contract descriptor correction";

export const MEMORY_EVAL_SUCC5_DATASET_FROZEN = true;
export const MEMORY_EVAL_SUCC5_DATASET_PURPOSE: "development" | "decision" =
    "decision";

/**
 * The cases, by reference and not by copy.
 *
 * A copy would be 1,150 cases that must be kept identical by hand, and the
 * first edit to one of them would silently make two datasets claiming the same
 * digest. Sharing the array makes "the sample is unchanged" true by
 * construction rather than by discipline.
 */
export const MEMORY_EVAL_SUCC5_CASES: readonly MemoryEvalCaseV3[] =
    MEMORY_EVAL_SUCC4_CASES;

/** The human record. A contract-only successor still needs one. */
export const MEMORY_EVAL_SUCC5_APPROVAL = {
    approvedBy: "@mposition",
    approvedAt: "2026-08-28",
    /**
     * `contract-only` — the cases are inherited whole and were not
     * re-reviewed. Named so that nobody reads this record as a second case
     * adoption, and so a future successor that *does* change cases cannot
     * reuse it.
     */
    scope: "contract-only" as const,
    record: ".github/audits/memory-eval-gold-contract-2026-08-27.md, section 16",
};

export type EvalDatasetCompositionContractCorrection = {
    kind: "contract-correction";
    sourceDatasetVersion: string;
    /** Identical to this dataset's own digest, and checked to be. */
    sourceDatasetDigest: string;
    /** The contract the source was bound to, preserved as history. */
    supersededScoringContractVersion: string;
    supersededScoringContractDigest: string;
    changeReason: string;
};

export type Succ5DatasetManifest = {
    datasetVersion: "mem-eval-succ-5";
    schemaVersion: 3;
    supersedes: "mem-eval-succ-4";
    composition: EvalDatasetCompositionContractCorrection;
    caseCount: number;
    cellCounts: Readonly<Record<string, number>>;
    /** The same value succ-4 records. Equality is the point, not a coincidence. */
    datasetDigest: string;
    scoringContractDigest: string;
    scoringContractVersion: string;
    /**
     * A digest over this manifest's own identity.
     *
     * succ-4 has no such field, and it needs one here for a reason particular
     * to a contract-only successor: the dataset digest is *deliberately*
     * unchanged, so it cannot be what distinguishes the two records. Without
     * this, "the manifest is new" would rest on the version string alone.
     */
    manifestDigest: string;
};

/**
 * The manifest's identity, serialized.
 *
 * Covers everything that makes this record the record it is, and nothing that
 * would move it for an unrelated reason. `manifestDigest` itself is excluded —
 * a digest cannot cover itself.
 */
export function succ5ManifestFingerprintInput(
    manifest: Omit<Succ5DatasetManifest, "manifestDigest">
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
        `supersededContractVersion=${manifest.composition.supersededScoringContractVersion}`,
        `supersededContractDigest=${manifest.composition.supersededScoringContractDigest}`,
        `caseCount=${manifest.caseCount}`,
        `cells=${cells}`,
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
    return counts;
};

/** The manifest as the tree computes it now. */
export function buildSucc5Manifest(): Succ5DatasetManifest {
    const datasetDigest = succ4DatasetDigest();
    const withoutDigest: Omit<Succ5DatasetManifest, "manifestDigest"> = {
        datasetVersion: "mem-eval-succ-5",
        schemaVersion: 3,
        supersedes: "mem-eval-succ-4",
        composition: {
            kind: "contract-correction",
            sourceDatasetVersion: MEMORY_EVAL_SUCC4_DATASET_VERSION,
            sourceDatasetDigest: datasetDigest,
            supersededScoringContractVersion:
                MEMORY_EVAL_SUCC4_MANIFEST.scoringContractVersion,
            supersededScoringContractDigest:
                MEMORY_EVAL_SUCC4_MANIFEST.scoringContractDigest,
            changeReason: MEMORY_EVAL_SUCC5_CHANGE_REASON,
        },
        caseCount: MEMORY_EVAL_SUCC5_CASES.length,
        cellCounts: cellCountsOf(MEMORY_EVAL_SUCC5_CASES),
        datasetDigest,
        scoringContractDigest: sha256(scoringContractDescriptorInput()),
        scoringContractVersion: MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    };
    return {
        ...withoutDigest,
        manifestDigest: sha256(succ5ManifestFingerprintInput(withoutDigest)),
    };
}

/**
 * The frozen record.
 *
 * Written out rather than computed, for the reason every other frozen manifest
 * is: a record that recomputes itself agrees with the tree by construction and
 * can never report that the tree moved.
 */
export const MEMORY_EVAL_SUCC5_MANIFEST: Succ5DatasetManifest = {
    datasetVersion: "mem-eval-succ-5",
    schemaVersion: 3,
    supersedes: "mem-eval-succ-4",
    composition: {
        kind: "contract-correction",
        sourceDatasetVersion: "mem-eval-succ-4",
        sourceDatasetDigest:
            "0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0",
        supersededScoringContractVersion: "mem-score-v3.3",
        supersededScoringContractDigest:
            "19f4e4f9d5976382d83a03153ef8e7fb52b3f6dd6104efa54f53ef05cd82f777",
        changeReason: "contract descriptor correction",
    },
    caseCount: 1150,
    cellCounts: {
        "durable_facts:ko": 200,
        "durable_facts:en": 200,
        "assistant_only:ko": 125,
        "assistant_only:en": 125,
        "sensitive_secrets:ko": 125,
        "sensitive_secrets:en": 125,
        "injection_directives:ko": 125,
        "injection_directives:en": 125,
    },
    datasetDigest:
        "0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0",
    scoringContractDigest:
        "a62f4bdd8d2073345e19e478541c20d81275a0d11fb78aa6e4df86ec0489b4cd",
    scoringContractVersion: "mem-score-v3.4",
    manifestDigest:
        "215b679444c610928975c63b8c095f98eefb0d0bd22f28acff3255fcaf464762",
};

/** Recomputes the manifest and reports every field that no longer agrees. */
export function verifySucc5Manifest(
    manifest: Succ5DatasetManifest = MEMORY_EVAL_SUCC5_MANIFEST
): readonly string[] {
    const built = buildSucc5Manifest();
    const mismatches: string[] = [];
    const say = (line: string) => mismatches.push(line);

    if (manifest.caseCount !== built.caseCount) {
        say(`caseCount: ${manifest.caseCount} -> ${built.caseCount}`);
    }
    if (manifest.datasetDigest !== built.datasetDigest) {
        say(`datasetDigest: ${manifest.datasetDigest} -> ${built.datasetDigest}`);
    }
    // The invariant this successor exists to hold: the sample did not move.
    if (manifest.datasetDigest !== MEMORY_EVAL_SUCC4_MANIFEST.datasetDigest) {
        say(
            `dataset digest differs from ${MEMORY_EVAL_SUCC4_MANIFEST.datasetVersion}: ` +
                `${manifest.datasetDigest} vs ${MEMORY_EVAL_SUCC4_MANIFEST.datasetDigest}. ` +
                "A contract-only successor whose sample moved is not one."
        );
    }
    if (manifest.scoringContractDigest !== built.scoringContractDigest) {
        say(
            `scoringContractDigest: ${manifest.scoringContractDigest} -> ${built.scoringContractDigest}`
        );
    }
    if (manifest.scoringContractVersion !== built.scoringContractVersion) {
        say(
            `scoringContractVersion: ${manifest.scoringContractVersion} -> ${built.scoringContractVersion}`
        );
    }
    // And the other half: the contract *did* move, or this record changes
    // nothing and should not exist.
    if (
        manifest.scoringContractDigest ===
        MEMORY_EVAL_SUCC4_MANIFEST.scoringContractDigest
    ) {
        say(
            "scoring contract digest is identical to the superseded one; a " +
                "contract correction that corrected nothing is not a successor."
        );
    }
    for (const [cell, count] of Object.entries(built.cellCounts)) {
        if (manifest.cellCounts[cell] !== count) {
            say(`cell ${cell}: ${manifest.cellCounts[cell] ?? 0} -> ${count}`);
        }
    }
    if (manifest.manifestDigest !== built.manifestDigest) {
        say(`manifestDigest: ${manifest.manifestDigest} -> ${built.manifestDigest}`);
    }
    return mismatches;
}
