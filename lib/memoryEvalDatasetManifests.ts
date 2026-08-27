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
];

/** The manifest for a version, or `undefined`. Fail-closed at the call site. */
export const evalDatasetManifest = (
    datasetVersion: string
): EvalDatasetManifest | undefined =>
    MEMORY_EVAL_DATASET_MANIFESTS.find(
        (manifest) => manifest.datasetVersion === datasetVersion
    );

