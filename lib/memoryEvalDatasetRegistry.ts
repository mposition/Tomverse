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
 * stamps `artifactSchema`, and an artifact that declares 2 or later must carry
 * both digests. Guessing from `generatedAt` would silently admit a new
 * artifact that lost the field. The cutoff is written as the literal `2`
 * rather than as `MEMORY_EVAL_ARTIFACT_SCHEMA`: bumping the constant for a
 * later envelope change would otherwise stop requiring the contract digest of
 * every artifact between the two versions.
 *
 * ## Two manifest shapes
 *
 * Schema 1 and 2 are recorded in `MEMORY_EVAL_DATASET_MANIFESTS` as batches
 * plus unbatched cases. Schema 3 is not: `mem-eval-succ-4` is a transition
 * from its predecessor -- 1,047 inherited cases and 103 replacements -- and
 * its manifest records that composition instead. Rather than widen the frozen
 * schema-1/2 structure to hold a shape it never had, schema-3 datasets are
 * looked up in their own table and verified by their own verifier. The two
 * paths answer with the same resolution type, so no consumer has to know
 * which one ran.
 */

import {
    MEMORY_EVAL_DATASET_MANIFESTS,
    verifyEvalDatasetManifest,
    type EvalDatasetComposition,
} from "@/lib/memoryEvalDatasetManifests";
import { EVAL_DATASET_COMPOSITIONS as COMPOSITIONS } from "@/lib/memoryEvalDatasetCompositions";
import { MEMORY_EVAL_SUCC4_CASES } from "@/lib/memoryEvalSucc4Dataset";
import {
    MEMORY_EVAL_SUCC4_MANIFEST,
    verifySucc4Manifest,
} from "@/lib/memoryEvalSucc4Manifest";
import {
    MEMORY_EVAL_SUCC6_CASES,
    MEMORY_EVAL_SUCC6_MANIFEST,
    verifySucc6Manifest,
} from "@/lib/memoryEvalSucc6";
import {
    MEMORY_EVAL_SUCC7_CASES,
    MEMORY_EVAL_SUCC7_MANIFEST,
    verifySucc7Manifest,
} from "@/lib/memoryEvalSucc7";
import {
    MEMORY_EVAL_SUCC8_CASES,
    MEMORY_EVAL_SUCC8_MANIFEST,
    verifySucc8Manifest,
} from "@/lib/memoryEvalSucc8";
import {
    MEMORY_EVAL_SUCC9_CASES,
    buildSucc9Manifest,
    succ9Problems,
} from "@/lib/memoryEvalSucc9";
import {
    MEMORY_EVAL_SUCC5_CASES,
    MEMORY_EVAL_SUCC5_MANIFEST,
    verifySucc5Manifest,
} from "@/lib/memoryEvalSucc5";
import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";

/**
 * The artifact envelope version this tree writes.
 *
 * Bumped when a reader must be able to tell a new artifact from an old one.
 * `1` is every artifact written before the field existed, and is what an
 * artifact with no `artifactSchema` is read as.
 */
export const MEMORY_EVAL_ARTIFACT_SCHEMA = 3;

/**
 * The envelope version from which an artifact must name its dataset's schema.
 *
 * `3`, because that is the envelope that added `datasetSchemaVersion`. An
 * artifact written before it does not carry the field and is bound to the
 * schema its manifest records, which is the same answer — the field exists so
 * that a *disagreement* is visible, not because the schema was previously
 * unknown.
 */
export const MEMORY_EVAL_ARTIFACT_SCHEMA_WITH_DATASET_SCHEMA = 3;

/**
 * The envelope version from which an artifact must carry a contract digest.
 *
 * Pinned as `2` rather than read off `MEMORY_EVAL_ARTIFACT_SCHEMA`. It used to
 * be the moving constant, and bumping that constant to 3 would have stopped
 * requiring the digest of every artifact written at envelope 2 — turning a
 * harness defect back into `absent_historical`, which is the one reading this
 * check exists to refuse.
 */
export const MEMORY_EVAL_ARTIFACT_SCHEMA_WITH_CONTRACT_DIGEST = 2;

/** The dataset schema versions this tree can score. */
export const MEMORY_EVAL_SUPPORTED_DATASET_SCHEMAS: readonly number[] = [1, 2, 3];

/**
 * Re-exported from `lib/memoryEvalDatasetCompositions.ts`, where it moved on
 * 2026-08-31 to break a cycle. Every existing consumer imports it from here,
 * and the table's own module explains why it is no longer defined here.
 */
export { EVAL_DATASET_COMPOSITIONS } from "@/lib/memoryEvalDatasetCompositions";

/**
 * The identity every schema-3 manifest shares, whatever its composition.
 *
 * `mem-eval-succ-4` records a transition from its predecessor and
 * `mem-eval-succ-5` records a contract correction; the two composition shapes
 * have nothing in common and neither is any consumer's business. What every
 * consumer needs is the identity, so that is what the table is typed on.
 */
