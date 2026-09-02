import { createHash } from "node:crypto";

import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";
import { datasetFingerprintInputV3 } from "@/lib/memoryEvalDatasetSchemaV3";
import { datasetFingerprintInputV4 } from "@/lib/memoryEvalDatasetFingerprintV4";
import {
    MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    scoringContractDescriptorInput,
} from "@/lib/memoryEvalScoringContractDigest";
import { MEMORY_EVAL_SUCC6_CASES } from "@/lib/memoryEvalSucc6";
import { MEMORY_EVAL_SUCC7_REPLACEMENTS } from "@/lib/memoryEvalSucc7Replacements";
import {
    SUCC7_COVERAGE_REPAIR_COUNT,
    SUCC7_RETIRED_CASE_IDS,
    SUCC7_SAME_BOUNDARY_COUNT,
    SUCC7_TRANSITION,
} from "@/lib/memoryEvalSucc7Transition";

/**
 * `mem-eval-succ-7`, assembled and NOT frozen.
 *
 * Fifty-four out and fifty-four in against succ-6: ten carrying an approved
 * gold change, forty-four that selected the `mem-extract-v8` intervention. The
 * retired cases are preserved in `lib/memoryEvalSucc7Regression.ts`.
 *
 * ## Not adopted, and therefore not pinned
 *
 * There is no manifest literal here and `frozen` is false. A pin is the record
 * a person signs, and no one has: the review sheet's verdict, reviewer and
 * signature are blank. An adoption record written ahead of that signature
 * asserts a fact that does not exist, which is what happened once on this
 * branch and was reverted.
 *
 * When the pin does arrive it must satisfy two things this file is built for.
 * `verifySucc7Manifest()` will take the record and the recomputation as two
 * parameters with two *different* defaults — succ-6 shipped with the builder
 * on both sides, so its no-argument call compared the tree with itself and
 * returned empty however far the tree had moved. And the digest a reviewer
 * signs must be the digest that gets frozen, which is why `frozen` is not part
 * of this manifest's identity (see `manifestFingerprintInput`).
 */
export const MEMORY_EVAL_SUCC7_DATASET_VERSION = "mem-eval-succ-7";

/**
 * False. `decideEvalRunMode()` refuses a decision-grade run against an
 * unfrozen dataset, which is what should happen to succ-7 until a person
 * signs the review sheet.
 */
export const MEMORY_EVAL_SUCC7_DATASET_FROZEN = false;

export const MEMORY_EVAL_SUCC7_DATASET_PURPOSE: "development" | "decision" =
    "decision";

/**
 * The signature the adoption rests on.
 *
 * A record, not a flag. `reviewed` had been the string "false" written into
 * two scripts, which can only ever say what its author believed on the day —
 * it names nobody, cites nothing, and cannot disagree with the tree. What a
 * signature has to survive is the case that follows it: an edit after the
 * review, keeping the same version number.
 *
 * So the digests the reviewer actually read are recorded here, and
 * `succ7SignatureProblems()` compares them with what the tree computes now.
 * Move a case and the signature stops matching — which is the whole of what
 * signing a dataset can mean.
 *
 * `reviewedCommit` is the commit whose sheet was read. It is not the commit
 * that froze the dataset; that one cannot contain its own SHA, and it is
 * recorded afterwards in the adoption record.
 *
 * What the signature covers is in
 * `.github/audits/memory-eval-succ7-adoption-2026-09-02.md`: the 54
 * replacements and their gold. It does not cover the harness target, which
 * still points at succ-6, nor `mem-extract-v8`, a pair, a budget, a paid run,
 * a release gate or a feature flag — each of those is its own decision with
 * its own record, and none of them was signed here.
 */
export type Succ7AdoptionSignature = {
    status: "signed";
    reviewer: string;
    reviewedAt: string;
    reviewedCommit: string;
    signedDatasetDigest: string;
    signedManifestDigest: string;
    signedSourceDatasetDigest: string;
    verdict: {
        sameBoundaryPassed: number;
        sameBoundaryTotal: number;
        coverageRepairGoldFit: boolean;
        problemCases: number;
        cellDiversitySufficient: boolean;
    };
    record: string;
};

