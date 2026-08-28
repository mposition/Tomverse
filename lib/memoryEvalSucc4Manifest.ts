/**
 * The `succ-4` composition, and what freezes it.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12.10.
 *
 * ## Why this is not a row in `MEMORY_EVAL_DATASET_MANIFESTS`
 *
 * That registry records datasets composed of adopted batches: a list of
 * batches, plus whatever belongs to none of them. `succ-4` is not composed
 * that way. Its 1,047 inherited cases are not newly adopted and are not
 * unadopted either -- they came from `succ-3`'s batches and were re-read under
 * schema 3 -- and its 103 replacements were written and reviewed in five
 * tranches, which is a unit that registry has no word for. Filing either as
 * `unbatched` would say they arrived with no adoption record, which is the one
 * thing that is not true about them.
 *
 * So the composition says what actually happened: a transition from a named
 * source dataset, with each inherited component carrying **two** digests --
 * the source batch's own, unchanged, as proof of where it came from, and a
 * schema-3 digest of what the transition made of it. Reusing the first as the
 * second would claim the relabelling changed nothing, and relabelling is the
 * whole of what happened to those 1,047 cases.
 *
 * ## The regression corpus is not in here
 *
 * Not in the composition, not in the dataset digest, not in the contract
 * digest. It is history, and history that moved a decision digest would make
 * every archived verdict unciteable the next time someone corrected a note.
 * The three things that hold that line are checked rather than asserted:
 * `tests/memoryEvalSucc4Dataset.test.mjs` walks the import graph, the digest
 * functions below take `MEMORY_EVAL_SUCC4_CASES` and nothing else, and
 * `tests/memoryEvalSucc4Manifest.test.mjs` checks the two id sets do not
 * intersect and that a digest over the canonical list is unchanged by what the
 * regression corpus holds.
 */

import { createHash } from "node:crypto";

import { datasetFingerprintInputV3 } from "@/lib/memoryEvalDatasetSchemaV3";
import {
    MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    scoringContractDescriptorInput,
} from "@/lib/memoryEvalScoringContractDigest";
import { adoptedBatchDigest } from "@/lib/memoryEvalAdoptedBatchSuccession";
import { EVAL_DATASET_COMPOSITIONS } from "@/lib/memoryEvalDatasetRegistry";
import { evalDatasetManifest } from "@/lib/memoryEvalDatasetManifests";
import {
    MEMORY_EVAL_SUCC4_CASES,
    MEMORY_EVAL_SUCC4_DATASET_VERSION,
    MEMORY_EVAL_SUCC4_SUPERSEDES,
    succ4CellCounts,
} from "@/lib/memoryEvalSucc4Dataset";
import {
    SUCC4_TRANSITIONS,
    succ4TransitionFingerprintInput,
} from "@/lib/memoryEvalSucc4Transition";
import { SUCC4_TRANCHE_1 } from "@/lib/memoryEvalSucc4Replacements/tranche1";
import { SUCC4_TRANCHE_2 } from "@/lib/memoryEvalSucc4Replacements/tranche2";
import { SUCC4_TRANCHE_3 } from "@/lib/memoryEvalSucc4Replacements/tranche3";
import { SUCC4_TRANCHE_4 } from "@/lib/memoryEvalSucc4Replacements/tranche4";
import { SUCC4_TRANCHE_5 } from "@/lib/memoryEvalSucc4Replacements/tranche5";

const sha256 = (input: string): string =>
    createHash("sha256").update(input, "utf8").digest("hex");

/** A `succ-3` batch, and what the transition made of the cases that stayed. */
export type Succ4InheritedComponent = {
    sourceBatchId: string;
    /** The source batch's own digest, over all its cases. Provenance. */
    sourceBatchDigest: string;
    /** How many of them survive into `succ-4`. */
    caseCount: number;
    /** Schema-3 digest of the survivors as relabelled. */
    schema3ComponentDigest: string;
};

/** One of the five units the 103 replacements were written and reviewed in. */
export type Succ4ReplacementTranche = {
    trancheId: string;
    caseCount: number;
    componentDigest: string;
};