type Schema3ManifestIdentity = {
    datasetVersion: string;
    schemaVersion: 3;
    supersedes: string;
    caseCount: number;
    cellCounts: Readonly<Record<string, number>>;
    datasetDigest: string;
    scoringContractDigest: string;
    scoringContractVersion: string;
};

type Schema3Dataset = {
    manifest: Schema3ManifestIdentity;
    cases: readonly MemoryEvalCaseV3[];
    verify: () => readonly string[];
};

/**
 * Schema-3 datasets, with the verifier each one is checked by.
 *
 * A table rather than a branch on the version string: `mem-eval-succ-5` will
 * be a row here, and a special case named after one dataset would have to be
 * rewritten to admit it.
 *
 * Built on call rather than at module load, and that is not a style choice.
 * `lib/memoryEvalSucc4Manifest.ts` imports `EVAL_DATASET_COMPOSITIONS` from
 * this module to read its predecessor's composition, so the two modules are a
 * cycle. Reading `MEMORY_EVAL_SUCC4_MANIFEST` while this module is still
 * initialising throws; reading it when someone resolves an artifact does not,
 * because by then both halves have finished loading.
 */
const schema3Datasets = (): readonly Schema3Dataset[] => [
    {
        // Superseded by succ-5 and kept resolvable. Its artifacts were scored
        // against `mem-score-v3.3` and stay readable; dropping the row would
        // make every one of them unresolvable, which is the failure the
        // registry exists to prevent.
        manifest: MEMORY_EVAL_SUCC4_MANIFEST,
        cases: MEMORY_EVAL_SUCC4_CASES,
        verify: () => verifySucc4Manifest(MEMORY_EVAL_SUCC4_MANIFEST),
    },
    {
        // Superseded by succ-6 and kept resolvable for the same reason succ-4
        // is: the 2026-08-29 decision-grade run was scored against it, and
        // that artifact has to stay readable.
        manifest: MEMORY_EVAL_SUCC5_MANIFEST,
        cases: MEMORY_EVAL_SUCC5_CASES,
        verify: () => verifySucc5Manifest(),
    },
    {
        manifest: MEMORY_EVAL_SUCC6_MANIFEST,
        cases: MEMORY_EVAL_SUCC6_CASES,
        // Takes no argument, so it compares the pinned record against the
        // tree rather than an argument against itself — see the note on
        // `verifySucc6Manifest`.
        verify: () => verifySucc6Manifest(),
    },
    {
        // Frozen and signed on 2026-09-03, superseded the same day by succ-8,
        // and never run. It is here for the reason succ-4 is: a signature and
        // a frozen manifest are records, and a record nobody can resolve is
        // not one.
        manifest: MEMORY_EVAL_SUCC7_MANIFEST,
        cases: MEMORY_EVAL_SUCC7_CASES,
        verify: () => verifySucc7Manifest(),
    },
    {
        // The live target. succ-8 shares succ-7's cases by reference, so its
        // `datasetDigest` is succ-7's — which is why `resolveArtifactDataset`
        // has to match on the version first and the digest second. Matching on
        // the digest alone would resolve a succ-8 artifact to succ-7 and read
        // its numbers under the superseded `mem-score-v3.4`.
        manifest: MEMORY_EVAL_SUCC8_MANIFEST,
        cases: MEMORY_EVAL_SUCC8_CASES,
        verify: () => verifySucc8Manifest(),
    },
    {
        // Assembled 2026-09-04 and not yet signed. Registered so an artifact
        // naming it resolves at all; the harness still scores succ-8, which
        // is a separate decision from having the sample.
        manifest: buildSucc9Manifest(),
        cases: MEMORY_EVAL_SUCC9_CASES,
        verify: () => succ9Problems(),
    },
];

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
    | "dataset_drifted"
    | "unsupported_dataset_schema"
    | "dataset_schema_mismatch";

/**
 * What a consumer reads off a resolved manifest.
 *
 * Deliberately the intersection of the two manifest shapes rather than a
 * union of them: every consumer wants the dataset's identity, and none of
 * them wants the composition, which is the half that differs. A consumer
 * needing the composition should read its own manifest module and say so.
 */
export type ResolvedDatasetIdentity = {
    datasetVersion: string;
    schemaVersion: number;
    supersedes: string | null;
    caseCount: number;
    cellCounts: Readonly<Record<string, number>>;
    datasetDigest: string;
    scoringContractDigest: string | null;
    scoringContractVersion: string | null;
};

/** The cases, tagged with the schema that decides which scorer reads them. */
export type ResolvedDatasetCases =
    | EvalDatasetComposition
    | { schemaVersion: 3; cases: readonly MemoryEvalCaseV3[] };

