/**
 * What the eval harness runs, resolved in one place.
 *
 * ## Why this is a module and not four imports
 *
 * A run has to agree with itself about five things: which cases, which
 * scorer, which fingerprint function, which dataset digest and which contract
 * digest. Schema 2 and schema 3 answer all five differently, and the harness
 * used to hold them as five separate imports pinned to one dataset. Adding a
 * second schema that way means five edits that must move together, with
 * nothing checking that they did — and the failure is silent: a run that
 * fingerprints a schema-3 sample with the schema-2 function produces a digest
 * that matches no manifest, which reads as "the dataset was edited".
 *
 * So the target is resolved once, as one object, and an unknown schema is a
 * throw rather than a default. The harness cannot half-switch.
 *
 * ## What this module deliberately does not do
 *
 * It does not decide whether a run may happen. `decideEvalRunMode()` owns
 * that, still refuses any dataset schema it is not pinned to, and is not
 * consulted here — resolving a target is reading, and reading is free. A
 * target that resolves is not a target that may be billed.
 */

import { createHash } from "node:crypto";

import {
    MEMORY_EVAL_SUCC3_CASES,
    MEMORY_EVAL_SUCC3_DATASET_FROZEN,
    MEMORY_EVAL_SUCC3_DATASET_PURPOSE,
    MEMORY_EVAL_SUCC3_DATASET_VERSION,
} from "@/lib/memoryEvalSucc3Fixtures";
import {
    MEMORY_EVAL_SUCC4_CASES,
    MEMORY_EVAL_SUCC4_DATASET_FROZEN,
    MEMORY_EVAL_SUCC4_DATASET_PURPOSE,
    MEMORY_EVAL_SUCC4_DATASET_VERSION,
} from "@/lib/memoryEvalSucc4Dataset";
import { MEMORY_EVAL_SUCC4_MANIFEST } from "@/lib/memoryEvalSucc4Manifest";
import { MEMORY_EVAL_DATASET_MANIFESTS } from "@/lib/memoryEvalDatasetManifests";
import { datasetFingerprintInput } from "@/lib/memoryExtractionEvalCore";
import { datasetFingerprintInputV3 } from "@/lib/memoryEvalDatasetSchemaV3";
import {
    MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    scoringContractDigest,
    scoringContractDescriptorInput,
} from "@/lib/memoryEvalScoringContractDigest";
import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";
import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";

const sha256 = (value: string): string =>
    createHash("sha256").update(value, "utf8").digest("hex");

export type HarnessTarget =
    | {
          datasetSchemaVersion: 2;
          datasetVersion: string;
          datasetFrozen: boolean;
          datasetPurpose: "decision" | "development";
          cases: readonly MemoryEvalCaseV2[];
          datasetDigest: string;
          scoringContractDigest: string;
          scoringContractVersion: string;
      }
    | {
          datasetSchemaVersion: 3;
          datasetVersion: string;
          datasetFrozen: boolean;
          datasetPurpose: "decision" | "development";
          cases: readonly MemoryEvalCaseV3[];
          datasetDigest: string;
          scoringContractDigest: string;
          scoringContractVersion: string;
      };

/**
 * The dataset the harness is pointed at.
 *
 * One name, changed in one place. The harness has moved target three times —
 * seed-11 to succ-2 to succ-3 to succ-4 — and each move was a set of import
 * renames spread across the file.
 */
export const HARNESS_TARGET_DATASET_VERSION = MEMORY_EVAL_SUCC4_DATASET_VERSION;

/** Every dataset this module can build a target for, newest last. */
const TARGETS: Readonly<Record<string, () => HarnessTarget>> = {
    [MEMORY_EVAL_SUCC3_DATASET_VERSION]: () => ({
        datasetSchemaVersion: 2,
        datasetVersion: MEMORY_EVAL_SUCC3_DATASET_VERSION,
        datasetFrozen: MEMORY_EVAL_SUCC3_DATASET_FROZEN,
        datasetPurpose: MEMORY_EVAL_SUCC3_DATASET_PURPOSE,
        cases: MEMORY_EVAL_SUCC3_CASES,
        datasetDigest: sha256(datasetFingerprintInput(MEMORY_EVAL_SUCC3_CASES)),
        // The schema-2 form: the descriptor AND a labelling pass over the
        // cases, because `datasetFingerprintInput()` reads only `mustInclude`.
        scoringContractDigest: scoringContractDigest(MEMORY_EVAL_SUCC3_CASES),
        scoringContractVersion: MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    }),
    [MEMORY_EVAL_SUCC4_DATASET_VERSION]: () => ({
        datasetSchemaVersion: 3,
        datasetVersion: MEMORY_EVAL_SUCC4_DATASET_VERSION,
        datasetFrozen: MEMORY_EVAL_SUCC4_DATASET_FROZEN,
        datasetPurpose: MEMORY_EVAL_SUCC4_DATASET_PURPOSE,
        cases: MEMORY_EVAL_SUCC4_CASES,
        datasetDigest: sha256(datasetFingerprintInputV3(MEMORY_EVAL_SUCC4_CASES)),
        // The schema-3 form: the descriptor alone. `datasetFingerprintInputV3`
        // already covers the labelling, and hashing it again here would pin
        // the same bytes twice — an edit would move both digests and leave a
        // reader unable to say which is the dataset and which the contract.
        scoringContractDigest: sha256(scoringContractDescriptorInput()),
        scoringContractVersion: MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    }),
};

