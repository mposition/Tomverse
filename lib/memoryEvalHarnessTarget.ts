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
import {
    MEMORY_EVAL_SUCC5_CASES,
    MEMORY_EVAL_SUCC5_DATASET_FROZEN,
    MEMORY_EVAL_SUCC5_DATASET_PURPOSE,
    MEMORY_EVAL_SUCC5_DATASET_VERSION,
    MEMORY_EVAL_SUCC5_MANIFEST,
} from "@/lib/memoryEvalSucc5";
import {
    MEMORY_EVAL_SUCC6_CASES,
    MEMORY_EVAL_SUCC6_DATASET_FROZEN,
    MEMORY_EVAL_SUCC6_DATASET_PURPOSE,
    MEMORY_EVAL_SUCC6_DATASET_VERSION,
    MEMORY_EVAL_SUCC6_MANIFEST,
} from "@/lib/memoryEvalSucc6";
import {
    MEMORY_EVAL_SUCC7_CASES,
    MEMORY_EVAL_SUCC7_DATASET_FROZEN,
    MEMORY_EVAL_SUCC7_DATASET_PURPOSE,
    MEMORY_EVAL_SUCC7_DATASET_VERSION,
    MEMORY_EVAL_SUCC7_MANIFEST,
} from "@/lib/memoryEvalSucc7";
import {
    MEMORY_EVAL_SUCC8_CASES,
    MEMORY_EVAL_SUCC8_DATASET_FROZEN,
    MEMORY_EVAL_SUCC8_DATASET_PURPOSE,
    MEMORY_EVAL_SUCC8_DATASET_VERSION,
    buildSucc8Manifest,
} from "@/lib/memoryEvalSucc8";
import { MEMORY_EVAL_DATASET_MANIFESTS } from "@/lib/memoryEvalDatasetManifests";
import { datasetFingerprintInput } from "@/lib/memoryExtractionEvalCore";
import { datasetFingerprintInputV3 } from "@/lib/memoryEvalDatasetSchemaV3";
import { datasetFingerprintInputV4 } from "@/lib/memoryEvalDatasetFingerprintV4";
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
          datasetManifestDigest: string | null;
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
          /**
           * The manifest's own digest, or `null` where the manifest has none.
           *
           * succ-3 and succ-4 predate the field; neither is a run target, so
           * neither needs one. It is on the target rather than read from a
           * dataset module by the caller because a caller that names a
           * dataset has half-switched — which is what happened: the live
           * harness built its budget tuple with `MEMORY_EVAL_SUCC5_MANIFEST`
           * hard-coded, so pointing the harness at succ-6 would have left a
           * succ-6 budget refused as a tuple mismatch.
           */
          datasetManifestDigest: string | null;
          scoringContractDigest: string;
          scoringContractVersion: string;
      };

/**
 * The dataset the harness is pointed at.
 *
 * One name, changed in one place. The harness has moved target six times —
 * seed-11 to succ-2 to succ-3 to succ-4 to succ-5 to succ-6 to succ-7 — and
 * before this module each move was a set of import renames spread across the
 * file. A half-switched harness fingerprints one sample and scores another,
 * which is the failure the module exists to make impossible.
 *
 * The target is succ-8 rather than succ-7, and the two moves are one step
 * apart for a reason worth keeping. succ-7 replaced fifty-four cases and was
 * signed; pointing the harness at it then showed the smoke run scoring 484 of
 * 485 golds its own stub had answered correctly, because `mem-score-v3.4`
 * canonicalised `토요일 일정` to `토요1일정`. The contract was the defect, so the
 * contract moved — `mem-score-v3.5` — and succ-8 carries succ-7's sample,
 * unchanged and by reference, under it.
 *
 * succ-7 therefore stops being a run target the way succ-4 did: it is bound to
 * v3.4 for good, and `harnessTargetBindingFailures()` says so. It stays
 * selectable by name, because the artifacts scored against it have to stay
 * readable.
 *
 * Moving this name does not approve a run. The register holds no runnable pair
 * and no budget, and succ-8 is not frozen yet, so the gates downstream refuse
 * for those reasons rather than for this one.
 */
export const HARNESS_TARGET_DATASET_VERSION = MEMORY_EVAL_SUCC8_DATASET_VERSION;