export type ArtifactDatasetResolution =
    | {
          ok: true;
          manifest: ResolvedDatasetIdentity;
          composition: ResolvedDatasetCases;
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
/**
 * The dataset schema the artifact says it ran on, or `null` if it is silent.
 *
 * A non-integer or an unsupported number is not silence — it is a claim this
 * tree cannot honour, and reading it as absent would score the artifact
 * against whatever the manifest happened to say.
 */
const declaredDatasetSchema = (
    artifactManifest: Record<string, unknown> | null | undefined
): { ok: true; value: number | null } | { ok: false; raw: unknown } => {
    const raw = artifactManifest?.datasetSchemaVersion;
    if (raw === undefined || raw === null) return { ok: true, value: null };
    if (
        typeof raw !== "number" ||
        !Number.isInteger(raw) ||
        !MEMORY_EVAL_SUPPORTED_DATASET_SCHEMAS.includes(raw)
    ) {
        return { ok: false, raw };
    }
    return { ok: true, value: raw };
};

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

    const schema = declaredDatasetSchema(artifactManifest);
    if (!schema.ok) {
        return refuse(
            "unsupported_dataset_schema",
            `The artifact declares dataset schema ${JSON.stringify(schema.raw)}, ` +
                `and this tree scores ${MEMORY_EVAL_SUPPORTED_DATASET_SCHEMAS.join(", ")}. ` +
                "A schema nothing here can read is refused rather than treated as " +
                "unstated: the fields a scorer needs differ between schemas, so " +
                "guessing would score the artifact under a contract it never ran."
        );
    }

    /* --- schema 3 has its own manifest shape ----------------------------- */

    const schema3 = schema3Datasets().find(
        (entry) => entry.manifest.datasetVersion === declaredVersion
    );
    if (schema3) {
        return resolveSchema3(
            artifactManifest,
            schema3,
            declaredDigest,
            schema.value
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
    } else if (artifactSchema >= MEMORY_EVAL_ARTIFACT_SCHEMA_WITH_CONTRACT_DIGEST) {
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

    if (schema.value !== null && schema.value !== manifest.schemaVersion) {
        return refuse(
            "dataset_schema_mismatch",
            `The artifact says it ran on dataset schema ${schema.value} and ` +
                `${declaredVersion} is recorded as schema ${manifest.schemaVersion}. ` +
                "One of the two is wrong, and each schema has its own scorer — " +
                "picking either would report numbers under a contract the run did " +
                "not use."
        );
    }

    /* --- can this tree still supply the cases? --------------------------- */

    const composition = COMPOSITIONS[declaredVersion];
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

/**
 * The schema-3 arm of `resolveArtifactDataset()`.
 *
 * It asks the same questions in the same order — digest, contract, drift —
 * and differs only in where the answers come from. Kept as its own function
 * rather than as branches inside the schema-1/2 path, so that path stays
 * exactly the code every recorded artifact has already been resolved by.
 */
function resolveSchema3(
    artifactManifest: Record<string, unknown> | null | undefined,
    entry: Schema3Dataset,
    declaredDigest: string,
    declaredSchema: number | null
): ArtifactDatasetResolution {
    const { manifest } = entry;

    if (declaredSchema !== null && declaredSchema !== manifest.schemaVersion) {
        return refuse(
            "dataset_schema_mismatch",
            `The artifact says it ran on dataset schema ${declaredSchema} and ` +
                `${manifest.datasetVersion} is recorded as schema ${manifest.schemaVersion}.`
        );
    }
    if (manifest.datasetDigest !== declaredDigest) {
        return refuse(
            "digest_mismatch",
            `${manifest.datasetVersion} is recorded with digest ${manifest.datasetDigest}, ` +
                `and the artifact carries ${declaredDigest}. A frozen dataset that ` +
                "fingerprints differently was edited after the run — the manifest is " +
                "the record, so restore the dataset rather than the other way round."
        );
    }

    const rawSchema = artifactManifest?.artifactSchema;
    const artifactSchema =
        typeof rawSchema === "number" && Number.isInteger(rawSchema)
            ? rawSchema
            : 1;
    const declaredContract = artifactManifest?.scoringContractDigest;
    // No `absent_historical` arm: there are no schema-3 artifacts older than
    // the contract digest, so admitting one would be admitting a field that
    // went missing rather than one that never existed.
    if (typeof declaredContract !== "string" || declaredContract === "") {
        return refuse(
            "scoring_contract_missing",
            `A schema-3 artifact must record a scoring contract digest, and this ` +
                `one does not (envelope ${artifactSchema}). Schema 3 has never been ` +
                "scored without one, so the field is missing rather than predating " +
                "the contract."
        );
    }
    if (declaredContract !== manifest.scoringContractDigest) {
        return refuse(
            "scoring_contract_mismatch",
            `The artifact was scored with contract digest ${declaredContract} and ` +
                `${manifest.datasetVersion} is recorded with ${manifest.scoringContractDigest}. ` +
                "Under schema 3 the dataset digest covers the labelling as well, so " +
                "this digest is the contract's own rules — thresholds, matching and " +
                "the evidence-binding rule — and a run scored under different ones " +
                "is not comparable."
        );
    }

    const mismatches = entry.verify();
    if (mismatches.length > 0) {
        return refuse(
            "dataset_drifted",
            `${manifest.datasetVersion} no longer matches its manifest, so the cases ` +
                "in this tree are not the ones the artifact was scored against:\n  " +
                mismatches.join("\n  ")
        );
    }

    return {
        ok: true,
        manifest,
        composition: { schemaVersion: 3, cases: entry.cases },
        scoringContract: "verified",
        artifactSchema,
    };
}