export const MEMORY_EVAL_SUCC7_REVIEW: Succ7AdoptionSignature = {
    status: "signed",
    reviewer: "@mposition",
    reviewedAt: "2026-09-02",
    reviewedCommit: "e522796dd11e3d009d23a13836b7a45b005f3bc8",
    signedDatasetDigest:
        "9326730a889d99008ca1c5709fcaaa4226f6031c25b9aced7b1fb26e46498251",
    signedManifestDigest:
        "42c9b0a877086dc4767613e6b357d85ccba7ef40a67f7ff02d7d64b0ced91965",
    signedSourceDatasetDigest:
        "2ffc8c09d6a20c2ad150d222fd71b891bf160b6c26b4d27684708ccbcf20fb63",
    verdict: {
        sameBoundaryPassed: 53,
        sameBoundaryTotal: 53,
        coverageRepairGoldFit: true,
        problemCases: 0,
        cellDiversitySufficient: true,
    },
    record: ".github/audits/memory-eval-succ7-adoption-2026-09-02.md",
};

/** True once a person has signed. Nothing in this file may set it. */
export const MEMORY_EVAL_SUCC7_REVIEWED =
    MEMORY_EVAL_SUCC7_REVIEW.status === "signed";

const RETIRED = new Set(SUCC7_RETIRED_CASE_IDS);

/**
 * The 1,096 carried over, in succ-6's order.
 *
 * Order is preserved rather than rebuilt so a diff of the two datasets reads
 * as fifty-four removals and fifty-four additions rather than a reshuffle.
 */
const INHERITED: readonly MemoryEvalCaseV3[] = MEMORY_EVAL_SUCC6_CASES.filter(
    (testCase) => !RETIRED.has(testCase.id)
);

export const MEMORY_EVAL_SUCC7_CASES: readonly MemoryEvalCaseV3[] = [
    ...INHERITED,
    ...MEMORY_EVAL_SUCC7_REPLACEMENTS,
];

export const MEMORY_EVAL_SUCC7_INHERITED_COUNT = INHERITED.length;

export const MEMORY_EVAL_SUCC7_CHANGE_REASON =
    "B+ for the ten approved gold changes and the forty-four cases the " +
    "mem-extract-v8 wording was selected from; 1:1 replacements throughout, " +
    "assistant_only subtype composition preserved";

const sha256 = (input: string): string =>
    createHash("sha256").update(input, "utf8").digest("hex");

export type Succ7DraftManifest = {
    datasetVersion: string;
    schemaVersion: 3;
    supersedes: string;
    composition: {
        kind: "case-replacement";
        sourceDatasetVersion: string;
        sourceDatasetDigest: string;
        inheritedCaseCount: number;
        replacedCaseCount: number;
        changeReason: string;
    };
    caseCount: number;
    cellCounts: Readonly<Record<string, number>>;
    /**
     * 4. v3 omitted `conversation.title` while the prompt sends it, so a title
     * edit changed every model input and no digest at all.
     */
    fingerprintVersion: 4;
    /**
     * 53 and 1. Bound into the digest, not merely reported, because the split
     * is a claim about what the dataset measures: fold the coverage repair
     * into the same-boundary count and the manifest says 54 boundaries are
     * still covered when one of them is not.
     */
    transitionTypes: Readonly<{
        same_boundary: number;
        coverage_repair: number;
    }>;
    /**
     * The policy questions this dataset carries forward without answering,
     * each named by the transition that raised it. Bound into the digest so a
     * later edit that quietly resolves one moves the manifest.
     */
    unresolvedPolicies: readonly string[];
    datasetDigest: string;
    scoringContractDigest: string;
    scoringContractVersion: string;
    /**
     * Lifecycle state, reported but NOT part of `manifestDigest` — see
     * `manifestFingerprintInput`.
     */
    frozen: boolean;
    manifestDigest: string;
};

