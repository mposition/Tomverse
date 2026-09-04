import { createHash } from "node:crypto";

import { datasetFingerprintInputV4 } from "@/lib/memoryEvalDatasetFingerprintV4";
import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";
import {
    MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    scoringContractDescriptorInput,
} from "@/lib/memoryEvalScoringContractDigest";
import {
    MEMORY_EVAL_SUCC8_CASES,
    MEMORY_EVAL_SUCC8_DATASET_VERSION,
    MEMORY_EVAL_SUCC8_MANIFEST,
} from "@/lib/memoryEvalSucc8";
import {
    MEMORY_EVAL_SUCC9_REPLACEMENTS,
    MEMORY_EVAL_SUCC9_RETIRED_CASE_IDS,
} from "@/lib/memoryEvalSucc9Replacements";
import {
    succ9Subtype,
    succ9SubtypeProblems,
} from "@/lib/memoryEvalSucc9Subtypes";
import {
    SUCC9_TRANSITION,
    SUCC9_TRANSITION_DIGEST,
} from "@/lib/memoryEvalSucc9Transition";

/**
 * `mem-eval-succ-9` — five cases out, five in, because they chose a prompt.
 *
 * ## What this successor is for
 *
 * `mem-extract-v8` added two worked negated examples, and choosing their kind
 * meant counting cases: the approved prompt licenses `relationship` and
 * `expertise` for a negation, `relationship` scored one Korean case and
 * `expertise` four, and the smaller count won. Those five golds are the
 * comparison that produced the prompt.
 *
 * A case that helped select a prompt cannot then measure it. succ-7 drew the
 * same line for the forty-four cases v8's *wording* was selected from; this
 * draws it around a count rather than a wording, and around the whole
 * comparison rather than the winning side — the four on the losing side are
 * what made the winner a choice.
 *
 * ## What it is not
 *
 * Not a correction. None of the five is wrong, and their content is preserved
 * runnable in `memoryEvalSucc9Regression.ts`. Not a contract change either:
 * succ-9 is scored by the same `mem-score-v3.5` succ-8 is, and the only reason
 * its `scoringContractDigest` is recomputed rather than inherited is that a
 * dataset records the contract it was frozen under.
 *
 * `mem-eval-succ-8` is untouched and stays resolvable. It is the dataset the
 * harness scores until succ-9 is signed and frozen; the move is a separate
 * step, for the reason succ-7's own record gives — a signature covers a
 * sample, and pointing the harness at one is a different decision.
 */

const sha256 = (input: string): string =>
    createHash("sha256").update(input, "utf8").digest("hex");

export const MEMORY_EVAL_SUCC9_DATASET_VERSION = "mem-eval-succ-9";
export const MEMORY_EVAL_SUCC9_SUPERSEDES = MEMORY_EVAL_SUCC8_DATASET_VERSION;

export const MEMORY_EVAL_SUCC9_CHANGE_REASON =
    "B+ for the five cases the mem-extract-v8 example kind was selected from; " +
    "1:1 replacements in the same category, language, kind and polarity";

/**
 * False, pending a signature.
 *
 * A case-changing successor cannot inherit its predecessor's freeze: what has
 * to be approved here is that these five left for the reason given and that
 * their replacements test the same boundaries, which is a person's decision.
 * `decideEvalRunMode()` refuses a decision-grade run against an unfrozen
 * sample, which is what should happen until then.
 */
export const MEMORY_EVAL_SUCC9_DATASET_FROZEN = false;

export const MEMORY_EVAL_SUCC9_DATASET_PURPOSE: "development" | "decision" =
    "decision";

const RETIRED = new Set(MEMORY_EVAL_SUCC9_RETIRED_CASE_IDS);

/**
 * The 1,145 carried over, in succ-8's order.
 *
 * Order is preserved rather than rebuilt so a diff of the two datasets reads
 * as five removals and five additions rather than a reshuffle.
 */
const INHERITED: readonly MemoryEvalCaseV3[] = MEMORY_EVAL_SUCC8_CASES.filter(
    (testCase) => !RETIRED.has(testCase.id)
);

export const MEMORY_EVAL_SUCC9_CASES: readonly MemoryEvalCaseV3[] = [
    ...INHERITED,
    ...MEMORY_EVAL_SUCC9_REPLACEMENTS,
];

export const MEMORY_EVAL_SUCC9_INHERITED_COUNT = INHERITED.length;