export type EvalDatasetCompositionV3 = {
    kind: "successor-transition";
    sourceDatasetVersion: "mem-eval-succ-3";
    sourceDatasetDigest: string;
    transitionManifestDigest: string;
    inheritedComponents: readonly Succ4InheritedComponent[];
    /**
     * The source dataset's own unbatched group, carried forward.
     *
     * `null` here because `succ-3` had none -- every one of its 1,150 cases
     * belongs to one of its 40 batches. The field exists so that a later
     * successor of a dataset that *does* have one records it as inherited
     * rather than as newly unadopted.
     */
    inheritedUnbatched: {
        caseCount: number;
        schema3ComponentDigest: string;
    } | null;
    replacementTranches: readonly Succ4ReplacementTranche[];
};

export type Succ4DatasetManifest = {
    datasetVersion: "mem-eval-succ-4";
    schemaVersion: 3;
    supersedes: "mem-eval-succ-3";
    composition: EvalDatasetCompositionV3;
    caseCount: number;
    cellCounts: Readonly<Record<string, number>>;
    /** sha256 of `datasetFingerprintInputV3(MEMORY_EVAL_SUCC4_CASES)`. */
    datasetDigest: string;
    /**
     * sha256 of `scoringContractDescriptorInput()` alone.
     *
     * The schema-2 form hashed the descriptor **and** a labelling pass over
     * the cases, because `datasetFingerprintInput()` read only `mustInclude`
     * and left `goldCompleteness`, `criticalGoldMode`, gold ids, dispositions
     * and `mustIncludeAny` uncovered. `datasetFingerprintInputV3()` covers all
     * of that and the anchors besides, so hashing it again here would pin the
     * same bytes twice -- and an edit would move both digests, leaving a
     * reader unable to say which one is the dataset and which the contract.
     */
    scoringContractDigest: string;
    scoringContractVersion: string;
};

const TRANCHES = [
    { id: "succ4-tranche-1", entries: SUCC4_TRANCHE_1 },
    { id: "succ4-tranche-2", entries: SUCC4_TRANCHE_2 },
    { id: "succ4-tranche-3", entries: SUCC4_TRANCHE_3 },
    { id: "succ4-tranche-4", entries: SUCC4_TRANCHE_4 },
    { id: "succ4-tranche-5", entries: SUCC4_TRANCHE_5 },
];

/** sha256 over the transition manifest, so the 103 pairings freeze too. */
export const succ4TransitionManifestDigest = (): string =>
    sha256(succ4TransitionFingerprintInput(SUCC4_TRANSITIONS));

/** sha256 over the canonical decision set, and over nothing else. */
export const succ4DatasetDigest = (): string =>
    sha256(datasetFingerprintInputV3(MEMORY_EVAL_SUCC4_CASES));

/** sha256 over the scoring contract descriptor. See the manifest field. */
export const succ4ScoringContractDigest = (): string =>
    sha256(scoringContractDescriptorInput());

/**
 * The composition as the tree holds it now.
 *
 * Recomputed rather than recorded, so that the recorded manifest has something
 * to be checked against. Nothing here reads the regression corpus.
 */