const cellCountsOf = (
    cases: readonly MemoryEvalCaseV3[]
): Record<string, number> => {
    const counts: Record<string, number> = {};
    for (const testCase of cases) {
        const cell = `${testCase.category}:${testCase.language}`;
        counts[cell] = (counts[cell] ?? 0) + 1;
    }
    return Object.fromEntries(Object.entries(counts).sort());
};

export const manifestFingerprintInput = (
    manifest: Omit<Succ7DraftManifest, "manifestDigest">
): string =>
    [
        manifest.datasetVersion,
        `schema=${manifest.schemaVersion}`,
        `supersedes=${manifest.supersedes}`,
        `kind=${manifest.composition.kind}`,
        `from=${manifest.composition.sourceDatasetVersion}`,
        `fromDigest=${manifest.composition.sourceDatasetDigest}`,
        `inherited=${manifest.composition.inheritedCaseCount}`,
        `replaced=${manifest.composition.replacedCaseCount}`,
        `reason=${manifest.composition.changeReason}`,
        `cases=${manifest.caseCount}`,
        `sameBoundary=${manifest.transitionTypes.same_boundary}`,
        `coverageRepair=${manifest.transitionTypes.coverage_repair}`,
        ...manifest.unresolvedPolicies.map((q) => `unresolved=${q}`),
        ...Object.entries(manifest.cellCounts).map(
            ([cell, n]) => `cell=${cell}:${n}`
        ),
        `dataset=${manifest.datasetDigest}`,
        `contract=${manifest.scoringContractVersion}`,
        `contractDigest=${manifest.scoringContractDigest}`,
        `fingerprint=v${manifest.fingerprintVersion}`,
        // `frozen` is deliberately absent. It is lifecycle state, not
        // identity: inside the fingerprint, the digest a reviewer signs off on
        // (frozen=false) is not the digest that exists a moment later
        // (frozen=true), so nobody ever signs the thing that gets frozen.
    ].join("\n");

export function buildSucc7DraftManifest(): Succ7DraftManifest {
    const withoutDigest: Omit<Succ7DraftManifest, "manifestDigest"> = {
        datasetVersion: MEMORY_EVAL_SUCC7_DATASET_VERSION,
        schemaVersion: 3,
        supersedes: "mem-eval-succ-6",
        composition: {
            kind: "case-replacement",
            sourceDatasetVersion: "mem-eval-succ-6",
            sourceDatasetDigest: sha256(
                datasetFingerprintInputV3(MEMORY_EVAL_SUCC6_CASES)
            ),
            inheritedCaseCount: INHERITED.length,
            replacedCaseCount: MEMORY_EVAL_SUCC7_REPLACEMENTS.length,
            changeReason: MEMORY_EVAL_SUCC7_CHANGE_REASON,
        },
        caseCount: MEMORY_EVAL_SUCC7_CASES.length,
        cellCounts: cellCountsOf(MEMORY_EVAL_SUCC7_CASES),
        transitionTypes: {
            same_boundary: SUCC7_SAME_BOUNDARY_COUNT,
            coverage_repair: SUCC7_COVERAGE_REPAIR_COUNT,
        },
        unresolvedPolicies: SUCC7_TRANSITION.flatMap((row) =>
            row.unresolvedPolicy
                ? [`${row.retired} -> ${row.replacement}: ${row.unresolvedPolicy}`]
                : []
        ),
        fingerprintVersion: 4,
        datasetDigest: sha256(
            datasetFingerprintInputV4(MEMORY_EVAL_SUCC7_CASES)
        ),
        scoringContractDigest: sha256(scoringContractDescriptorInput()),
        scoringContractVersion: MEMORY_EVAL_SCORING_CONTRACT_VERSION,
        frozen: MEMORY_EVAL_SUCC7_DATASET_FROZEN,
    };
    return {
        ...withoutDigest,
        manifestDigest: sha256(manifestFingerprintInput(withoutDigest)),
    };
}

