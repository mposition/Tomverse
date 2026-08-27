/**
 * Which dataset an eval artifact was scored against, and whether this tree
 * can still read it.
 *
 * ## The problem this replaces
 *
 * Every artifact consumer used to import one dataset and compare the
 * artifact's digest against it. That is correct while there is one dataset
 * and fatal the moment there are two: after `mem-eval-succ-3` is wired,
 * `report:memory-eval-failures` pointed at run1's artifact would refuse
 * forever with "check out the commit the artifact names" — and succ-2's cases
 * would be sitting right there in the tree, unread, because the script had no
 * way to select them.
 *
 * A superseded dataset that is preserved but unreadable is not preserved. So
 * selection moves from an import to a lookup: the artifact says which version
 * and which digest, and this module answers with the cases or with a named
 * refusal.
 *
 * ## Fail-closed, on every axis
 *
 * A wrong answer here is the worst kind available: the report would classify
 * one run's answers against another run's gold labels and read as confident.
 * So resolution refuses unless exactly one manifest matches the version,
 * exactly one matches the digest, and they are the same manifest — an
 * unregistered version, an ambiguous one, and a digest that belongs to a
 * different version are three separate refusals rather than one fallback.
 *
 * ## Historical artifacts
 *
 * An artifact written before `scoringContractDigest` existed does not carry
 * one, and refusing it on that ground would destroy exactly what the manifest
 * work was for. Those bind to the manifest's recorded contract digest and are
 * reported as `absent_historical`.
 *
 * The cutoff is explicit rather than guessed from a date: the harness now
 * stamps `artifactSchema`, and an artifact that declares
 * `MEMORY_EVAL_ARTIFACT_SCHEMA` or later must carry both digests. Guessing
 * from `generatedAt` would silently admit a new artifact that lost the field.
 */

import {
    MEMORY_EVAL_DATASET_MANIFESTS,
    verifyEvalDatasetManifest,
    type EvalDatasetComposition,
    type EvalDatasetManifest,
} from "@/lib/memoryEvalDatasetManifests";
import { MEMORY_EVAL_CASES } from "@/lib/memoryExtractionEvalFixtures";
import { ADOPTED_BATCHES } from "@/lib/memoryExtractionEvalAdopted";
import { MEMORY_EVAL_SUCCESSOR_CASES } from "@/lib/memoryEvalSuccessorFixtures";
import { SUCCESSOR_ADOPTED_BATCHES } from "@/lib/memoryEvalSuccessorAdopted";
import { MEMORY_EVAL_SUCC3_CASES } from "@/lib/memoryEvalSucc3Fixtures";
import { SUCC3_ADOPTED_BATCHES } from "@/lib/memoryEvalSucc3Adopted";

/**
 * The artifact envelope version this tree writes.
 *
 * Bumped when a reader must be able to tell a new artifact from an old one.
 * `1` is every artifact written before the field existed, and is what an
 * artifact with no `artifactSchema` is read as.
 */
export const MEMORY_EVAL_ARTIFACT_SCHEMA = 2;

/**
 * Every dataset this tree can still supply cases for, by version.
 *
 * A manifest without an entry here is still a record — it says what the
 * dataset was — but its artifacts cannot be classified, because classifying
 * a record means comparing it against that case's gold labels.
 */
export const EVAL_DATASET_COMPOSITIONS: Readonly<
    Record<string, EvalDatasetComposition>
> = {
    "mem-eval-seed-11": {
        schemaVersion: 1,
        batches: ADOPTED_BATCHES,
        cases: MEMORY_EVAL_CASES,
    },
    "mem-eval-succ-2": {
        schemaVersion: 2,
        batches: SUCCESSOR_ADOPTED_BATCHES,
        cases: MEMORY_EVAL_SUCCESSOR_CASES,
    },
    "mem-eval-succ-3": {
        schemaVersion: 2,
        batches: SUCC3_ADOPTED_BATCHES,
        cases: MEMORY_EVAL_SUCC3_CASES,
    },
};

export type ArtifactDatasetRefusalReason =
    | "no_dataset_version"
    | "no_dataset_digest"
    | "unregistered_version"
    | "ambiguous_version"
    | "ambiguous_digest"
    | "digest_belongs_elsewhere"
    | "digest_mismatch"
    | "scoring_contract_missing"
    | "scoring_contract_mismatch"
    | "dataset_not_in_tree"
    | "dataset_drifted";

export type ArtifactDatasetResolution =
    | {
          ok: true;
          manifest: EvalDatasetManifest;
          composition: EvalDatasetComposition;
          /**
           * `verified` — the artifact carried a contract digest and it matched.
           * `absent_historical` — it predates the field and is bound to the
           * manifest's recorded value.
           */
          scoringContract: "verified" | "absent_historical";
          artifactSchema: number;
      }
    | {
          ok: false;
          reason: ArtifactDatasetRefusalReason;
          /** One paragraph a person can act on. */
          detail: string;
      };

const refuse = (
    reason: ArtifactDatasetRefusalReason,
    detail: string
): ArtifactDatasetResolution => ({ ok: false, reason, detail });

/**
 * @param artifactManifest the artifact's own `manifest` object, as parsed.
 */