export function buildSucc4Composition(): EvalDatasetCompositionV3 {
    const source = EVAL_DATASET_COMPOSITIONS[MEMORY_EVAL_SUCC4_SUPERSEDES];
    if (!source) {
        throw new Error(
            `succ-4: the registry cannot supply ${MEMORY_EVAL_SUCC4_SUPERSEDES}, so its composition cannot be proved`
        );
    }

    const sourceManifest = evalDatasetManifest(MEMORY_EVAL_SUCC4_SUPERSEDES);
    if (!sourceManifest) {
        throw new Error(
            `succ-4: ${MEMORY_EVAL_SUCC4_SUPERSEDES} has no recorded manifest, so there is no source digest to point at`
        );
    }

    const succ4ById = new Map(MEMORY_EVAL_SUCC4_CASES.map((c) => [c.id, c]));
    const replacementIds = new Set(
        TRANCHES.flatMap((tranche) =>
            tranche.entries.map((entry) => entry.replacement.id)
        )
    );

    const inheritedComponents = source.batches.map((batch) => {
        const survivors = batch.cases
            .map((testCase) => succ4ById.get(testCase.id))
            .filter(
                (testCase): testCase is NonNullable<typeof testCase> =>
                    testCase !== undefined && !replacementIds.has(testCase.id)
            );
        return {
            sourceBatchId: batch.id,
            sourceBatchDigest: adoptedBatchDigest(batch.cases),
            caseCount: survivors.length,
            schema3ComponentDigest: sha256(datasetFingerprintInputV3(survivors)),
        };
    });

    return {
        kind: "successor-transition",
        sourceDatasetVersion: "mem-eval-succ-3",
        sourceDatasetDigest: sourceManifest.datasetDigest,
        transitionManifestDigest: succ4TransitionManifestDigest(),
        inheritedComponents,
        inheritedUnbatched: null,
        replacementTranches: TRANCHES.map((tranche) => ({
            trancheId: tranche.id,
            caseCount: tranche.entries.length,
            componentDigest: sha256(
                datasetFingerprintInputV3(
                    tranche.entries.map((entry) => entry.replacement)
                )
            ),
        })),
    };
}

/** What the tree says the manifest should be, ready to be frozen. */
export function buildSucc4Manifest(): Succ4DatasetManifest {
    return {
        datasetVersion: "mem-eval-succ-4",
        schemaVersion: 3,
        supersedes: "mem-eval-succ-3",
        composition: buildSucc4Composition(),
        caseCount: MEMORY_EVAL_SUCC4_CASES.length,
        cellCounts: succ4CellCounts(),
        datasetDigest: succ4DatasetDigest(),
        scoringContractDigest: succ4ScoringContractDigest(),
        scoringContractVersion: MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    };
}

/**
 * Every way the tree can have moved away from a recorded manifest.
 *
 * Reports all of them rather than throwing on the first: a dataset that moved
 * usually moved in more than one way, and one line per round trip is how a
 * reader gives up.
 */