/**
 * Everything the signature claims that the tree no longer supports.
 *
 * The comparison runs the way a signature has to: a recorded literal against a
 * value recomputed here and now. A version that recomputed both sides would
 * agree with itself forever, which is the failure this repository has already
 * shipped once — `verifySucc6Manifest()` was defaulting both of its arguments
 * to the builder, so the freeze check compared the tree with the tree and
 * reported a clean bill through any edit at all.
 *
 * `sourceDatasetDigest` is checked too. It is succ-6's identity, and a
 * signature that still matches succ-7 while its predecessor moved underneath
 * would be describing a lineage that no longer exists.
 */
export function succ7SignatureProblems(
    signature: Succ7AdoptionSignature = MEMORY_EVAL_SUCC7_REVIEW,
    built: Succ7DraftManifest = buildSucc7DraftManifest()
): readonly string[] {
    const problems: string[] = [];
    if (signature.signedDatasetDigest !== built.datasetDigest) {
        problems.push(
            `the signature is of dataset ${signature.signedDatasetDigest}, the ` +
                `tree holds ${built.datasetDigest}`
        );
    }
    if (signature.signedManifestDigest !== built.manifestDigest) {
        problems.push(
            `the signature is of manifest ${signature.signedManifestDigest}, the ` +
                `tree computes ${built.manifestDigest}`
        );
    }
    if (
        signature.signedSourceDatasetDigest !==
        built.composition.sourceDatasetDigest
    ) {
        problems.push(
            `the signature records succ-6 as ${signature.signedSourceDatasetDigest}, ` +
                `the tree computes ${built.composition.sourceDatasetDigest}`
        );
    }
    if (!signature.reviewer || !signature.reviewedAt) {
        problems.push("the signature names no reviewer, or no date");
    }
    // A verdict is what was signed; a partial one is not a signature of this
    // dataset. Recorded as numbers rather than a boolean so a later reader can
    // see what the reviewer actually passed, and so a quietly weakened verdict
    // is a diff rather than a mood.
    const { verdict } = signature;
    if (verdict.sameBoundaryPassed !== verdict.sameBoundaryTotal) {
        problems.push(
            `the verdict passes ${verdict.sameBoundaryPassed} of ` +
                `${verdict.sameBoundaryTotal} same-boundary transitions`
        );
    }
    if (verdict.sameBoundaryTotal !== SUCC7_SAME_BOUNDARY_COUNT) {
        problems.push(
            `the verdict counts ${verdict.sameBoundaryTotal} same-boundary ` +
                `transitions, the transition declares ${SUCC7_SAME_BOUNDARY_COUNT}`
        );
    }
    if (verdict.problemCases !== 0) {
        problems.push(`the verdict records ${verdict.problemCases} problem case(s)`);
    }
    if (!verdict.coverageRepairGoldFit) {
        problems.push("the coverage repair's gold was not passed");
    }
    if (!verdict.cellDiversitySufficient) {
        problems.push("a cell's diversity was not found sufficient");
    }
    return problems;
}

/**
 * Structural problems a draft can still have. Not a freeze check.
 */
export function succ7AssemblyProblems(): readonly string[] {
    const problems: string[] = [];
    const ids = new Set(MEMORY_EVAL_SUCC7_CASES.map((c) => c.id));
    if (ids.size !== MEMORY_EVAL_SUCC7_CASES.length) {
        problems.push("succ-7 contains duplicate case ids");
    }
    for (const row of SUCC7_TRANSITION) {
        if (ids.has(row.retired)) {
            problems.push(`${row.retired} is retired but still present`);
        }
        if (!ids.has(row.replacement)) {
            problems.push(`${row.replacement} is a replacement and is missing`);
        }
    }
    // The sample must have moved. A successor whose digest matches its source
    // is a rename, and would be indistinguishable from one in every artifact
    // that records only the version string.
    const before = sha256(datasetFingerprintInputV3(MEMORY_EVAL_SUCC6_CASES));
    const after = sha256(datasetFingerprintInputV3(MEMORY_EVAL_SUCC7_CASES));
    if (before === after) {
        problems.push("succ-7's digest equals succ-6's — the sample did not move");
    }
    return problems;
}

