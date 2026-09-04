/**
 * The immutable record of what each frozen eval dataset was.
 *
 * ## Why this file exists
 *
 * Before it, a dataset's composition lived in exactly one place — the live
 * registry that `MEMORY_EVAL_CASES` and `MEMORY_EVAL_SUCCESSOR_CASES` are
 * built from — and its digest lived nowhere at all. Every consumer recomputed
 * the digest from whatever the tree currently held and compared it against an
 * artifact, so "this dataset has not changed" was a claim nothing in the
 * repository made. `mem-eval-succ-2`'s `60aa43f1...` appeared only as
 * sixteen truncated characters of prose in two audit documents.
 *
 * That was survivable while there was one successor. It stops being
 * survivable when `mem-eval-succ-3` arrives: succ-3 is a third module and a
 * third registry — succ-2 is not edited — but nothing would have checked that
 * succ-2 stayed where it was left, and a superseded dataset that quietly
 * drifts takes every artifact scored against it with it.
 *
 * ## Immutable means literal
 *
 * Every number and digest below is written out. Deriving them from the
 * registries would make this file agree with the tree by construction and
 * prove nothing, which is the failure it exists to prevent.
 * `tests/memoryEvalDatasetManifests.test.mjs` recomputes all of it from the
 * live registries and asserts exact equality, so the two can only disagree
 * loudly.
 *
 * A dataset that is genuinely being reworked gets a NEW manifest under a NEW
 * `datasetVersion` — docs/ops/memory-extraction-eval-dataset.md §7.3. Editing
 * an entry here to make a failing check pass is the one thing this file
 * forbids: it would rewrite the record of a run that already happened.
 *
 * ## The scoring contract digest, and when it is not recomputed
 *
 * `scoringContractDigest` is pinned per entry together with the contract
 * version it was computed under. A later approved amendment moves the live
 * contract, and the older entries keep their old value on purpose — succ-2
 * *was* scored under `mem-score-v2.3`, and overwriting that would make the
 * manifest describe a contract its run never saw. Verification reports those
 * entries as `superseded` rather than recomputing them, and everything that
 * does not depend on the contract — counts, cell counts, batch digests, the
 * dataset digest — is still checked exactly.
 *
 * Schema-1 entries carry `null`: the four fields the contract digest covers
 * do not exist on those cases, so there is nothing to compute.
 */

import { createHash } from "node:crypto";

import {
    datasetFingerprintInput,
    type MemoryEvalCase,
} from "@/lib/memoryExtractionEvalCore";
import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";
import { adoptedBatchDigest } from "@/lib/memoryEvalAdoptedBatchSuccession";
import {
    MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    scoringContractDescriptorInput,
    scoringContractDigest,
} from "@/lib/memoryEvalScoringContractDigest";

/** One adopted batch, as the manifest records it. */
export type ManifestBatch = {
    id: string;
    cell: string;
    caseCount: number;
    /** `adoptedBatchDigest()` over that batch's cases. */
    digest: string;
};

export type EvalDatasetManifest = {
    datasetVersion: string;
    schemaVersion: 1 | 2;
    /** The version this one replaced, or `null` for the first. */
    supersedes: string | null;
    /** Composition, in registry order. */
    batches: readonly ManifestBatch[];
    /**
     * Cases belonging to no batch.
     *
     * `mem-eval-seed-11` was seeded by hand before batching started, and those
     * 32 cases are in the dataset without an adoption record. Recorded rather
     * than folded into the total, because a count that hides them would let a
     * batch go missing and the sum still add up.
     */
    unbatched: { caseCount: number; digest: string } | null;
    caseCount: number;
    /** `${category}:${language}` to count, for the §12.2 floors. */
    cellCounts: Readonly<Record<string, number>>;
    /** sha256 of `datasetFingerprintInput()`. What artifacts carry. */
    datasetDigest: string;
    /** sha256 of `scoringContractDigestInput()`. `null` for schema 1. */
    scoringContractDigest: string | null;
    /** The contract version the digest above was computed under. */
    scoringContractVersion: string | null;
};

/** What a caller hands `verifyEvalDatasetManifest()` to check an entry against. */
export type EvalDatasetComposition =
    | {
          schemaVersion: 1;
          batches: readonly { id: string; cell: string; cases: readonly MemoryEvalCase[] }[];
          cases: readonly MemoryEvalCase[];
      }
    | {
          schemaVersion: 2;
          batches: readonly { id: string; cell: string; cases: readonly MemoryEvalCaseV2[] }[];
          cases: readonly MemoryEvalCaseV2[];
      };

export type ManifestVerification = {
    datasetVersion: string;
    /** Empty means the tree still holds exactly what this manifest recorded. */
    mismatches: readonly string[];
    scoringContract: "verified" | "not_applicable_schema_1" | "superseded";
};

const datasetDigestOf = (cases: readonly MemoryEvalCase[]): string =>
    createHash("sha256")
        .update(datasetFingerprintInput(cases), "utf8")
        .digest("hex");

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

/**
 * Recomputes everything the manifest pins and reports what no longer agrees.
 *
 * Reports every mismatch rather than throwing on the first. A dataset that
 * moved usually moved in more than one way, and stopping at the first line
 * would send a reader round the loop once per difference.
 */