export function resolveArtifactDataset(
    artifactManifest: Record<string, unknown> | null | undefined
): ArtifactDatasetResolution {
    const declaredVersion = artifactManifest?.datasetVersion;
    const declaredDigest = artifactManifest?.datasetDigest;

    if (typeof declaredVersion !== "string" || declaredVersion === "") {
        return refuse(
            "no_dataset_version",
            "The artifact does not name a dataset version, so there is nothing to " +
                "resolve. Every artifact this harness writes names one; a file without " +
                "it is not an eval artifact."
        );
    }
    if (typeof declaredDigest !== "string" || declaredDigest === "") {
        return refuse(
            "no_dataset_digest",
            `The artifact names ${declaredVersion} but carries no dataset digest, so ` +
                "there is no way to tell which state of that version it ran on. A " +
                "version string alone is not identity."
        );
    }

    const byVersion = MEMORY_EVAL_DATASET_MANIFESTS.filter(
        (manifest) => manifest.datasetVersion === declaredVersion
    );
    if (byVersion.length === 0) {
        return refuse(
            "unregistered_version",
            `No manifest records ${declaredVersion}. Reading the artifact against any ` +
                "other dataset would classify its answers with gold labels that were " +
                "never applied to them. Add the manifest, or read the artifact from the " +
                `commit it names (${String(artifactManifest?.commitSha ?? "unknown")}).`
        );
    }
    if (byVersion.length > 1) {
        return refuse(
            "ambiguous_version",
            `${byVersion.length} manifests record ${declaredVersion}. A version has to ` +
                "identify one dataset, and there is no rule for choosing between them."
        );
    }

    const byDigest = MEMORY_EVAL_DATASET_MANIFESTS.filter(
        (manifest) => manifest.datasetDigest === declaredDigest
    );
    if (byDigest.length > 1) {
        return refuse(
            "ambiguous_digest",
            `${byDigest.length} manifests record the digest ${declaredDigest} ` +
                `(${byDigest.map((m) => m.datasetVersion).join(", ")}). Two versions ` +
                "holding identical contents makes the artifact's own claim ambiguous."
        );
    }

    const [manifest] = byVersion;
    if (byDigest.length === 1 && byDigest[0] !== manifest) {
        return refuse(
            "digest_belongs_elsewhere",
            `The artifact says ${declaredVersion}, but its digest is the one recorded ` +
                `for ${byDigest[0].datasetVersion}. One of the two is mislabelled, and ` +
                "guessing which would put the wrong gold labels behind every line of the " +
                "report."
        );
    }
    if (manifest.datasetDigest !== declaredDigest) {
        return refuse(
            "digest_mismatch",
            `${declaredVersion} is recorded with digest ${manifest.datasetDigest}, and ` +
                `the artifact carries ${declaredDigest}. A frozen dataset that ` +
                "fingerprints differently was edited after the run — the manifest is the " +
                "record, so restore the dataset rather than the other way round."
        );
    }

    /* --- the scoring contract ------------------------------------------- */

    const rawSchema = artifactManifest?.artifactSchema;
    const artifactSchema =
        typeof rawSchema === "number" && Number.isInteger(rawSchema)
            ? rawSchema
            : 1;
    const declaredContract = artifactManifest?.scoringContractDigest;

    let scoringContract: "verified" | "absent_historical";
    if (typeof declaredContract === "string" && declaredContract !== "") {
        if (declaredContract !== manifest.scoringContractDigest) {
            return refuse(
                "scoring_contract_mismatch",
                `The artifact was scored with contract digest ${declaredContract} and ` +
                    `${declaredVersion} is recorded with ${String(
                        manifest.scoringContractDigest
                    )}. The dataset digest does not cover expectedDisposition, ` +
                    "goldCompleteness, mustIncludeAny or criticalGoldMode, so two runs can " +
                    "agree on it and still have been scored on different labels. This is " +
                    "the difference that digest exists to show."
            );
        }
        scoringContract = "verified";
    } else if (artifactSchema >= MEMORY_EVAL_ARTIFACT_SCHEMA) {
        return refuse(
            "scoring_contract_missing",
            `The artifact declares schema ${artifactSchema}, so it must record a ` +
                "scoring contract digest, and it does not. Artifacts written before the " +
                "field existed declare no schema and are read against the manifest's " +
                "recorded value; a current one that lost the field is a harness defect."
        );
    } else {
        scoringContract = "absent_historical";
    }

    /* --- can this tree still supply the cases? --------------------------- */

    const composition = EVAL_DATASET_COMPOSITIONS[declaredVersion];
    if (!composition) {
        return refuse(
            "dataset_not_in_tree",
            `${declaredVersion} has a manifest but its cases are no longer in this ` +
                "tree, so its records cannot be classified — that needs each case's gold " +
                `labels. Read the artifact from the commit it names (${String(
                    artifactManifest?.commitSha ?? "unknown"
                )}).`
        );
    }

    const verification = verifyEvalDatasetManifest(manifest, composition);
    if (verification.mismatches.length > 0) {
        return refuse(
            "dataset_drifted",
            `${declaredVersion} no longer matches its manifest, so the cases in this ` +
                "tree are not the ones the artifact was scored against:\n  " +
                verification.mismatches.join("\n  ")
        );
    }

    return {
        ok: true,
        manifest,
        composition,
        scoringContract,
        artifactSchema,
    };
}