/** The human record. Null at rest; signing fills all five together. */
export const MEMORY_EVAL_SUCC9_APPROVAL: {
    approvedBy: string | null;
    approvedAt: string | null;
    approvedCommit: string | null;
    signedDatasetDigest: string | null;
    signedManifestDigest: string | null;
    scope: "case-replacement";
    record: string;
} = {
    approvedBy: null,
    approvedAt: null,
    approvedCommit: null,
    signedDatasetDigest: null,
    signedManifestDigest: null,
    /**
     * `case-replacement`, not `contract-only`: five cases changed, so this
     * signature covers a sample and not only a label. succ-8's scope word was
     * the other one, and reusing it here would understate what is being
     * approved.
     */
    scope: "case-replacement",
    record: ".github/audits/mem-extract-v8-implementation-2026-09-04.md",
};

export type Succ9Composition = {
    kind: "case-replacement";
    sourceDatasetVersion: string;
    sourceDatasetDigest: string;
    /** This successor's own pairing, not the source's. */
    transitionDigest: string;
    retiredCount: number;
    replacementCount: number;
    changeReason: string;
};

export type Succ9DatasetManifest = {
    datasetVersion: "mem-eval-succ-9";
    schemaVersion: 3;
    supersedes: "mem-eval-succ-8";
    composition: Succ9Composition;
    caseCount: number;
    cellCounts: Readonly<Record<string, number>>;
    /** v4, as succ-7 and succ-8 are: the fingerprint covers conversation titles. */
    fingerprintVersion: 4;
    datasetDigest: string;
    scoringContractDigest: string;
    scoringContractVersion: string;
    /** Reported but NOT part of `manifestDigest`, as in succ-7 and succ-8. */
    frozen: boolean;
    manifestDigest: string;
};

/**
 * The manifest's identity, serialized.
 *
 * `frozen` is deliberately absent, for the reason succ-7 states: inside the
 * fingerprint, the digest signed off on (`frozen=false`) is not the digest
 * that exists a moment later (`frozen=true`), so nobody ever signs the thing
 * that gets frozen.
 */
export function succ9ManifestFingerprintInput(
    manifest: Omit<Succ9DatasetManifest, "manifestDigest">
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
        `transitionDigest=${manifest.composition.transitionDigest}`,
        `retired=${manifest.composition.retiredCount}`,
        `replacements=${manifest.composition.replacementCount}`,
        `caseCount=${manifest.caseCount}`,
        `cells=${cells}`,
        `fingerprint=v${manifest.fingerprintVersion}`,
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
    return Object.fromEntries(Object.entries(counts).sort());
};

/** The manifest as the tree computes it now. */
export function buildSucc9Manifest(): Succ9DatasetManifest {
    const datasetDigest = sha256(
        datasetFingerprintInputV4(MEMORY_EVAL_SUCC9_CASES)
    );
    const withoutDigest: Omit<Succ9DatasetManifest, "manifestDigest"> = {
        datasetVersion: "mem-eval-succ-9",
        schemaVersion: 3,
        supersedes: "mem-eval-succ-8",
        composition: {
            kind: "case-replacement",
            sourceDatasetVersion: MEMORY_EVAL_SUCC8_DATASET_VERSION,
            sourceDatasetDigest: MEMORY_EVAL_SUCC8_MANIFEST.datasetDigest,
            transitionDigest: SUCC9_TRANSITION_DIGEST,
            retiredCount: MEMORY_EVAL_SUCC9_RETIRED_CASE_IDS.length,
            replacementCount: MEMORY_EVAL_SUCC9_REPLACEMENTS.length,
            changeReason: MEMORY_EVAL_SUCC9_CHANGE_REASON,
        },
        caseCount: MEMORY_EVAL_SUCC9_CASES.length,
        cellCounts: cellCountsOf(MEMORY_EVAL_SUCC9_CASES),
        fingerprintVersion: 4,
        datasetDigest,
        scoringContractDigest: sha256(scoringContractDescriptorInput()),
        scoringContractVersion: MEMORY_EVAL_SCORING_CONTRACT_VERSION,
        frozen: MEMORY_EVAL_SUCC9_DATASET_FROZEN,
    };
    return {
        ...withoutDigest,
        manifestDigest: sha256(succ9ManifestFingerprintInput(withoutDigest)),
    };
}