export function verifyEvalDatasetManifest(
    manifest: EvalDatasetManifest,
    composition: EvalDatasetComposition
): ManifestVerification {
    const mismatches: string[] = [];
    const say = (line: string) => mismatches.push(line);

    if (manifest.schemaVersion !== composition.schemaVersion) {
        say(
            `schema version: manifest says ${manifest.schemaVersion}, the composition ` +
                `was handed over as ${composition.schemaVersion}`
        );
    }

    /* --- composition ---------------------------------------------------- */

    const manifestIds = manifest.batches.map((batch) => batch.id);
    const treeIds = composition.batches.map((batch) => batch.id);
    if (manifestIds.join(",") !== treeIds.join(",")) {
        const missing = manifestIds.filter((id) => !treeIds.includes(id));
        const extra = treeIds.filter((id) => !manifestIds.includes(id));
        say(
            `batches: manifest lists ${manifestIds.length}, the tree has ` +
                `${treeIds.length}` +
                (missing.length ? `; missing ${missing.join(", ")}` : "") +
                (extra.length ? `; unrecorded ${extra.join(", ")}` : "") +
                (!missing.length && !extra.length ? "; the order differs" : "")
        );
    }

    const treeById = new Map(composition.batches.map((batch) => [batch.id, batch]));
    for (const recorded of manifest.batches) {
        const batch = treeById.get(recorded.id);
        if (!batch) continue; // already reported above
        if (batch.cell !== recorded.cell) {
            say(`${recorded.id}: cell ${recorded.cell} -> ${batch.cell}`);
        }
        if (batch.cases.length !== recorded.caseCount) {
            say(
                `${recorded.id}: ${recorded.caseCount} cases -> ${batch.cases.length}`
            );
        }
        const digest = adoptedBatchDigest(batch.cases);
        if (digest !== recorded.digest) {
            say(`${recorded.id}: digest ${recorded.digest} -> ${digest}`);
        }
    }

    /* --- cases outside any batch ---------------------------------------- */

    const batched = new Set(
        composition.batches.flatMap((batch) => batch.cases.map((c) => c.id))
    );
    const unbatched = composition.cases.filter((c) => !batched.has(c.id));
    if (manifest.unbatched === null) {
        if (unbatched.length > 0) {
            say(
                `${unbatched.length} cases belong to no batch and the manifest records none`
            );
        }
    } else if (unbatched.length !== manifest.unbatched.caseCount) {
        say(
            `unbatched cases: ${manifest.unbatched.caseCount} -> ${unbatched.length}`
        );
    } else {
        const digest = adoptedBatchDigest(unbatched);
        if (digest !== manifest.unbatched.digest) {
            say(`unbatched digest: ${manifest.unbatched.digest} -> ${digest}`);
        }
    }

    /* --- counts ---------------------------------------------------------- */

    if (composition.cases.length !== manifest.caseCount) {
        say(`case count: ${manifest.caseCount} -> ${composition.cases.length}`);
    }

    const cells = cellCountsOf(composition.cases);
    for (const [cell, count] of Object.entries(manifest.cellCounts)) {
        if (cells[cell] !== count) {
            say(`${cell}: ${count} -> ${cells[cell] ?? 0}`);
        }
    }
    for (const cell of Object.keys(cells)) {
        if (!(cell in manifest.cellCounts)) {
            say(`${cell}: unrecorded, now ${cells[cell]}`);
        }
    }

    /* --- digests --------------------------------------------------------- */

    const datasetDigest = datasetDigestOf(composition.cases);
    if (datasetDigest !== manifest.datasetDigest) {
        say(`dataset digest: ${manifest.datasetDigest} -> ${datasetDigest}`);
    }

    let scoringContract: ManifestVerification["scoringContract"];
    if (composition.schemaVersion === 1) {
        scoringContract = "not_applicable_schema_1";
        if (manifest.scoringContractDigest !== null) {
            say(
                `schema 1 cannot have a scoring contract digest, but one is recorded`
            );
        }
    } else if (
        manifest.scoringContractVersion !== MEMORY_EVAL_SCORING_CONTRACT_VERSION
    ) {
        // Not a failure. The entry records what the run was scored under.
        scoringContract = "superseded";
    } else {
        scoringContract = "verified";
        const digest = scoringContractDigest(composition.cases);
        if (digest !== manifest.scoringContractDigest) {
            say(
                `scoring contract digest: ${manifest.scoringContractDigest} -> ${digest}`
            );
        }
    }

    return {
        datasetVersion: manifest.datasetVersion,
        mismatches,
        scoringContract,
    };
}

/**
 * Every frozen dataset, oldest first.
 *
 * Adding an entry is how a dataset becomes citable. Editing one is how a
 * record of a past run stops being true, so the tests treat any difference
 * from the tree as a failure and never as something to reconcile.
 */
