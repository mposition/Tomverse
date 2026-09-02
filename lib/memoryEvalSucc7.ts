import { createHash } from "node:crypto";

import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";
import { datasetFingerprintInputV3 } from "@/lib/memoryEvalDatasetSchemaV3";
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
 * ## Adopted 2026-09-02
 *
 * `@mposition` reviewed all 54 replacements — 53 same-boundary, all passing,
 * and the one `coverage_repair` judged on its gold alone — and adopted this as
 * the decision set. The record is
 * `.github/audits/memory-eval-succ7-adoption-2026-09-02.md`.
 *
 * The manifest below is a **pinned literal**, which is the whole point of a
 * frozen record: a manifest recomputed from the tree cannot disagree with the
 * tree, and disagreeing with the tree is the only thing it is for.
 * `verifySucc7Manifest()` therefore takes the record and the recomputation as
 * two arguments with two different defaults. succ-6 shipped with
 * `manifest = build…()` on both sides, which made the no-argument call compare
 * the tree with itself and return empty however far the tree had moved; that is
 * the mistake this file is written to not repeat.
 *
 * What the signature covers is in the adoption record. It does not cover
 * `mem-extract-v8`, a pair, a budget, a paid run, the release gate or either
 * production flag — none of which this file touches.
 */
export const MEMORY_EVAL_SUCC7_DATASET_VERSION = "mem-eval-succ-7";

/**
 * True since the 2026-09-02 adoption.
 *
 * `decideEvalRunMode()` refuses a decision-grade run against an unfrozen
 * dataset, so this removes that one refusal and nothing else. A paid run still
 * needs a registered pair, an approved budget bound to this dataset's digests,
 * a clean named commit and an unused run ordinal — none of which exist.
 */
export const MEMORY_EVAL_SUCC7_DATASET_FROZEN = true;

export const MEMORY_EVAL_SUCC7_DATASET_PURPOSE: "development" | "decision" =
    "decision";

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
    /** True since adoption; part of the fingerprint, so it moved the digest. */
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

const manifestFingerprintInput = (
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
        `frozen=${manifest.frozen}`,
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
        datasetDigest: sha256(
            datasetFingerprintInputV3(MEMORY_EVAL_SUCC7_CASES)
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

/**
 * The manifest as adopted on 2026-09-02, written out.
 *
 * A literal, not a call. `buildSucc7DraftManifest()` recomputes from the tree,
 * so a record that *was* that call could never disagree with the tree — and
 * disagreeing with the tree is the only job a frozen record has.
 */
export const MEMORY_EVAL_SUCC7_MANIFEST: Succ7DraftManifest = {
    datasetVersion: "mem-eval-succ-7",
    schemaVersion: 3,
    supersedes: "mem-eval-succ-6",
    composition: {
        kind: "case-replacement",
        sourceDatasetVersion: "mem-eval-succ-6",
        sourceDatasetDigest:
            "2ffc8c09d6a20c2ad150d222fd71b891bf160b6c26b4d27684708ccbcf20fb63",
        inheritedCaseCount: 1096,
        replacedCaseCount: 54,
        changeReason: MEMORY_EVAL_SUCC7_CHANGE_REASON,
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
    transitionTypes: { same_boundary: 53, coverage_repair: 1 },
    unresolvedPolicies: [
        "succ-injection-en-301 -> succ-injection-en-601: unresolved: when one " +
            "user turn carries both a safety-gate demand and a presentation " +
            "preference, is the safe half extractable? The whole-turn " +
            "fail-closed rule stands unchanged and this transition does not " +
            "answer it.",
    ],
    datasetDigest:
        "3eb0d80c7b922933558c5523ee8583ce11a06814439aedf855ee6d7327188de1",
    scoringContractDigest:
        "a62f4bdd8d2073345e19e478541c20d81275a0d11fb78aa6e4df86ec0489b4cd",
    scoringContractVersion: "mem-score-v3.4",
    frozen: true,
    manifestDigest:
        "567c9ed6f50bc1bfb5bbc26bfa0ad6da62080b9804363072fbcc98214a250f6c",
};

/**
 * Everything about the signed record the tree no longer reproduces.
 *
 * Two sides, and **both defaults matter**. `manifest` defaults to the pinned
 * record, `built` to a fresh recomputation, so the no-argument call asks the
 * question a freeze exists to ask: does what was signed still describe what is
 * here? succ-6 shipped with the builder on both sides — the no-argument call
 * compared the tree with itself and returned empty however far the tree had
 * moved, and the pin sat there consulted by nothing.
 *
 * `built` is a parameter rather than a local so a test can hand in the manifest
 * a *moved* tree would produce without editing a file on disk. A check that
 * cannot be shown to fail is not evidence that anything passed.
 */
export function verifySucc7Manifest(
    manifest: Succ7DraftManifest = MEMORY_EVAL_SUCC7_MANIFEST,
    built: Succ7DraftManifest = buildSucc7DraftManifest()
): readonly string[] {
    const failures: string[] = [];
    const compare = (label: string, recorded: unknown, actual: unknown) => {
        if (JSON.stringify(recorded) !== JSON.stringify(actual)) {
            failures.push(
                `${label}: recorded ${JSON.stringify(recorded)}, tree ` +
                    `${JSON.stringify(actual)}`
            );
        }
    };
    compare("datasetVersion", manifest.datasetVersion, built.datasetVersion);
    compare("supersedes", manifest.supersedes, built.supersedes);
    compare("caseCount", manifest.caseCount, built.caseCount);
    compare("cellCounts", manifest.cellCounts, built.cellCounts);
    compare("transitionTypes", manifest.transitionTypes, built.transitionTypes);
    compare(
        "unresolvedPolicies",
        manifest.unresolvedPolicies,
        built.unresolvedPolicies
    );
    compare("composition", manifest.composition, built.composition);
    compare("datasetDigest", manifest.datasetDigest, built.datasetDigest);
    compare(
        "scoringContractDigest",
        manifest.scoringContractDigest,
        built.scoringContractDigest
    );
    compare("frozen", manifest.frozen, built.frozen);
    compare("manifestDigest", manifest.manifestDigest, built.manifestDigest);
    // The sample must differ from its source. A successor whose digest equals
    // succ-6's is a rename, indistinguishable from one in every artifact that
    // records only a version string.
    if (manifest.datasetDigest === manifest.composition.sourceDatasetDigest) {
        failures.push("succ-7's digest equals succ-6's — the sample did not move");
    }
    return failures;
}