/**
 * Every axis on which a replacement has to match what it replaces.
 *
 * "Same boundary" was three axes for one round — category, language, and the
 * sorted set of `kind|polarity` — and three axes let a replacement keep all of
 * them while testing something else. `succ-durable-ko-422` is the case that
 * shows it: its negated gold carries two values (`바다`, `헤엄`) because the
 * sentence affirms the ability and denies the setting, and a single-valued
 * replacement passes a `kind|polarity` comparison while dropping exactly the
 * discrimination the case was written for.
 *
 * So the axes below are everything a scorer reads that is not the subject
 * matter itself: what the gold demands, how completely it is meant to be
 * found, how many values it names, where it anchors, and the shape of the
 * conversation it anchors into. What is deliberately *not* here is the text —
 * the subject changes, or the retirement bought nothing.
 *
 * Each entry is `[axis, was, now]`, compared as strings so a report can print
 * both sides.
 */
function boundaryAxes(
    original: MemoryEvalCaseV3,
    replacement: MemoryEvalCaseV3
): readonly (readonly [string, string, string])[] {
    const golds = (testCase: MemoryEvalCaseV3) =>
        [...(testCase.expected ?? [])]
            .map(
                (gold) =>
                    `${gold.kind}|${gold.polarity}|${gold.expectedDisposition}` +
                    `|all=${(gold.factValueAll ?? []).length}` +
                    `|any=${(gold.factValueAny ?? []).length}`
            )
            .sort()
            .join(",");
    /**
     * Where each gold anchors, by *position* rather than by message id: ids
     * necessarily change with the case, and the boundary is that the first
     * gold comes from the opening turn and the second from a later one.
     */
    const anchors = (testCase: MemoryEvalCaseV3) => {
        const order = new Map<string, number>();
        let index = 0;
        for (const conversation of testCase.conversations ?? []) {
            for (const message of conversation.messages ?? []) {
                order.set(message.externalMessageId, index++);
            }
        }
        const roleOf = new Map<string, string>();
        for (const conversation of testCase.conversations ?? []) {
            for (const message of conversation.messages ?? []) {
                roleOf.set(message.externalMessageId, message.role);
            }
        }
        return [...(testCase.expected ?? [])]
            .map((gold) => {
                const id = gold.evidence?.evidenceMessageId ?? "";
                return `${order.get(id) ?? -1}:${roleOf.get(id) ?? "?"}`;
            })
            .sort()
            .join(",");
    };
    const turns = (testCase: MemoryEvalCaseV3) =>
        (testCase.conversations ?? [])
            .map((conversation) =>
                (conversation.messages ?? []).map((message) => message.role).join(">")
            )
            .join(" | ");
    return [
        ["category", original.category, replacement.category],
        ["language", original.language, replacement.language],
        [
            "goldCompleteness",
            String(original.goldCompleteness),
            String(replacement.goldCompleteness),
        ],
        [
            "criticalGoldMode",
            String(original.criticalGoldMode),
            String(replacement.criticalGoldMode),
        ],
        [
            "gold count",
            String((original.expected ?? []).length),
            String((replacement.expected ?? []).length),
        ],
        ["gold shape", golds(original), golds(replacement)],
        ["evidence anchoring", anchors(original), anchors(replacement)],
        ["conversation shape", turns(original), turns(replacement)],
    ];
}

/**
 * What has to hold for this to be the successor it says it is.
 *
 * Reported rather than thrown, so the check script prints every problem at
 * once. A pinned literal manifest and a signature verifier are deliberately
 * absent until there is a signature to pin: succ-8 shipped both the day it was
 * signed, and writing them before then is a record of an approval nobody gave.
 */