export const MEMORY_EVAL_DATASET_MANIFESTS: readonly EvalDatasetManifest[] = [
    {
        /**
         * Schema 1, frozen, and diagnostic-only since the 2026-08-25
         * amendment: `lib/memoryEvalLegacyDataset.ts` refuses it for a
         * verdict, a freeze and a pair approval. It is recorded here for the
         * same reason it is still readable — the two `mem-extract-v2` runs
         * that produced the amendment were scored against it.
         */
        datasetVersion: "mem-eval-seed-11",
        schemaVersion: 1,
        supersedes: null,
        batches: [
            { id: "batch-001", cell: "durable_facts:ko", caseCount: 25,
              digest: "8281d36b08c126c8458eb2e2ba14af2f1651568876521543d328db3381ab2a00" },
            { id: "batch-002", cell: "durable_facts:en", caseCount: 25,
              digest: "4ec40037fb131f72f88f2698d2d76a3feb12b4782f9d85e8ffc65b58de53d767" },
            { id: "batch-003", cell: "assistant_only:ko", caseCount: 25,
              digest: "f48976524e07a057b2f0c1d982f986302f2e25a3abdd1f69a8dfcae21f5d29a8" },
            { id: "batch-004", cell: "assistant_only:en", caseCount: 25,
              digest: "47bf3213cd86c85e345574327ad50777392451eef05476858901fc675ae1142d" },
            { id: "batch-005", cell: "sensitive_secrets:ko", caseCount: 25,
              digest: "990db2bef623a49c18a8cc369e2e6d607eb8ac544112f52114d54d8ffb9ac441" },
            { id: "batch-006", cell: "sensitive_secrets:en", caseCount: 25,
              digest: "a37f516960333040a58585eb80d04d1a5a7571761240c8360fdf21e4eb8bcb95" },
            { id: "batch-007", cell: "injection_directives:ko", caseCount: 25,
              digest: "7e365787260ae38e24d8368059f0e2dd8fc19422465b82543a5f5d154b078581" },
            { id: "batch-008", cell: "injection_directives:en", caseCount: 25,
              digest: "368e933bbf43b24eeb8d1f22d51b6366636c76cd56663ae3747b659a604e12a7" },
            { id: "batch-009", cell: "durable_facts:ko", caseCount: 50,
              digest: "ad86f56c681d5ee593a0fa4359fbbe80d08dabd56a380e6e2b68d191cd6ae05a" },
            { id: "batch-010", cell: "durable_facts:en", caseCount: 50,
              digest: "201af0e702f4a6d69f5479bfda4dd3a4727c5c89d7a250ae05368abb8ba57654" },
            { id: "batch-011", cell: "durable_facts:ko", caseCount: 50,
              digest: "5b047793911b70f9ab5e6f2a08dfe0231e63908516413696ee508dfc59e96290" },
            { id: "batch-012", cell: "durable_facts:en", caseCount: 50,
              digest: "b4c8924269eb3f59e342586e73d6edfe9689febdc9119a8ba60cc21e547de9e9" },
            { id: "batch-013", cell: "durable_facts:ko", caseCount: 46,
              digest: "ddb7b9b41711ee2e6f304462f3e97ce7a97af1ed44e472bb1bc63e66ffb0c7ba" },
            { id: "batch-014", cell: "durable_facts:en", caseCount: 46,
              digest: "41862ae89da71f570c1ed1eadc067ca8cb6522fe6374ca55f10f7794295e7432" },
            { id: "batch-015", cell: "durable_facts:ko", caseCount: 25,
              digest: "e0856e8525206a3769dfbb8313afe7033bf40c0fbf6fd791b3ea3c85cb21282f" },
            { id: "batch-016", cell: "durable_facts:en", caseCount: 25,
              digest: "7882d8d5d11a1f228db262596012936cbd2149ba4f4b24c1b1e626155ef628a9" },
            { id: "batch-017", cell: "assistant_only:ko", caseCount: 50,
              digest: "5fd31f2f195139692605f1c1a84bd7ae58cc76b1792a0c7a28fb998d3f093031" },
            { id: "batch-018", cell: "assistant_only:en", caseCount: 50,
              digest: "16233e4ade739d7aff7168d12c4ddf00d55ea946e669b7ae265c0594430c57e0" },
            { id: "batch-019", cell: "assistant_only:ko", caseCount: 46,
              digest: "1ea71d457aee56013c6f1e348dc8e324b8ba952444d9424897c2d73a975bae9c" },
            { id: "batch-020", cell: "assistant_only:en", caseCount: 46,
              digest: "5343d52b6e2dbd7d7f0dd9fee694a2138f7c484826758afa9bafdcc58947776b" },
            { id: "batch-021", cell: "sensitive_secrets:ko", caseCount: 50,
              digest: "f9fb6dafcf1d5b3119458d710d6bb1d6947c5cc49c518b6ebce76a858fdf45fe" },
            { id: "batch-022", cell: "sensitive_secrets:en", caseCount: 50,
              digest: "521e77276466718c1136595ae795e71517e2eedfb4c3f6bd4b1698b81ae894e4" },
            { id: "batch-023", cell: "injection_directives:ko", caseCount: 50,
              digest: "d457b46cfe14ed61ac6d7353547ec66d845007d6b8e8d49557857fd2215faa70" },
            { id: "batch-024", cell: "injection_directives:en", caseCount: 50,
              digest: "473e68bc5c39f47293bcb548f273198cbc549e6c7f914a15cdab0cbdf781f5e0" },
            { id: "batch-025", cell: "sensitive_secrets:ko", caseCount: 46,
              digest: "5501e06513a118c241013b6c7a9df2b3c53e22ca6e13fe6a16e5d56fce2de431" },
            { id: "batch-026", cell: "sensitive_secrets:en", caseCount: 46,
              digest: "84494632fb7a7e317fd3571f444eb6d7111fafc0ecb099136dcbd1cf140f541e" },
            { id: "batch-027", cell: "injection_directives:ko", caseCount: 46,
              digest: "60cb5e171e954412d6207364459db3bcb2f64db631d278f6dc1bd1486e5279d7" },
            { id: "batch-028", cell: "injection_directives:en", caseCount: 46,
              digest: "7b22aa60f5de28b73e58a106205a03094bbad6338f405298c8b375bf3f6b6bd5" },
        ],
        unbatched: {
            caseCount: 32,
            digest: "326661c26e483be680abfc1203c10689e32d175d363d34f4f0c88040a9e6593b",
        },
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
            "a3b0c18e3c66d31f3eed7d8f7e7acbb94bee9146fff153ac89f91e6151e07a67",
        scoringContractDigest: null,
        scoringContractVersion: null,
    },
    {
        /**
         * What run1 was scored against — run 32972243326, commit `f6c60491`,
         * artifact 9609657913: 1,150 cases, every cell at its §12.2 floor,
         * zero harness failures, and a not-a-pass verdict that is citable
         * precisely because the sample it was computed on is recorded here.
         *
         * `mem-eval-succ-1` has no entry. It was superseded before anything
         * decision-grade ran against it (probe1 is explicitly not a verdict)
         * and its registry no longer exists in the tree, so an entry could
         * not be verified against anything.
         */
        datasetVersion: "mem-eval-succ-2",
        schemaVersion: 2,
        supersedes: "mem-eval-seed-11",
        batches: [
            { id: "batch-101", cell: "durable_facts:ko", caseCount: 25,
              digest: "539cfd7c0d31870bf422581b1e69420fe64de650e5b76e5feac0b83282597ba5" },
            { id: "batch-102", cell: "durable_facts:en", caseCount: 25,
              digest: "9fed6eeeea5d4624736ec349f7675805adfbedfa09e0cff97036ef337fc3854c" },
            { id: "batch-103", cell: "durable_facts:ko", caseCount: 25,
              digest: "d5d041a1307b4519d326b94e48f69b2706ca8569a6a7c8eb49bad3851eed1730" },
            { id: "batch-104", cell: "durable_facts:ko", caseCount: 25,
              digest: "f517157e30a17875f6ede795103859eb4f2b8c26756e104ef99990569af7345f" },
            { id: "batch-105", cell: "durable_facts:en", caseCount: 25,
              digest: "8bce9fadd0d8507c7443be9e83d0580df19cb3ffdd44d0f0b43ae53999223f55" },
            { id: "batch-106", cell: "durable_facts:en", caseCount: 25,
              digest: "11966002cbddaa10ec85c564899ebac37f24bd03c5b73a2edc2996a2035e7133" },
            { id: "batch-107", cell: "durable_facts:ko", caseCount: 25,
              digest: "ce1206112caec486deb939545b8ecdfed9dc32cb47d3b5e357f0411a33d38b26" },
            { id: "batch-108", cell: "durable_facts:ko", caseCount: 25,
              digest: "c9595623da72924a72ec7aaf74de3430696d28d3e2aec16f0a0636b339a8b946" },
            { id: "batch-109", cell: "durable_facts:en", caseCount: 25,
              digest: "6f9a3584f3d747abc10b470b68f6e9edb272ef52778ab24dc380d914d5073714" },
            { id: "batch-110", cell: "durable_facts:en", caseCount: 25,
              digest: "7fe70bb4ceb5d7a7b572fb46d76c99e5c5c29ca2778aa7219a60ba547a154f30" },
            { id: "batch-111", cell: "durable_facts:ko", caseCount: 46,
              digest: "3f457e1b73dd74387fab3014a0c4e2fa273856373f277ed4b7b3edbb50404c77" },
            { id: "batch-112", cell: "durable_facts:en", caseCount: 46,
              digest: "5234f9bbdf53c3bc64ceee1111e69ebca3e628ffeeebbed4290418e136f3f3e5" },
            { id: "batch-113", cell: "durable_facts:ko", caseCount: 29,
              digest: "2f6bc7d09e218576a370ac90a77df8c143fd4f2a21673331ff24d901ebcb5a9c" },
            { id: "batch-114", cell: "durable_facts:en", caseCount: 29,
              digest: "57fedb7586666a6282d1e97652ba185e53d9510bdfbd9db6a95762cf502a467a" },
            { id: "batch-115", cell: "injection_directives:ko", caseCount: 29,
              digest: "f4e050e0a29ffc8dc38a82e930f9161dba9c044ec810824d553b09d4160a5693" },
            { id: "batch-116", cell: "injection_directives:ko", caseCount: 50,
              digest: "7b9997ccc8c42abf2dfcfbb73702dbfc0875bfc44a00cc9f17b2e16ca03a4a28" },
            { id: "batch-117", cell: "injection_directives:ko", caseCount: 46,
              digest: "2671ea57ffc602f2df687f8dc4acb796fe308d33a595be0eb87c8d517b621714" },
            { id: "batch-118", cell: "injection_directives:en", caseCount: 29,
              digest: "4eeb9d656679678f218814ebbdcd4cd52672038194c2efc9799ee8577a7b9322" },
            { id: "batch-119", cell: "injection_directives:en", caseCount: 50,
              digest: "888b793f62284225f52eda4ceddac6e3743aeaef6a9dc6e27f654137c85bf1d6" },
            { id: "batch-120", cell: "injection_directives:en", caseCount: 46,
              digest: "655f1fae423b34c670c75fee4e689bb78c93aff6a77b7fc943ff97917351186e" },
            { id: "batch-121", cell: "assistant_only:ko", caseCount: 29,
              digest: "087b0096504c5030cf7f8719dbd7b110a0993043af5f25cec56688fea0d18157" },
            { id: "batch-122", cell: "assistant_only:ko", caseCount: 50,
              digest: "8bcee434088886dd584905aef5af51f7abd5ce375b53bde007bf669d516dd24c" },
            { id: "batch-123", cell: "assistant_only:ko", caseCount: 46,
              digest: "65bc38c0b59d694ee901c881899d30955543e75c35ea7bae698133b35d2dbc3a" },
            { id: "batch-124", cell: "assistant_only:en", caseCount: 29,
              digest: "2d185a2fc00ad72633bf0c331d68929abb3aa8ef92c635f5a150a26136f9e8ea" },
            { id: "batch-125", cell: "assistant_only:en", caseCount: 50,
              digest: "ee416d83d59e245db87edf31280911c9b25a1321211a03fd31bc7d7cec445878" },
            { id: "batch-126", cell: "assistant_only:en", caseCount: 46,
              digest: "e374bf217163c0772a238071b3b1f65ee1f0dd9d9230499aa55bad00f4864fff" },
            { id: "batch-127", cell: "sensitive_secrets:ko", caseCount: 29,
              digest: "f3e7684099489aae204e57129681fc0e4748d93a7091bc9e09238655f5db2499" },
            { id: "batch-128", cell: "sensitive_secrets:ko", caseCount: 50,
              digest: "b122f98523911d9142dffb834200bace4d0111083455480f066f5d02771a2fb9" },
            { id: "batch-129", cell: "sensitive_secrets:ko", caseCount: 46,
              digest: "54302cffdcabe219ce3fcb25990d78eb93540bba54360ac548f67a3f4d4f9aae" },
            { id: "batch-130", cell: "sensitive_secrets:en", caseCount: 29,
              digest: "13e2e20d65939eba4ca53e79a8af27e20ad9f261f95f27e9c538c1db98bf7c5b" },
            { id: "batch-131", cell: "sensitive_secrets:en", caseCount: 50,
              digest: "fee11682a1b0587739dce79c1057a970882395445742b71d483753ff5753f5c3" },
            { id: "batch-132", cell: "sensitive_secrets:en", caseCount: 46,
              digest: "207c96b0139a5bfdf1202dd369135261ae2939d4a72dd1a86ce27e6c01e900b0" },
        ],
        unbatched: null,
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
            "60aa43f1cf8ea23b715d200b897abfb3bedb8a7fe7d352d2cf85b6a56be91e5c",
        scoringContractDigest:
            "b07632843d748fcc5773e210b113e0d9e7770aa3a91bf8e20b453e72480b7fb9",
        scoringContractVersion: "mem-score-v2.3",
    },
    {
        /**
         * The set the next decision-grade run is scored against, frozen
         * 2026-08-27. Ninety-nine cases that authored `mem-extract-v5`'s rules
         * left for `lib/memoryEvalRegressionCorpus/` and ninety-nine written
         * for the purpose took their place; the other 1,051 are the same
         * objects succ-2 holds, reached through successor batches that drop a
         * case rather than rewrite one.
         *
         * succ-2's entry above is unchanged and still recomputes. That is the
         * construction, not a coincidence: run1's verdict is attached to the
         * sample that produced it, and a superseded dataset reassembled under
         * its own manifest would take every artifact scored against it with
         * it.
         */
        datasetVersion: "mem-eval-succ-3",
        schemaVersion: 2,
        supersedes: "mem-eval-succ-2",
        batches: [
            { id: "batch-143", cell: "durable_facts:ko", caseCount: 21,
              digest: "d81f245d6ed2422aabed88a0c67e93a4d75ddf9f2c85ab58815a2e276f2c6c8c" },
            { id: "batch-102", cell: "durable_facts:en", caseCount: 25,
              digest: "9fed6eeeea5d4624736ec349f7675805adfbedfa09e0cff97036ef337fc3854c" },
            { id: "batch-144", cell: "durable_facts:ko", caseCount: 22,
              digest: "6d3eeb6b1b555f6c39669d0c12d73b2978fef9df60534ae41864be4a246f4b32" },
            { id: "batch-145", cell: "durable_facts:ko", caseCount: 22,
              digest: "cafc074f1b436fd52343b3493214d43ee1c90b5887a77d28279502161e49f3c9" },
            { id: "batch-146", cell: "durable_facts:en", caseCount: 21,
              digest: "0dfade2924bd5b35f80ad0b5c8d93376a0b614a43af58bd83d806c679d5a32ad" },
            { id: "batch-147", cell: "durable_facts:en", caseCount: 23,
              digest: "e228ccabf2efc1c29dbe1f260cd3cde71a1893df3dc876216b58a106afd51677" },
            { id: "batch-148", cell: "durable_facts:ko", caseCount: 20,
              digest: "1509d8b1a1f2b56ab8b02b7d60449572735504b2baca18cba5cdd0f1aceb3262" },
            { id: "batch-149", cell: "durable_facts:ko", caseCount: 21,
              digest: "abeaf7835c0d606f3099379cbd7ed69ddcbeea2f8b8b8d311e4fcbc348cdd9b6" },
            { id: "batch-150", cell: "durable_facts:en", caseCount: 21,
              digest: "d0e95b061d0c0545dc4f8dcb4704bcc126841de943a3692a0dcfa6b5a3df11fb" },
            { id: "batch-151", cell: "durable_facts:en", caseCount: 23,
              digest: "50ee224e9672216455a9c40338bdca37ecf5202e53fc0178aa7f57ffb430a2cc" },
            { id: "batch-152", cell: "durable_facts:ko", caseCount: 39,
              digest: "74a9561f1a19a47eaaf9db1b3d31dfbc3a27d4d86044eba13e0fe1bd29977fa3" },
            { id: "batch-153", cell: "durable_facts:en", caseCount: 41,
              digest: "bc1dd32c66c1fe08344847bc01df53464257875e854f6ad389b130ed132eb508" },
            { id: "batch-154", cell: "durable_facts:ko", caseCount: 26,
              digest: "d749824131d0253187f8082881382564d5e18b7439c4c8c40b085bde852488e3" },
            { id: "batch-155", cell: "durable_facts:en", caseCount: 26,
              digest: "653c7b8f498bda66cb9a584024d91d8dc336557be2620d6f952ac720f9d3c24d" },
            { id: "batch-137", cell: "injection_directives:ko", caseCount: 24,
              digest: "f18553b2b04a7d682aa8428734b0c73955d28417639abee8900efd3964e49580" },
            { id: "batch-116", cell: "injection_directives:ko", caseCount: 50,
              digest: "7b9997ccc8c42abf2dfcfbb73702dbfc0875bfc44a00cc9f17b2e16ca03a4a28" },
            { id: "batch-138", cell: "injection_directives:ko", caseCount: 43,
              digest: "6c953e4b27820aa0cdb7de9eba7f5c8b7415d69c1f03c0c64ce31dcbd5a3754d" },
            { id: "batch-139", cell: "injection_directives:en", caseCount: 27,
              digest: "674cb40140f009438cebd77ab047d36810ace30241c985377bf719e7be2bea05" },
            { id: "batch-119", cell: "injection_directives:en", caseCount: 50,
              digest: "888b793f62284225f52eda4ceddac6e3743aeaef6a9dc6e27f654137c85bf1d6" },
            { id: "batch-140", cell: "injection_directives:en", caseCount: 43,
              digest: "fb8ab25128583cc04b8fa5c6c90e3c765f278e478263376ab607e1a2717aaa69" },
            { id: "batch-156", cell: "assistant_only:ko", caseCount: 27,
              digest: "6c6be068d9ae44f8ad6a1efeeee093d127ee2ccfe0ad33af3052e1bd256e5bb3" },
            { id: "batch-157", cell: "assistant_only:ko", caseCount: 45,
              digest: "7297d2b8acc916385a44fd26aa0586f132434b361fd0af3477034c310ede1164" },
            { id: "batch-158", cell: "assistant_only:ko", caseCount: 35,
              digest: "dd5590db13c28303e67bf4e4d2c1255d2d79bb2b260a3d24d567f85beb5986fa" },
            { id: "batch-159", cell: "assistant_only:en", caseCount: 25,
              digest: "e610a77b2aa5460472a019049b25fe7d401f54fc2c418e3b09d4d8f897b3c131" },
            { id: "batch-160", cell: "assistant_only:en", caseCount: 47,
              digest: "7d8f3e4e5d4d662285a7f96ddbfcf73688891ce31483a73f4b023c1002047ba9" },
            { id: "batch-161", cell: "assistant_only:en", caseCount: 38,
              digest: "b93d695323cf662b6162a68d9450ac6753a6c1adf15f38987f7893266ede9ef5" },
            { id: "batch-127", cell: "sensitive_secrets:ko", caseCount: 29,
              digest: "f3e7684099489aae204e57129681fc0e4748d93a7091bc9e09238655f5db2499" },
            { id: "batch-128", cell: "sensitive_secrets:ko", caseCount: 50,
              digest: "b122f98523911d9142dffb834200bace4d0111083455480f066f5d02771a2fb9" },
            { id: "batch-141", cell: "sensitive_secrets:ko", caseCount: 44,
              digest: "e8209a9b5fcb3f0fb3a6759f2820caa38b92258b49851cd5fa77ccf55f361b4f" },
            { id: "batch-130", cell: "sensitive_secrets:en", caseCount: 29,
              digest: "13e2e20d65939eba4ca53e79a8af27e20ad9f261f95f27e9c538c1db98bf7c5b" },
            { id: "batch-131", cell: "sensitive_secrets:en", caseCount: 50,
              digest: "fee11682a1b0587739dce79c1057a970882395445742b71d483753ff5753f5c3" },
            { id: "batch-142", cell: "sensitive_secrets:en", caseCount: 44,
              digest: "93426976dfad320c6e44ee78193ba0d23bc14f7a1750214f46ddaab343030663" },
            { id: "batch-133", cell: "injection_directives:ko", caseCount: 8,
              digest: "ebd5bc92383163f500a152564dd1a6c7a96ada5b295ef6e01425c1529597e5fe" },
            { id: "batch-134", cell: "injection_directives:en", caseCount: 5,
              digest: "9313b70404e9e0376ef62d3140d6b762405922530791004781d93185b99f26d0" },
            { id: "batch-135", cell: "sensitive_secrets:ko", caseCount: 2,
              digest: "20af13cb455b8a2e034958b3479235c11d67984636256d32af02a0e9575d5aa0" },
            { id: "batch-136", cell: "sensitive_secrets:en", caseCount: 2,
              digest: "ebcb479c8370c23f8069813efda50f9068504043d167804d88802c4fc7e20ce6" },
            { id: "batch-162", cell: "durable_facts:ko", caseCount: 29,
              digest: "c72ea36793dbab2a7c244b2f51896478d97b262a81768a4de8fb78fa4a01f38a" },
            { id: "batch-163", cell: "durable_facts:en", caseCount: 20,
              digest: "439929433176304d244996ef9ce85387e884c2b03fee94ff44c90f96b0a1136b" },
            { id: "batch-164", cell: "assistant_only:ko", caseCount: 18,
              digest: "bca38c972a0a0600805099ac782d8c0d3639aa7c6dca945a9e71e03d2059834b" },
            { id: "batch-165", cell: "assistant_only:en", caseCount: 15,
              digest: "721fde3ad36c305c3256065e050a3d714314bc54ed3a53cede7f1528f994950d" },
        ],
        unbatched: null,
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
            "38468da0dce31a144d61d360189b4ce9e1d55e0e914ae66a2d61bfb1e793dc3b",
        scoringContractDigest:
            "bbaeef43ec2f7de00774ea0b7778e7f32cf38d7850537458fbec5cb8cf8559a5",
        scoringContractVersion: "mem-score-v2.3",
    },
];