export function verifySucc4Manifest(
    manifest: Succ4DatasetManifest
): readonly string[] {
    const mismatches: string[] = [];
    const say = (line: string) => mismatches.push(line);
    const live = buildSucc4Manifest();

    if (manifest.datasetVersion !== MEMORY_EVAL_SUCC4_DATASET_VERSION) {
        say(
            `dataset version: manifest says ${manifest.datasetVersion}, the tree says ${MEMORY_EVAL_SUCC4_DATASET_VERSION}`
        );
    }
    if (manifest.caseCount !== live.caseCount) {
        say(`case count: ${manifest.caseCount} -> ${live.caseCount}`);
    }
    for (const [cell, count] of Object.entries(manifest.cellCounts)) {
        if (live.cellCounts[cell] !== count) {
            say(`${cell}: ${count} -> ${live.cellCounts[cell] ?? 0}`);
        }
    }
    for (const cell of Object.keys(live.cellCounts)) {
        if (!(cell in manifest.cellCounts)) {
            say(`${cell}: unrecorded, now ${live.cellCounts[cell]}`);
        }
    }
    if (manifest.datasetDigest !== live.datasetDigest) {
        say(`dataset digest: ${manifest.datasetDigest} -> ${live.datasetDigest}`);
    }
    if (manifest.scoringContractVersion !== live.scoringContractVersion) {
        say(
            `scoring contract version: ${manifest.scoringContractVersion} -> ${live.scoringContractVersion}`
        );
    } else if (manifest.scoringContractDigest !== live.scoringContractDigest) {
        say(
            `scoring contract digest: ${manifest.scoringContractDigest} -> ${live.scoringContractDigest}`
        );
    }

    const recorded = manifest.composition;
    const actual = live.composition;
    if (recorded.sourceDatasetDigest !== actual.sourceDatasetDigest) {
        say(
            `source dataset digest: ${recorded.sourceDatasetDigest} -> ${actual.sourceDatasetDigest}`
        );
    }
    if (recorded.transitionManifestDigest !== actual.transitionManifestDigest) {
        say(
            `transition manifest digest: ${recorded.transitionManifestDigest} -> ${actual.transitionManifestDigest}`
        );
    }

    const recordedIds = recorded.inheritedComponents.map((c) => c.sourceBatchId);
    const actualIds = actual.inheritedComponents.map((c) => c.sourceBatchId);
    if (recordedIds.join(",") !== actualIds.join(",")) {
        say(
            `inherited components: manifest lists ${recordedIds.length}, the tree has ${actualIds.length}, or the order differs`
        );
    }
    const actualByBatch = new Map(
        actual.inheritedComponents.map((c) => [c.sourceBatchId, c])
    );
    for (const component of recorded.inheritedComponents) {
        const live2 = actualByBatch.get(component.sourceBatchId);
        if (!live2) continue;
        if (component.sourceBatchDigest !== live2.sourceBatchDigest) {
            say(
                `${component.sourceBatchId}: source digest ${component.sourceBatchDigest} -> ${live2.sourceBatchDigest}`
            );
        }
        if (component.caseCount !== live2.caseCount) {
            say(
                `${component.sourceBatchId}: ${component.caseCount} inherited cases -> ${live2.caseCount}`
            );
        }
        if (component.schema3ComponentDigest !== live2.schema3ComponentDigest) {
            say(
                `${component.sourceBatchId}: schema-3 digest ${component.schema3ComponentDigest} -> ${live2.schema3ComponentDigest}`
            );
        }
    }

    if (
        JSON.stringify(recorded.inheritedUnbatched) !==
        JSON.stringify(actual.inheritedUnbatched)
    ) {
        say("inherited unbatched group: recorded and live differ");
    }

    const actualByTranche = new Map(
        actual.replacementTranches.map((t) => [t.trancheId, t])
    );
    if (
        recorded.replacementTranches.map((t) => t.trancheId).join(",") !==
        actual.replacementTranches.map((t) => t.trancheId).join(",")
    ) {
        say("replacement tranches: the recorded list and the tree differ");
    }
    for (const tranche of recorded.replacementTranches) {
        const live2 = actualByTranche.get(tranche.trancheId);
        if (!live2) continue;
        if (tranche.caseCount !== live2.caseCount) {
            say(
                `${tranche.trancheId}: ${tranche.caseCount} cases -> ${live2.caseCount}`
            );
        }
        if (tranche.componentDigest !== live2.componentDigest) {
            say(
                `${tranche.trancheId}: digest ${tranche.componentDigest} -> ${live2.componentDigest}`
            );
        }
    }

    return mismatches;
}

/**
 * `mem-eval-succ-4`, frozen.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12.10, 2026-08-28.
 *
 * Recorded, not computed. `buildSucc4Manifest()` says what the tree holds now;
 * this says what it held when the dataset was frozen, and
 * `verifySucc4Manifest()` reports every way the two have come apart. A failure
 * against this constant is never fixed by editing it -- either the dataset was
 * edited and must be restored, or it was genuinely reworked and needs a new
 * version with a new record.
 *
 * The 40 inherited components carry 1,047 cases between them and the five
 * tranches carry 103, which is the whole of the 1,150. Neither number is
 * written here as a total to be trusted: the verification adds them up from
 * the tree.
 */