/** Every dataset this module can build a target for, newest last. */
const TARGETS: Readonly<Record<string, () => HarnessTarget>> = {
    [MEMORY_EVAL_SUCC3_DATASET_VERSION]: () => ({
        datasetSchemaVersion: 2,
        datasetVersion: MEMORY_EVAL_SUCC3_DATASET_VERSION,
        datasetFrozen: MEMORY_EVAL_SUCC3_DATASET_FROZEN,
        datasetPurpose: MEMORY_EVAL_SUCC3_DATASET_PURPOSE,
        cases: MEMORY_EVAL_SUCC3_CASES,
        datasetDigest: sha256(datasetFingerprintInput(MEMORY_EVAL_SUCC3_CASES)),
        // Schema-2 manifests carry no digest of their own.
        datasetManifestDigest: null,
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
        datasetManifestDigest: null,
        // The schema-3 form: the descriptor alone. `datasetFingerprintInputV3`
        // already covers the labelling, and hashing it again here would pin
        // the same bytes twice — an edit would move both digests and leave a
        // reader unable to say which is the dataset and which the contract.
        //
        // Recorded rather than recomputed, because succ-4 is bound to
        // `mem-score-v3.3` for good and this tree ships v3.4. Computing it
        // would report a contract this dataset was never scored under, which
        // is what `harnessTargetBindingFailures()` then refuses — correctly,
        // and that refusal is why succ-4 is no longer a run target.
        scoringContractDigest: MEMORY_EVAL_SUCC4_MANIFEST.scoringContractDigest,
        scoringContractVersion: MEMORY_EVAL_SUCC4_MANIFEST.scoringContractVersion,
    }),
    [MEMORY_EVAL_SUCC5_DATASET_VERSION]: () => ({
        datasetSchemaVersion: 3,
        datasetVersion: MEMORY_EVAL_SUCC5_DATASET_VERSION,
        datasetFrozen: MEMORY_EVAL_SUCC5_DATASET_FROZEN,
        datasetPurpose: MEMORY_EVAL_SUCC5_DATASET_PURPOSE,
        // succ-4's cases, by reference. The sample is what makes succ-5 a
        // contract-only successor, so the two share the array rather than
        // agreeing about it.
        cases: MEMORY_EVAL_SUCC5_CASES,
        datasetDigest: sha256(datasetFingerprintInputV3(MEMORY_EVAL_SUCC5_CASES)),
        datasetManifestDigest: MEMORY_EVAL_SUCC5_MANIFEST.manifestDigest,
        // Recorded, like succ-4's: succ-5 is bound to `mem-score-v3.4`.
        scoringContractDigest: MEMORY_EVAL_SUCC5_MANIFEST.scoringContractDigest,
        scoringContractVersion: MEMORY_EVAL_SUCC5_MANIFEST.scoringContractVersion,
    }),
    [MEMORY_EVAL_SUCC6_DATASET_VERSION]: () => ({
        datasetSchemaVersion: 3,
        datasetVersion: MEMORY_EVAL_SUCC6_DATASET_VERSION,
        datasetFrozen: MEMORY_EVAL_SUCC6_DATASET_FROZEN,
        datasetPurpose: MEMORY_EVAL_SUCC6_DATASET_PURPOSE,
        cases: MEMORY_EVAL_SUCC6_CASES,
        // Computed, not read from the manifest — that is the whole point of
        // the binding check below. succ-6's manifest is a pinned literal, so
        // the comparison is a record against a tree rather than a tree
        // against itself.
        datasetDigest: sha256(datasetFingerprintInputV3(MEMORY_EVAL_SUCC6_CASES)),
        datasetManifestDigest: MEMORY_EVAL_SUCC6_MANIFEST.manifestDigest,
        // Recorded, like succ-4's and succ-5's: succ-6 is bound to v3.4.
        scoringContractDigest: MEMORY_EVAL_SUCC6_MANIFEST.scoringContractDigest,
        scoringContractVersion: MEMORY_EVAL_SUCC6_MANIFEST.scoringContractVersion,
    }),
    [MEMORY_EVAL_SUCC7_DATASET_VERSION]: () => ({
        datasetSchemaVersion: 3,
        datasetVersion: MEMORY_EVAL_SUCC7_DATASET_VERSION,
        datasetFrozen: MEMORY_EVAL_SUCC7_DATASET_FROZEN,
        datasetPurpose: MEMORY_EVAL_SUCC7_DATASET_PURPOSE,
        cases: MEMORY_EVAL_SUCC7_CASES,
        // v4, not v3. succ-7 is fingerprinted with the version that covers
        // `conversation.title`, which the prompt sends and v3 omitted; hashing
        // it with v3 here would compute a digest the manifest never recorded
        // and refuse the target for a difference this file invented.
        datasetDigest: sha256(datasetFingerprintInputV4(MEMORY_EVAL_SUCC7_CASES)),
        datasetManifestDigest: MEMORY_EVAL_SUCC7_MANIFEST.manifestDigest,
        // Recorded, not recomputed, for the reason succ-4's entry gives: succ-7
        // is bound to `mem-score-v3.4` for good and this tree ships v3.5.
        // Computing it would report a contract this dataset was never scored
        // under, which `harnessTargetBindingFailures()` then refuses —
        // correctly, and that refusal is why succ-7 is no longer a run target.
        scoringContractDigest: MEMORY_EVAL_SUCC7_MANIFEST.scoringContractDigest,
        scoringContractVersion: MEMORY_EVAL_SUCC7_MANIFEST.scoringContractVersion,
    }),
    [MEMORY_EVAL_SUCC8_DATASET_VERSION]: () => ({
        datasetSchemaVersion: 3,
        datasetVersion: MEMORY_EVAL_SUCC8_DATASET_VERSION,
        datasetFrozen: MEMORY_EVAL_SUCC8_DATASET_FROZEN,
        datasetPurpose: MEMORY_EVAL_SUCC8_DATASET_PURPOSE,
        // succ-7's array, by reference all the way down: a contract-only
        // successor that held its own copy would be two datasets agreeing
        // today and diverging on the first edit to either.
        cases: MEMORY_EVAL_SUCC8_CASES,
        datasetDigest: sha256(datasetFingerprintInputV4(MEMORY_EVAL_SUCC8_CASES)),
        datasetManifestDigest: buildSucc8Manifest().manifestDigest,
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
    // Newest first, and each read from the successor's own module rather than
    // from the batch registry below: succ-4 onwards are not batch-composed, so
    // their record is the pinned literal each module carries.
    for (const manifest of [
        buildSucc8Manifest(),
        MEMORY_EVAL_SUCC7_MANIFEST,
        MEMORY_EVAL_SUCC6_MANIFEST,
        MEMORY_EVAL_SUCC5_MANIFEST,
        MEMORY_EVAL_SUCC4_MANIFEST,
    ]) {
        if (datasetVersion === manifest.datasetVersion) {
            return {
                datasetDigest: manifest.datasetDigest,
                scoringContractDigest: manifest.scoringContractDigest,
                scoringContractVersion: manifest.scoringContractVersion,
            };
        }
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
    // A dataset bound to a superseded contract is not a run target, whatever
    // else agrees. `mem-score-v3.3` describes itself as scoring schema 2 while
    // scoring schema 3, and @mposition's 2026-08-28 decision keeps it as
    // historical evidence rather than repairing it in place: a decision-grade
    // number computed under a contract whose own description is wrong is not
    // one an audit note can fix afterwards.
    //
    // Checked here rather than left to the digest comparison below, because
    // that comparison cannot see it: an earlier contract's constants are gone
    // from the tree, so its digest is read from the record and matches itself.
    if (target.scoringContractVersion !== MEMORY_EVAL_SCORING_CONTRACT_VERSION) {
        failures.push(
            `${target.datasetVersion} is bound to ${target.scoringContractVersion}, ` +
                `and the live contract is ${MEMORY_EVAL_SCORING_CONTRACT_VERSION}. A ` +
                "superseded contract is evidence, not a run target — its successor " +
                "dataset carries the same cases under the corrected contract."
        );
    }
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

/**
 * The tuple a run would be billed under, built once for every caller.
 *
 * The live harness used to assemble this inline, with
 * `MEMORY_EVAL_SUCC5_MANIFEST.manifestDigest` written into it by name. That
 * survived the switch to succ-6 because nothing compared it against anything:
 * the budget test built its own tuple and checked that, so it passed while
 * the bytes a real run would present stayed wrong. A succ-6 budget would then
 * have been refused as `budget_tuple_mismatch` — after approval, at the point
 * of spending.
 *
 * So there is one builder and both the harness and the test call it. A test
 * that constructs the object it is checking is testing its own arithmetic.
 */
export type HarnessRunTuple = {
    datasetVersion: string;
    datasetDigest: string;
    datasetManifestDigest: string | null;
    scoringContractVersion: string;
    scoringContractDigest: string;
    promptVersion: string;
    promptDigest: string;
};

export function harnessRunTuple(input: {
    target?: HarnessTarget;
    promptVersion: string;
    promptDigest: string;
}): HarnessRunTuple {
    const target = input.target ?? harnessTarget();
    return {
        datasetVersion: target.datasetVersion,
        datasetDigest: target.datasetDigest,
        datasetManifestDigest: target.datasetManifestDigest,
        scoringContractVersion: target.scoringContractVersion,
        scoringContractDigest: target.scoringContractDigest,
        promptVersion: input.promptVersion,
        promptDigest: input.promptDigest,
    };
}