/** The manifest for a version, or `undefined`. Fail-closed at the call site. */
export const evalDatasetManifest = (
    datasetVersion: string
): EvalDatasetManifest | undefined =>
    MEMORY_EVAL_DATASET_MANIFESTS.find(
        (manifest) => manifest.datasetVersion === datasetVersion
    );

/* =========================================================================
 * The contract itself
 * ====================================================================== */

/**
 * One frozen scoring contract, recorded the way a dataset is.
 *
 * ## Why the contract needs a manifest of its own
 *
 * A dataset manifest pins its contract digest, and
 * `verifyEvalDatasetManifest()` recomputes it only while the entry's contract
 * version is still the live one. Every entry pinned to an older version
 * reports `superseded` and is not recomputed — deliberately, because the entry
 * records what that run was scored under.
 *
 * The consequence is a gap at exactly the moment a contract is frozen: on the
 * day `mem-score-v3` became live, every dataset entry named `mem-score-v2.3`,
 * so **nothing in the repository recomputed a v3 digest at all**. The contract
 * could have been edited freely until the first v3 dataset was authored, which
 * is the window in which its terms are most likely to be adjusted and least
 * likely to be noticed.
 *
 * So a contract is pinned when it is frozen, not when something is scored
 * under it.
 *
 * The digest here is over the **descriptor only** — the contract without any
 * dataset. That is what a contract version is: `scoringContractDigest()` mixes
 * in per-case labelling and answers a different question, one about a sample.
 */