/**
 * Builds the target for one dataset version.
 *
 * Throws on a version this module has no entry for. That is the fail-closed
 * direction and it is deliberate: the caller is about to compute digests and
 * choose a scorer, and there is no answer to "which ones" that is safer than
 * stopping.
 */
export function harnessTarget(
    datasetVersion: string = HARNESS_TARGET_DATASET_VERSION
): HarnessTarget {
    const build = TARGETS[datasetVersion];
    if (!build) {
        throw new Error(
            `memory eval harness: no target for ${datasetVersion}. Known: ` +
                `${Object.keys(TARGETS).join(", ")}. A dataset with no entry has no ` +
                "fingerprint function and no scorer, and guessing either would " +
                "produce numbers under a contract it was never written for."
        );
    }
    return build();
}

/** What the recorded manifest pins for a dataset, or `null` if unrecorded. */
export type TargetManifestDigests = {
    datasetDigest: string;
    scoringContractDigest: string | null;
    scoringContractVersion: string | null;
};

export function targetManifestDigests(
    datasetVersion: string
): TargetManifestDigests | null {
    if (datasetVersion === MEMORY_EVAL_SUCC4_MANIFEST.datasetVersion) {
        return {
            datasetDigest: MEMORY_EVAL_SUCC4_MANIFEST.datasetDigest,
            scoringContractDigest: MEMORY_EVAL_SUCC4_MANIFEST.scoringContractDigest,
            scoringContractVersion:
                MEMORY_EVAL_SUCC4_MANIFEST.scoringContractVersion,
        };
    }
    const manifest = MEMORY_EVAL_DATASET_MANIFESTS.find(
        (entry) => entry.datasetVersion === datasetVersion
    );
    return manifest
        ? {
              datasetDigest: manifest.datasetDigest,
              scoringContractDigest: manifest.scoringContractDigest,
              scoringContractVersion: manifest.scoringContractVersion,
          }
        : null;
}

/**
 * Whether the target the harness just built is the one the manifest recorded.
 *
 * Returns the disagreements, empty when they agree. This is the binding the
 * approval asked for, and it runs before a provider is reached: a run whose
 * sample fingerprints differently from the frozen record is not the run
 * anybody approved, and discovering that afterwards means the money is spent.
 *
 * A dataset with no manifest at all is a disagreement too. The manifest is
 * what a later reader resolves the artifact against, so a run against an
 * unrecorded dataset produces an artifact nothing can read.
 */
export function harnessTargetBindingFailures(
    target: HarnessTarget
): readonly string[] {
    const recorded = targetManifestDigests(target.datasetVersion);
    if (!recorded) {
        return [
            `${target.datasetVersion} has no recorded manifest, so an artifact from ` +
                "this run could never be resolved back to a dataset.",
        ];
    }
    const failures: string[] = [];
    if (recorded.datasetDigest !== target.datasetDigest) {
        failures.push(
            `dataset digest: the manifest records ${recorded.datasetDigest} and the ` +
                `tree computes ${target.datasetDigest}.`
        );
    }
    if (recorded.scoringContractDigest !== target.scoringContractDigest) {
        failures.push(
            `scoring contract digest: the manifest records ${String(
                recorded.scoringContractDigest
            )} and the tree computes ${target.scoringContractDigest}.`
        );
    }
    if (recorded.scoringContractVersion !== target.scoringContractVersion) {
        failures.push(
            `scoring contract version: the manifest records ${String(
                recorded.scoringContractVersion
            )} and the tree ships ${target.scoringContractVersion}.`
        );
    }
    return failures;
}