export function succ9Problems(
    manifest: Succ9DatasetManifest = buildSucc9Manifest()
): readonly string[] {
    const problems: string[] = [];

    if (MEMORY_EVAL_SUCC9_REPLACEMENTS.length !== SUCC9_TRANSITION.length) {
        problems.push(
            `${MEMORY_EVAL_SUCC9_REPLACEMENTS.length} replacements against ` +
                `${SUCC9_TRANSITION.length} transitions`
        );
    }
    if (MEMORY_EVAL_SUCC9_CASES.length !== MEMORY_EVAL_SUCC8_CASES.length) {
        problems.push(
            "a 1:1 replacement changed the case count: " +
                `${MEMORY_EVAL_SUCC8_CASES.length} -> ${MEMORY_EVAL_SUCC9_CASES.length}`
        );
    }

    const present = new Set(MEMORY_EVAL_SUCC9_CASES.map((entry) => entry.id));
    const succ8 = new Map(MEMORY_EVAL_SUCC8_CASES.map((entry) => [entry.id, entry]));
    const replacements = new Map(
        MEMORY_EVAL_SUCC9_REPLACEMENTS.map((entry) => [entry.id, entry])
    );

    for (const row of SUCC9_TRANSITION) {
        const original = succ8.get(row.retired);
        if (!original) {
            problems.push(`${row.retired} is not in succ-8, so it cannot retire from it`);
            continue;
        }
        if (present.has(row.retired)) {
            problems.push(`${row.retired} is still in the decision set`);
        }
        const replacement = replacements.get(row.replacement);
        if (!replacement) {
            problems.push(`${row.replacement} is named but not registered`);
            continue;
        }
        for (const [axis, was, now] of boundaryAxes(original, replacement)) {
            if (was !== now) {
                problems.push(
                    `${row.replacement} ${axis} is ${now}, where ${row.retired} ` +
                        `was ${was}`
                );
            }
        }
    }

    // The cell counts are the composition, and a replacement in the wrong cell
    // is the way that changes without anybody meaning it to.
    const before = cellCountsOf(MEMORY_EVAL_SUCC8_CASES);
    for (const [cell, count] of Object.entries(manifest.cellCounts)) {
        if (before[cell] !== count) {
            problems.push(
                `cell ${cell} moved from ${before[cell] ?? 0} to ${count}`
            );
        }
    }

    // The docs/ops/memory-extraction-eval-dataset.md §3.3 subtype floor, which
    // a 1:1 case count hides completely. Three of the five leaving are subtype
    // 3, both assistant_only arms sit exactly on the floor, and a replacement
    // arriving unclassified takes its arm under without changing a single
    // count this manifest records.
    problems.push(...succ9SubtypeProblems(MEMORY_EVAL_SUCC9_CASES));
    for (const language of ["ko", "en"]) {
        const cell = MEMORY_EVAL_SUCC9_CASES.filter(
            (testCase) =>
                testCase.category === "assistant_only" &&
                testCase.language === language
        );
        const hard = cell.filter((testCase) =>
            [3, 4].includes(succ9Subtype(testCase.id) ?? 0)
        ).length;
        const floor = Math.ceil(cell.length * 0.3);
        if (hard < floor) {
            problems.push(
                `assistant_only:${language} holds ${hard} subtype 3/4 cases ` +
                    `against a floor of ${floor} (of ${cell.length})`
            );
        }
    }
    // And the composition, not merely the count: a subtype 4 arriving for a
    // subtype 3 holds the floor while changing what the arm measures.
    for (const language of ["ko", "en"]) {
        const tally = (ids: readonly string[]) => {
            const counts: Record<string, number> = {};
            for (const id of ids) {
                const subtype = succ9Subtype(id);
                if (subtype === undefined) continue;
                counts[subtype] = (counts[subtype] ?? 0) + 1;
            }
            return JSON.stringify(counts);
        };
        const prefix = `succ-assistant-${language}-`;
        const out = tally(
            SUCC9_TRANSITION.filter((row) => row.retired.startsWith(prefix)).map(
                (row) => row.retired
            )
        );
        const arriving = tally(
            SUCC9_TRANSITION.filter((row) =>
                row.replacement.startsWith(prefix)
            ).map((row) => row.replacement)
        );
        if (out !== arriving) {
            problems.push(
                `assistant_only:${language} subtype composition changed — ` +
                    `out ${out}, in ${arriving}`
            );
        }
    }

    if (manifest.composition.transitionDigest !== SUCC9_TRANSITION_DIGEST) {
        problems.push("the manifest's transition digest is not this tree's");
    }
    if (manifest.datasetDigest === MEMORY_EVAL_SUCC8_MANIFEST.datasetDigest) {
        problems.push(
            "the dataset digest equals succ-8's, so nothing about the sample changed"
        );
    }
    if (MEMORY_EVAL_SUCC9_DATASET_FROZEN && !MEMORY_EVAL_SUCC9_APPROVAL.approvedBy) {
        problems.push("frozen with nobody's name on it");
    }
    return problems;
}