export type ScoringContractManifest = {
    version: string;
    /** Approved on, as the record that froze it says. */
    approvedOn: string;
    /** sha256 of `scoringContractDescriptorInput()` under that version. */
    descriptorDigest: string;
    /**
     * Rules the contract states that nothing executes yet.
     *
     * Recorded rather than assumed empty. A contract may be frozen with a
     * pending rule; a dataset may not be frozen under one
     * (`memoryEvalScoringContractReadiness()`), and reading that list here
     * says which rules were outstanding at freeze rather than which are
     * outstanding today.
     */
    pendingRules: readonly string[];
};

export const MEMORY_EVAL_SCORING_CONTRACT_MANIFESTS: readonly ScoringContractManifest[] =
    [
        {
            version: "mem-score-v3",
            approvedOn: "2026-08-27",
            descriptorDigest:
                "0ff454d61bb41b640465bc77aad39f590f09413d9e46e32f1a8ba66fc2cd26dc",
            pendingRules: ["v3-unfixable-evidence-emits-nothing"],
        },
        {
            /**
             * Two corrections found while authoring `succ-4`'s golds, which is
             * where a contract meets the thing it describes.
             *
             * The evidence reference became `evidenceMessageId` — the
             * `externalMessageId` the extraction pipeline already speaks from
             * prompt label to parsed candidate — instead of the integer
             * position v3 froze. And `gold-evidence-covers-fact` was added: a
             * gold's quote must contain the fact it is about, or the anchor
             * names the right message and points at something else.
             *
             * Nothing was scored under v3: no dataset was frozen against it,
             * so this supersedes it without leaving a run behind. The v3 entry
             * stays because the version existed and was pinned.
             */
            version: "mem-score-v3.1",
            approvedOn: "2026-08-27",
            descriptorDigest:
                "4097096dae9060e44b0c6a0dbc5803dbdf1f22d6c80505306a70113794cb3658",
            pendingRules: ["v3-unfixable-evidence-emits-nothing"],
        },
        {
            /**
             * The third correction from authoring, and the one that mattered
             * most: the contract declared a `polarity` field and never said
             * what it was a field *about*. Drafting `succ-4` put roughly a
             * hundred golds in front of a reviewer where both values were
             * defensible — is *the user cannot drive at night* an assertion of
             * a constraint or a denial of an ability? — and a field answered
             * by preference is not a measurement.
             *
             * `MEMORY_EVAL_POLARITY_ASSIGNMENT_RULE` settles it against the
             * anchor quote, and carries the demand that follows: a token list
             * an opposite-polarity memory could also contain is
             * under-specified, because the field it was given changes nothing.
             */
            version: "mem-score-v3.2",
            approvedOn: "2026-08-27",
            descriptorDigest:
                "8d6dfef8537cf910a40d175e0bb315bdfaa4e47fa5e89ea3c4bfbc032d9b6e1b",
            pendingRules: ["v3-unfixable-evidence-emits-nothing"],
        },
        {
            /**
             * One id was carrying two rules with different subjects, and
             * `succ-4` is where that stopped being a wording problem.
             *
             * `v3-unfixable-evidence-emits-nothing` said both "no candidate is
             * emitted from evidence a plain reading cannot fix" — about a
             * model at run time — and "a gold whose quote is one of those
             * shapes is rejected at review" — about a sample. A dataset can
             * satisfy the second and can do nothing at all about the first, so
             * one `pendingRules` entry blocked every schema-3 freeze on a rule
             * half of which was never a dataset's to satisfy.
             *
             * v3.3 splits them. The authoring half becomes
             * `v3-unfixable-evidence-not-a-gold` and is enforced:
             * `lib/memoryEvalGoldReviewJudgements.ts` requires exactly one
             * review judgement per gold and refuses a decision set holding one
             * judged unfixable. The model half keeps the old id, keeps its
             * meaning, and is marked `prompt_pending` — still unwritten, and
             * no longer counted against a sample.
             *
             * `pendingRules` records what a *dataset* freeze is still waiting
             * on, which is now nothing. The prompt rule is listed separately
             * by `memoryEvalScoringContractPromptPending()` so it stays
             * visible rather than reclassified out of sight.
             */
            version: "mem-score-v3.3",
            approvedOn: "2026-08-28",
            descriptorDigest:
                "19f4e4f9d5976382d83a03153ef8e7fb52b3f6dd6104efa54f53ef05cd82f777",
            pendingRules: [],
        },
        {
            /**
             * **One field, corrected forward.**
             *
             * v3.3's descriptor records `schemaVersion: 2` while the contract
             * scores schema 3. It read the run-mode gate, which answers a
             * different question and happened to hold the same number; the
             * difference surfaced when the gate moved to 3 on 2026-08-28 and
             * took the frozen digest with it.
             *
             * The digest could not be edited in place — `mem-eval-succ-4`'s
             * manifest, the release-gate registry, the adoption record and the
             * instrument evidence all pin it — and running a decision-grade
             * eval under a contract whose own self-description is wrong is not
             * something an audit note repairs (@mposition, 2026-08-28). So
             * v3.3 is preserved exactly as frozen, as historical evidence and
             * not as a run target, and v3.4 records the 3 it always scored.
             *
             * Nothing else moved: same rules, same thresholds, same
             * categories, same languages, same floors. The whole difference
             * between the two digests is `schemaVersion` and the version
             * string, which is what makes the change attributable rather than
             * merely new.
             */
            version: "mem-score-v3.4",
            approvedOn: "2026-08-28",
            descriptorDigest:
                "a62f4bdd8d2073345e19e478541c20d81275a0d11fb78aa6e4df86ec0489b4cd",
            pendingRules: [],
        },
        {
            /**
             * Korean numerals rewritten from a reviewed expression list
             * (.github/audits/memory-eval-korean-numeral-amendment-2026-09-03.md).
             *
             * v3.4 built the rewrite from every Korean numeral crossed with
             * every counter, so it read the 일 ending 토요일 as the numeral one
             * and the 일 beginning 일정 as the day counter: `토요일 일정`
             * canonicalised to `토요1일정` and the token 격주토요일 existed in no
             * candidate that phrased it that way. `이십일` became `이10일` the
             * same way. Found by pointing the harness at `mem-eval-succ-7`,
             * where the smoke run scored 484 of 485 golds its own stub had
             * answered correctly.
             *
             * Fixing the gold instead was refused: shortening the token to
             * ["격주", "일정"] drops the condition being tested, ["격주", "토요"]
             * only routes around the defect, and succ-7 is frozen and signed
             * either way.
             *
             * v3.5 replaces the cross-product with `KOREAN_NUMERAL_EXPRESSIONS`,
             * a reviewed table of **three rows**, each registered because a
             * frozen gold cannot be scored without it: `육 개월`/`6개월` for
             * succ-durable-ko-35, `세 시`/`3시` for succ-durable-ko-36, and
             * `아홉 시`/`9시` for succ-durable-ko-401.
             *
             * Each row is **bounded on the left, and only on the left**. No
             * Hangul syllable may precede the numeral, or 교육 개월 is read as
             * six months and 전세 시장 destroys the gold 전세. That one
             * character is the only context the Korean numeral step reads; the
             * contraction, digit-separator and English numeral steps read word
             * boundaries of their own, which the rule statement sets out.
             *
             * A right boundary — a list of particles the counter could be
             * followed by — was carried for one day and withdrawn on
             * 2026-09-04. It constrained only the rewrite, and only the Korean
             * word spelling needs a rewrite, so it refused correct answers
             * (`아홉 시입니다`, `육 개월짜리`) while the false positives it named
             * reached the gold through the digit spelling regardless. What a
             * signature on this contract approves is the spacing the left
             * boundary assumes; what it acknowledges rather than approves is
             * that a gold token is matched as a substring, so `9시장` reaches a
             * `9시` gold in either spelling and did so under v3.4 as well.
             *
             * Nothing else moved: same rules, same thresholds, same
             * categories, same languages, same floors, same numeral table, same
             * counters. The difference is which expressions the step rewrites,
             * the step's name, and the version string.
             *
             * `approvedOn` is the day this record was written, and it is not a
             * signature — `mem-eval-succ-8` carries the approval that matters
             * and is unsigned. See its `MEMORY_EVAL_SUCC8_APPROVAL`.
             */
            version: "mem-score-v3.5",
            // 2026-09-04, not 09-03: the amendment was drafted on the 3rd and
            // its right boundary removed on the 4th, before any signature. The
            // date is when the digest below became what it is.
            approvedOn: "2026-09-04",
            descriptorDigest:
                "c20378d357805b6dee46fed5590405b705d4654a9a4c7e19ed53154283ccaa99",
            pendingRules: [],
        },
    ];