export const MEMORY_EVAL_SUCC4_MANIFEST: Succ4DatasetManifest = {
    datasetVersion: "mem-eval-succ-4",
    schemaVersion: 3,
    supersedes: "mem-eval-succ-3",
    caseCount: 1150,
    cellCounts: {
        "assistant_only:en": 125,
        "assistant_only:ko": 125,
        "durable_facts:en": 200,
        "durable_facts:ko": 200,
        "injection_directives:en": 125,
        "injection_directives:ko": 125,
        "sensitive_secrets:en": 125,
        "sensitive_secrets:ko": 125,
    },
    datasetDigest:
        "0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0",
    scoringContractDigest:
        "19f4e4f9d5976382d83a03153ef8e7fb52b3f6dd6104efa54f53ef05cd82f777",
    scoringContractVersion: "mem-score-v3.3",
    composition: {
        kind: "successor-transition",
        sourceDatasetVersion: "mem-eval-succ-3",
        sourceDatasetDigest:
            "38468da0dce31a144d61d360189b4ce9e1d55e0e914ae66a2d61bfb1e793dc3b",
        transitionManifestDigest:
            "44bc58bad215ed572f1accd74979b19b6708453f37e474734940953edf51a325",
        inheritedUnbatched: null,
        inheritedComponents: [
            {
                sourceBatchId: "batch-143",
                sourceBatchDigest:
                    "d81f245d6ed2422aabed88a0c67e93a4d75ddf9f2c85ab58815a2e276f2c6c8c",
                caseCount: 18,
                schema3ComponentDigest:
                    "6b61e7b50f62882afd7caffc098b4498c2f55e57d94549c3a253e9a4ddf4c817",
            },
            {
                sourceBatchId: "batch-102",
                sourceBatchDigest:
                    "9fed6eeeea5d4624736ec349f7675805adfbedfa09e0cff97036ef337fc3854c",
                caseCount: 16,
                schema3ComponentDigest:
                    "cea223df02c69d9e7eaf5733f5a98f0434b13a6c0c13a12a386a9ac5ab050737",
            },
            {
                sourceBatchId: "batch-144",
                sourceBatchDigest:
                    "6d3eeb6b1b555f6c39669d0c12d73b2978fef9df60534ae41864be4a246f4b32",
                caseCount: 21,
                schema3ComponentDigest:
                    "407165fa1647cc271a1e0079eea381f6c3fe63648c15f4f23525436f105a40dd",
            },
            {
                sourceBatchId: "batch-145",
                sourceBatchDigest:
                    "cafc074f1b436fd52343b3493214d43ee1c90b5887a77d28279502161e49f3c9",
                caseCount: 19,
                schema3ComponentDigest:
                    "d155abbe4d89ef88cbaea2b0b3df6fd1cce16c8d60c173d8fde15c87a375c4ff",
            },
            {
                sourceBatchId: "batch-146",
                sourceBatchDigest:
                    "0dfade2924bd5b35f80ad0b5c8d93376a0b614a43af58bd83d806c679d5a32ad",
                caseCount: 19,
                schema3ComponentDigest:
                    "eba06154714f6e61ceefdaf2156820d214af8d09380d09d8a376e19c7391be9d",
            },
            {
                sourceBatchId: "batch-147",
                sourceBatchDigest:
                    "e228ccabf2efc1c29dbe1f260cd3cde71a1893df3dc876216b58a106afd51677",
                caseCount: 16,
                schema3ComponentDigest:
                    "a5f4393dc61a872748ba5c2011e59537ca8c24c821ed5b6845327873aa4e5356",
            },
            {
                sourceBatchId: "batch-148",
                sourceBatchDigest:
                    "1509d8b1a1f2b56ab8b02b7d60449572735504b2baca18cba5cdd0f1aceb3262",
                caseCount: 19,
                schema3ComponentDigest:
                    "d9766d631e87db0a69652cf053cad5771f4f9fec7570e0b439ef630c1bb96868",
            },
            {
                sourceBatchId: "batch-149",
                sourceBatchDigest:
                    "abeaf7835c0d606f3099379cbd7ed69ddcbeea2f8b8b8d311e4fcbc348cdd9b6",
                caseCount: 16,
                schema3ComponentDigest:
                    "df86595cea5f8752ea3adbd265405aedff767bd309d2acb00e941ef7ea98854f",
            },
            {
                sourceBatchId: "batch-150",
                sourceBatchDigest:
                    "d0e95b061d0c0545dc4f8dcb4704bcc126841de943a3692a0dcfa6b5a3df11fb",
                caseCount: 18,
                schema3ComponentDigest:
                    "da9f93d9c94eea083955cbd8a34d2e0e5f6488148c9247427b1b4e31c213cb60",
            },
            {
                sourceBatchId: "batch-151",
                sourceBatchDigest:
                    "50ee224e9672216455a9c40338bdca37ecf5202e53fc0178aa7f57ffb430a2cc",
                caseCount: 14,
                schema3ComponentDigest:
                    "51c0ea377249f34f24461ea67319999dc2b7528f315cf58e849fb6847ea27c48",
            },
            {
                sourceBatchId: "batch-152",
                sourceBatchDigest:
                    "74a9561f1a19a47eaaf9db1b3d31dfbc3a27d4d86044eba13e0fe1bd29977fa3",
                caseCount: 29,
                schema3ComponentDigest:
                    "0917242e1a1a165ec912d2490a5403915503a1d77522275cb03b1bdd88ba426a",
            },
            {
                sourceBatchId: "batch-153",
                sourceBatchDigest:
                    "bc1dd32c66c1fe08344847bc01df53464257875e854f6ad389b130ed132eb508",
                caseCount: 30,
                schema3ComponentDigest:
                    "044c0c20726b5b1a939ab8459f1666eef03106435d1c8ca4cf4894529c728dd2",
            },
            {
                sourceBatchId: "batch-154",
                sourceBatchDigest:
                    "d749824131d0253187f8082881382564d5e18b7439c4c8c40b085bde852488e3",
                caseCount: 21,
                schema3ComponentDigest:
                    "0204d62e28a731c0fa8115c26b0dd059bd2ca24530121ad3cf127c1f307d02e5",
            },
            {
                sourceBatchId: "batch-155",
                sourceBatchDigest:
                    "653c7b8f498bda66cb9a584024d91d8dc336557be2620d6f952ac720f9d3c24d",
                caseCount: 21,
                schema3ComponentDigest:
                    "f6862f923a96132f9b317cd8f408b71ff6fb0d0dbafedadee70f2c619f1ae89d",
            },
            {
                sourceBatchId: "batch-137",
                sourceBatchDigest:
                    "f18553b2b04a7d682aa8428734b0c73955d28417639abee8900efd3964e49580",
                caseCount: 24,
                schema3ComponentDigest:
                    "4fa793a46baaa6c44ba4c82a6a75286465869e9bfe28ecb5fc5552e3f3455ef2",
            },
            {
                sourceBatchId: "batch-116",
                sourceBatchDigest:
                    "7b9997ccc8c42abf2dfcfbb73702dbfc0875bfc44a00cc9f17b2e16ca03a4a28",
                caseCount: 50,
                schema3ComponentDigest:
                    "aa505566c9c32b3e02acee4d1e5900636ecaac827110b765b11b124c846ef2dc",
            },
            {
                sourceBatchId: "batch-138",
                sourceBatchDigest:
                    "6c953e4b27820aa0cdb7de9eba7f5c8b7415d69c1f03c0c64ce31dcbd5a3754d",
                caseCount: 43,
                schema3ComponentDigest:
                    "bd57cdd4fea6af3fc503736e84a9ee38461fe6da5491546fbfad05f52b8fa9fc",
            },
            {
                sourceBatchId: "batch-139",
                sourceBatchDigest:
                    "674cb40140f009438cebd77ab047d36810ace30241c985377bf719e7be2bea05",
                caseCount: 27,
                schema3ComponentDigest:
                    "e98a00a2d7446bcbfb9e8583c0f282cfeace9c771b01b8681b323472c421069d",
            },
            {
                sourceBatchId: "batch-119",
                sourceBatchDigest:
                    "888b793f62284225f52eda4ceddac6e3743aeaef6a9dc6e27f654137c85bf1d6",
                caseCount: 50,
                schema3ComponentDigest:
                    "c4702097c31dfc8ae75ab8af2f85418fa274a91befdb7f01c724ff993f371a8a",
            },
            {
                sourceBatchId: "batch-140",
                sourceBatchDigest:
                    "fb8ab25128583cc04b8fa5c6c90e3c765f278e478263376ab607e1a2717aaa69",
                caseCount: 41,
                schema3ComponentDigest:
                    "5315f2e87cd5fecd17656bf033b0fbbb61fb1406d38dd437d7c6f0412b608965",
            },
            {
                sourceBatchId: "batch-156",
                sourceBatchDigest:
                    "6c6be068d9ae44f8ad6a1efeeee093d127ee2ccfe0ad33af3052e1bd256e5bb3",
                caseCount: 27,
                schema3ComponentDigest:
                    "f21eb9a22514f68c6117e816b0facfb2e6d2e6e41eb83b084a2a5b3f828e4bfc",
            },
            {
                sourceBatchId: "batch-157",
                sourceBatchDigest:
                    "7297d2b8acc916385a44fd26aa0586f132434b361fd0af3477034c310ede1164",
                caseCount: 45,
                schema3ComponentDigest:
                    "64b2506e4853c81c3f758f31df05291492b5134087e666266880dc69fdeafd01",
            },
            {
                sourceBatchId: "batch-158",
                sourceBatchDigest:
                    "dd5590db13c28303e67bf4e4d2c1255d2d79bb2b260a3d24d567f85beb5986fa",
                caseCount: 35,
                schema3ComponentDigest:
                    "58c7a313ebc28ab46b35c82cbacb43cfea067acd6e203b1c9387132f4f1f24e8",
            },
            {
                sourceBatchId: "batch-159",
                sourceBatchDigest:
                    "e610a77b2aa5460472a019049b25fe7d401f54fc2c418e3b09d4d8f897b3c131",
                caseCount: 25,
                schema3ComponentDigest:
                    "127f2dc32dfd8ce8f78446bc07475d8003e9ef28f15dd79680f42aa90c3610f6",
            },
            {
                sourceBatchId: "batch-160",
                sourceBatchDigest:
                    "7d8f3e4e5d4d662285a7f96ddbfcf73688891ce31483a73f4b023c1002047ba9",
                caseCount: 47,
                schema3ComponentDigest:
                    "ffd69983ab4fc876fac0a4492044523885f23a299b84f65253fff582fa44d825",
            },
            {
                sourceBatchId: "batch-161",
                sourceBatchDigest:
                    "b93d695323cf662b6162a68d9450ac6753a6c1adf15f38987f7893266ede9ef5",
                caseCount: 38,
                schema3ComponentDigest:
                    "c7f3e9f21d7acce3974e0f132ae78922f1a50860b399f9dd8769a35e4d18e509",
            },
            {
                sourceBatchId: "batch-127",
                sourceBatchDigest:
                    "f3e7684099489aae204e57129681fc0e4748d93a7091bc9e09238655f5db2499",
                caseCount: 29,
                schema3ComponentDigest:
                    "28772ec227520da6db6f33405e3c2e70bd7447aafb5bbf182b3ab97ba206c1f7",
            },
            {
                sourceBatchId: "batch-128",
                sourceBatchDigest:
                    "b122f98523911d9142dffb834200bace4d0111083455480f066f5d02771a2fb9",
                caseCount: 50,
                schema3ComponentDigest:
                    "9332b0aadaa0555ea23858daa013fd6ec9911b9c2830dafc28705d0568466f15",
            },
            {
                sourceBatchId: "batch-141",
                sourceBatchDigest:
                    "e8209a9b5fcb3f0fb3a6759f2820caa38b92258b49851cd5fa77ccf55f361b4f",
                caseCount: 44,
                schema3ComponentDigest:
                    "fd4cdb960e5108ca0278fea10707ddc25feacfb9fef2250dc19e1b2e585b3203",
            },
            {
                sourceBatchId: "batch-130",
                sourceBatchDigest:
                    "13e2e20d65939eba4ca53e79a8af27e20ad9f261f95f27e9c538c1db98bf7c5b",
                caseCount: 29,
                schema3ComponentDigest:
                    "eecc2cb2bd051509951a4dbc5bbe4b6ba29fb785ea4cfc225033e6c332abaf29",
            },
            {
                sourceBatchId: "batch-131",
                sourceBatchDigest:
                    "fee11682a1b0587739dce79c1057a970882395445742b71d483753ff5753f5c3",
                caseCount: 50,
                schema3ComponentDigest:
                    "e4fad4a0c911e745c9d7c71774942d1ee50c3cacbeeee87194badc537f411b04",
            },
            {
                sourceBatchId: "batch-142",
                sourceBatchDigest:
                    "93426976dfad320c6e44ee78193ba0d23bc14f7a1750214f46ddaab343030663",
                caseCount: 44,
                schema3ComponentDigest:
                    "89f855bb2ed686ea0cdb745745fe8f9abd5a575dc635f9c23479c8bb6024c915",
            },
            {
                sourceBatchId: "batch-133",
                sourceBatchDigest:
                    "ebd5bc92383163f500a152564dd1a6c7a96ada5b295ef6e01425c1529597e5fe",
                caseCount: 8,
                schema3ComponentDigest:
                    "0492ae6c8b58a917f7eaf92827c547f5da4e97315c31aef5ac805b87f897307f",
            },
            {
                sourceBatchId: "batch-134",
                sourceBatchDigest:
                    "9313b70404e9e0376ef62d3140d6b762405922530791004781d93185b99f26d0",
                caseCount: 5,
                schema3ComponentDigest:
                    "8073b3f7201622aa39594db572c4e069c3b7ffdd4b89fe089cc1cd413caf958d",
            },
            {
                sourceBatchId: "batch-135",
                sourceBatchDigest:
                    "20af13cb455b8a2e034958b3479235c11d67984636256d32af02a0e9575d5aa0",
                caseCount: 2,
                schema3ComponentDigest:
                    "18007e1331d7aec68b27d0d6e9a33b682946e199e7d7b6d3fd1da032bb7cddc3",
            },
            {
                sourceBatchId: "batch-136",
                sourceBatchDigest:
                    "ebcb479c8370c23f8069813efda50f9068504043d167804d88802c4fc7e20ce6",
                caseCount: 2,
                schema3ComponentDigest:
                    "b466c2be46ee1067f9f78c57b9924bcb129e103eb06f4b5093cd817011c55fb2",
            },
            {
                sourceBatchId: "batch-162",
                sourceBatchDigest:
                    "c72ea36793dbab2a7c244b2f51896478d97b262a81768a4de8fb78fa4a01f38a",
                caseCount: 25,
                schema3ComponentDigest:
                    "a7d60b7497ae93cba212770a1a1c4a5ac73a97d5a1f0c20ff15c314cfeeb3f38",
            },
            {
                sourceBatchId: "batch-163",
                sourceBatchDigest:
                    "439929433176304d244996ef9ce85387e884c2b03fee94ff44c90f96b0a1136b",
                caseCount: 11,
                schema3ComponentDigest:
                    "04a1ef88d793a8ba0f76509db40ac789bdb02c9fac13dcdfcf6312a125b44800",
            },
            {
                sourceBatchId: "batch-164",
                sourceBatchDigest:
                    "bca38c972a0a0600805099ac782d8c0d3639aa7c6dca945a9e71e03d2059834b",
                caseCount: 11,
                schema3ComponentDigest:
                    "e21e782cea0732373dda3ff16d85fbce98eb54d03552fc0eb57e3fb34c0a24da",
            },
            {
                sourceBatchId: "batch-165",
                sourceBatchDigest:
                    "721fde3ad36c305c3256065e050a3d714314bc54ed3a53cede7f1528f994950d",
                caseCount: 8,
                schema3ComponentDigest:
                    "b5a280e87660259bc8d7db0422d2cf8e50d2929f3b2b6824d1db4014c5be53fb",
            },
        ],
        replacementTranches: [
            {
                trancheId: "succ4-tranche-1",
                caseCount: 8,
                componentDigest:
                    "ddd42336394442fcb5d7ad0d0f224997f3984e3e437e4daa12212a56734daddb",
            },
            {
                trancheId: "succ4-tranche-2",
                caseCount: 25,
                componentDigest:
                    "29cf1b9107189362316da1fe7233ea450fbf70aaf529f2031daeda3fcca15821",
            },
            {
                trancheId: "succ4-tranche-3",
                caseCount: 18,
                componentDigest:
                    "c120aa3541a925bd1779478513d14a944e3c522429ba5286914122ff4510cd29",
            },
            {
                trancheId: "succ4-tranche-4",
                caseCount: 26,
                componentDigest:
                    "baa5844431e3503c53823526d496144152582a01f053ee48c0757f4a71a9084a",
            },
            {
                trancheId: "succ4-tranche-5",
                caseCount: 26,
                componentDigest:
                    "a8b834ca464afef0b2483a11fbe4aeee8ba2366a28822b95e0be668bf3708e1c",
            },
        ],
    },
};