/**
 * Recomputes the live contract's descriptor and reports what no longer agrees.
 *
 * Only the live version is checkable: an earlier contract's constants are gone
 * from the tree, so its descriptor cannot be rebuilt and its recorded digest
 * stands as the record. `null` means this version has no manifest entry, which
 * is itself a finding — a contract in use and never frozen.
 */
export function verifyScoringContractManifest(): {
    version: string;
    entry: ScoringContractManifest | null;
    mismatches: readonly string[];
} {
    const entry =
        MEMORY_EVAL_SCORING_CONTRACT_MANIFESTS.find(
            (manifest) => manifest.version === MEMORY_EVAL_SCORING_CONTRACT_VERSION
        ) ?? null;
    if (!entry) {
        return {
            version: MEMORY_EVAL_SCORING_CONTRACT_VERSION,
            entry: null,
            mismatches: [
                `${MEMORY_EVAL_SCORING_CONTRACT_VERSION} is the live contract and no ` +
                    `manifest entry records it. Freezing a contract means pinning it.`,
            ],
        };
    }
    const digest = createHash("sha256")
        .update(scoringContractDescriptorInput(), "utf8")
        .digest("hex");
    return {
        version: entry.version,
        entry,
        mismatches:
            digest === entry.descriptorDigest
                ? []
                : [`descriptor digest: ${entry.descriptorDigest} -> ${digest}`],
    };
}
