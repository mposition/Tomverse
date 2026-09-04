import { createHash } from "node:crypto";

import { isCalendarDay } from "@/lib/memoryEvalCalendarDay";
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
    SUCC9_SUBTYPE_REVIEW,
    isReviewerHandle,
    succ9Subtype,
    succ9SubtypeDigest,
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
 * Not a correction — that is what put the five on the list. All five left for
 * their part in choosing a prompt, not for anything they got wrong, and all
 * five are preserved runnable in `memoryEvalSucc9Regression.ts`.
 *
 * One of them turned out to be wrong as well, which is a separate fact about
 * one case rather than the reason any of them moved. `succ-durable-ko-422`
 * claims to be `exhaustive` and leaves a fact its own user turn states
 * unclaimed, so its replacement keeps both of its golds and adds a third, and
 * the transition table records that row as a `repair` rather than a
 * same-boundary move. succ-8 keeps the case as it is: it is frozen and signed,
 * and inheriting a defect is not a licence to ship one.
 *
 * Not a contract change either:
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
    "four 1:1 same-boundary replacements and one repair, which keeps its " +
    "original's golds and adds the affirmed fact the case left unclaimed";

/**
 * True since 2026-09-04.
 *
 * A case-changing successor cannot inherit its predecessor's freeze, so this
 * was approved on its own terms: that the five left for the reason given, that
 * four of the replacements test the same boundary, and that the fifth is a
 * repair whose extra gold is one its original should have had.
 * `MEMORY_EVAL_SUCC9_APPROVAL` carries who said so, when, and against which
 * bytes.
 *
 * The other precondition was met first, and the order was not cosmetic.
 * `succ9Problems()` refuses a freeze while `SUCC9_SUBTYPE_REVIEW` is an AI
 * draft — both `assistant_only` arms sit exactly on their floor, so those
 * three rows are what puts them there — and confirming that reading moved
 * `subtypeDigest` and this manifest's digest with it. Confirming after signing
 * would have signed bytes that stopped existing.
 *
 * Frozen is not runnable. `decideEvalRunMode()` has one fewer reason to refuse
 * a decision-grade run and still refuses: no pair is registered and no budget
 * is approved, which is `unknown_pair`. The harness also still scores succ-8;
 * pointing it here is its own decision and has not been taken.
 */
export const MEMORY_EVAL_SUCC9_DATASET_FROZEN = true;

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
    /**
     * Signed 2026-09-04 against `25b3f503`, whose twenty checks were all green
     * when the approval was given.
     *
     * The approval named the four things it settles: the B+ retirement of the
     * five cases the `mem-extract-v8` example kind was counted from and their
     * preservation in the regression corpus, the four same-boundary
     * replacements, the repair that gives `succ-durable-ko-701` the affirmed
     * gold its original left unclaimed, and the 1,150-case sample the two
     * digests below identify.
     *
     * It settles nothing downstream. The harness still scores succ-8, the pair
     * register is empty, and no budget exists — each is its own decision, and
     * a frozen sample is a precondition for them rather than a step toward
     * them.
     */
    approvedBy: "@mposition",
    approvedAt: "2026-09-04",
    approvedCommit: "25b3f503ed2637d7b160e6a8c5750203d5e60b1d",
    signedDatasetDigest:
        "626f71362046b7d88df9dbb07e2f51fa0e908c78192f74bd837fa88e9ce1d4e6",
    signedManifestDigest:
        "82d9aa48fe96037b7493dae26594a73482d7ba4a915532caffc9be411085f40c",
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
    /**
     * The docs/ops/memory-extraction-eval-dataset.md §3.3 reading succ-9's floor rests on, across all three subtype
     * tables — see `succ9SubtypeDigest()`. Inside the manifest because a
     * signature over the sample covers no part of it otherwise, and because
     * both `assistant_only` arms sit exactly on the floor.
     */
    subtypeDigest: string;
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
        `subtypeDigest=${manifest.subtypeDigest}`,
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
        subtypeDigest: succ9SubtypeDigest(),
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
 * One string per gold, carrying its anchor with it, sorted.
 *
 * The anchor is by *position and role* rather than by message id, because ids
 * necessarily change with the case while "the first gold comes from the
 * opening turn and the second from a later one" is the boundary.
 *
 * Carrying it **inside** the gold's own descriptor rather than in a second
 * sorted list is the point. Two independently sorted multisets say only
 * "these kinds appear and these anchors appear"; a replacement that swapped
 * which gold came from which turn — the goal read off the later turn and the
 * gap off the opening one, inverting the case — matched both of them. The
 * pair is the fact.
 */
function goldDescriptors(testCase: MemoryEvalCaseV3): readonly string[] {
    const position = new Map<string, string>();
    let index = 0;
    for (const conversation of testCase.conversations ?? []) {
        for (const message of conversation.messages ?? []) {
            position.set(message.externalMessageId, `${index++}:${message.role}`);
        }
    }
    return [...(testCase.expected ?? [])]
        .map((gold) => {
            const anchor =
                position.get(gold.evidence?.evidenceMessageId ?? "") ??
                "unanchored";
            return (
                `${gold.kind}|${gold.polarity}|${gold.expectedDisposition}` +
                `|all=${(gold.factValueAll ?? []).length}` +
                `|any=${(gold.factValueAny ?? []).length}` +
                `@${anchor}`
            );
        })
        .sort();
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
 * matter itself: what each gold demands, how completely it is meant to be
 * found, how many values it names, **which turn it reads it off**, and the
 * shape of the conversation it reads into. What is deliberately *not* here is
 * the text — the subject changes, or the retirement bought nothing.
 *
 * Each entry is `[axis, was, now]`, compared as strings so a report can print
 * both sides.
 */
function boundaryAxes(
    original: MemoryEvalCaseV3,
    replacement: MemoryEvalCaseV3
): readonly (readonly [string, string, string])[] {
    const golds = (testCase: MemoryEvalCaseV3) =>
        goldDescriptors(testCase).join(",");
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
        ["gold shape and anchoring", golds(original), golds(replacement)],
        ["conversation shape", turns(original), turns(replacement)],
    ];
}

/**
 * The manifest as it was signed, written out rather than computed.
 *
 * A builder answers "what does this tree say today", and a signature has to be
 * able to disagree with today. Every value here is frozen text: if a case, a
 * cell, the transition table or the subtype reading moves, this record stops
 * matching what the tree computes and `verifySucc9Manifest()` names the field
 * that moved. That is the point of pinning it, and it is not something two
 * builder calls can do for each other.
 *
 * Every value is also stated in
 * `.github/audits/mem-extract-v8-implementation-2026-09-04.md`, so a diff of
 * this constant is a diff of the claim.
 */
export const MEMORY_EVAL_SUCC9_MANIFEST: Succ9DatasetManifest = {
    datasetVersion: "mem-eval-succ-9",
    schemaVersion: 3,
    supersedes: "mem-eval-succ-8",
    composition: {
        kind: "case-replacement",
        sourceDatasetVersion: "mem-eval-succ-8",
        sourceDatasetDigest:
            "9326730a889d99008ca1c5709fcaaa4226f6031c25b9aced7b1fb26e46498251",
        transitionDigest:
            "cf8fa0800fe97be1daee34a27ba3196a4ba6cbe421b1d280b061cd0ad52bb6cd",
        retiredCount: 5,
        replacementCount: 5,
        changeReason: MEMORY_EVAL_SUCC9_CHANGE_REASON,
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
    subtypeDigest:
        "9a4e418c7fd36a4d84b53b99ed41d731c83a5f53d93af117c4c8fd14e05d8ce6",
    fingerprintVersion: 4,
    datasetDigest:
        "626f71362046b7d88df9dbb07e2f51fa0e908c78192f74bd837fa88e9ce1d4e6",
    scoringContractDigest:
        "2d4bcb696c2dd87d586ab30bb8308c567b3ef3f57b0b17f6ff99e10de0cc33d4",
    scoringContractVersion: "mem-score-v3.5",
    frozen: MEMORY_EVAL_SUCC9_DATASET_FROZEN,
    manifestDigest:
        "82d9aa48fe96037b7493dae26594a73482d7ba4a915532caffc9be411085f40c",
};

/**
 * Whether the signature is one, and whether it is this dataset's.
 *
 * Two states are legitimate and nothing between them: unsigned, every field
 * null, and signed, all five present with the two digests equal to the pinned
 * record's. A half-filled record — a name with no digests, digests with
 * nobody's name — is the shape that lets an approval be claimed for bytes
 * nobody looked at, so it is refused rather than read as mostly signed.
 *
 * The comparison is against the literal, never against `buildSucc9Manifest()`.
 * A signature compared to a recomputed value agrees with whatever the tree
 * currently says, which is the failure this whole shape exists to prevent.
 */
export function succ9SignatureProblems(
    approval = MEMORY_EVAL_SUCC9_APPROVAL,
    manifest: Succ9DatasetManifest = MEMORY_EVAL_SUCC9_MANIFEST
): readonly string[] {
    const problems: string[] = [];
    const fields = [
        approval.approvedBy,
        approval.approvedAt,
        approval.approvedCommit,
        approval.signedDatasetDigest,
        approval.signedManifestDigest,
    ];
    // Non-empty rather than non-null: an empty string is not half a signature.
    const filled = fields.filter(
        (value) => typeof value === "string" && value.trim() !== ""
    );

    if (filled.length === 0) {
        if (MEMORY_EVAL_SUCC9_DATASET_FROZEN) {
            problems.push(
                "the dataset is frozen and the approval is empty; a freeze is a " +
                    "signature, and there is none here"
            );
        }
        return problems;
    }
    if (filled.length < fields.length) {
        problems.push(
            `the approval is partly filled (${filled.length} of ${fields.length} ` +
                "fields). A signature is all five or none: a name without digests " +
                "approves nothing in particular, and digests without a name are " +
                "not an approval."
        );
        return problems;
    }
    if (!isReviewerHandle(approval.approvedBy)) {
        problems.push(`approvedBy is not a handle: ${approval.approvedBy}`);
    }
    if (!isCalendarDay(approval.approvedAt)) {
        problems.push(
            `approvedAt is not a day that exists: ${JSON.stringify(approval.approvedAt)}`
        );
    }
    if (!/^[0-9a-f]{40}$/.test(approval.approvedCommit ?? "")) {
        problems.push(`approvedCommit is not a full sha: ${approval.approvedCommit}`);
    }
    if (approval.signedDatasetDigest !== manifest.datasetDigest) {
        problems.push(
            "signedDatasetDigest is not the pinned record's: signed " +
                `${approval.signedDatasetDigest}, pinned ${manifest.datasetDigest}`
        );
    }
    if (approval.signedManifestDigest !== manifest.manifestDigest) {
        problems.push(
            "signedManifestDigest is not the pinned record's: signed " +
                `${approval.signedManifestDigest}, pinned ${manifest.manifestDigest}`
        );
    }
    if (!MEMORY_EVAL_SUCC9_DATASET_FROZEN) {
        problems.push(
            "the approval is complete and the dataset is not frozen; a signature " +
                "over a sample that can still change is a signature over nothing"
        );
    }
    return problems;
}

/**
 * The pinned record against itself, then against the tree.
 *
 * Both defaults are load-bearing: `manifest` defaults to the literal and
 * `built` to the builder. succ-6 once passed this shape with the builder on
 * both sides, which compares the tree with itself and proves nothing.
 *
 * The self-hash comes first because comparing two digest *strings* only proves
 * the strings match — the case count, the cell tally, the contract version and
 * the carried transition digest could all be edited with the digest left
 * alone. succ-7 demonstrated exactly that on 2026-09-02 with `caseCount: 999`
 * verifying clean.
 */
export function verifySucc9Manifest(
    manifest: Succ9DatasetManifest = MEMORY_EVAL_SUCC9_MANIFEST,
    built: Succ9DatasetManifest = buildSucc9Manifest()
): readonly string[] {
    const failures: string[] = [];
    const { manifestDigest: recordedDigest, ...recordedFields } = manifest;
    const recomputed = sha256(succ9ManifestFingerprintInput(recordedFields));
    if (recordedDigest !== recomputed) {
        failures.push(
            "the pinned record does not hash to its own manifestDigest: " +
                `records ${recordedDigest}, its fields hash to ${recomputed}`
        );
    }
    for (const field of [
        "datasetDigest",
        "manifestDigest",
        "subtypeDigest",
        "scoringContractDigest",
        "scoringContractVersion",
        "caseCount",
    ] as const) {
        if (manifest[field] !== built[field]) {
            failures.push(
                `${field}: recorded ${String(manifest[field])}, tree computes ` +
                    `${String(built[field])}`
            );
        }
    }
    if (
        manifest.composition.transitionDigest !==
        built.composition.transitionDigest
    ) {
        failures.push(
            "transitionDigest: recorded " +
                `${manifest.composition.transitionDigest}, tree computes ` +
                `${built.composition.transitionDigest}. Which replacement stood ` +
                "in for which original changed, and a case count alone cannot " +
                "show it."
        );
    }
    // Outside the digest by design, so neither check above can see it.
    if (manifest.frozen !== MEMORY_EVAL_SUCC9_DATASET_FROZEN) {
        failures.push(
            `frozen: the record says ${manifest.frozen}, the module declares ` +
                `${MEMORY_EVAL_SUCC9_DATASET_FROZEN}. This field is outside the ` +
                "digest, so nothing else here would have caught it."
        );
    }
    return [
        ...failures,
        ...succ9SignatureProblems(MEMORY_EVAL_SUCC9_APPROVAL, manifest),
        ...succ9Problems(manifest),
    ];
}

/**
 * What has to hold for this to be the successor it says it is.
 *
 * Reported rather than thrown, so the check script prints every problem at
 * once.
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
        // A repair is allowed to differ on the gold axes and on nothing else,
        // and only in one direction: it keeps every gold the original had and
        // adds to them. A repair that dropped a gold, or that changed the
        // category or the conversation, is a rewrite wearing the word.
        const repairing = row.transitionType === "repair";
        if (repairing === (row.repairs === null)) {
            problems.push(
                `${row.replacement} is ${row.transitionType} and ` +
                    (row.repairs === null
                        ? "states no repair"
                        : "states one anyway")
            );
        }
        const goldAxes = new Set(["gold count", "gold shape and anchoring"]);
        for (const [axis, was, now] of boundaryAxes(original, replacement)) {
            if (was === now) continue;
            if (repairing && goldAxes.has(axis)) continue;
            problems.push(
                `${row.replacement} ${axis} is ${now}, where ${row.retired} ` +
                    `was ${was}`
            );
        }
        if (repairing) {
            const kept = new Set(goldDescriptors(replacement));
            const lost = goldDescriptors(original).filter(
                (descriptor) => !kept.has(descriptor)
            );
            if (lost.length > 0) {
                problems.push(
                    `${row.replacement} is a repair that dropped ` +
                        `${lost.join(", ")} from ${row.retired}`
                );
            }
            if (
                (replacement.expected ?? []).length <=
                (original.expected ?? []).length
            ) {
                problems.push(
                    `${row.replacement} is a repair that adds no gold; a ` +
                        `repair that only renames is a same_boundary move`
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
    if (manifest.subtypeDigest !== succ9SubtypeDigest()) {
        problems.push("the manifest's subtype digest is not this tree's");
    }
    if (manifest.datasetDigest === MEMORY_EVAL_SUCC8_MANIFEST.datasetDigest) {
        problems.push(
            "the dataset digest equals succ-8's, so nothing about the sample changed"
        );
    }
    if (MEMORY_EVAL_SUCC9_DATASET_FROZEN && !MEMORY_EVAL_SUCC9_APPROVAL.approvedBy) {
        problems.push("frozen with nobody's name on it");
    }
    // A freeze cannot rest on an AI's reading of the floor.
    //
    // Both `assistant_only` arms sit on 38 of 38, so those three rows decide
    // whether succ-9 meets docs/ops/memory-extraction-eval-dataset.md §3.3 at
    // all — and until this line existed, signing the digest and setting
    // `frozen` passed while `SUCC9_SUBTYPE_REVIEW` still said `ai_draft`. That
    // is the state succ-6 refused to ship in: it moved to `human_confirmed`
    // *before* its manifest was pinned, and the pinning had to wait because
    // confirming moves the digest.
    if (
        MEMORY_EVAL_SUCC9_DATASET_FROZEN &&
        SUCC9_SUBTYPE_REVIEW.status !== "human_confirmed"
    ) {
        problems.push(
            "frozen while the subtype reading is still " +
                `${SUCC9_SUBTYPE_REVIEW.status}; both assistant_only arms sit ` +
                "exactly on the docs/ops/memory-extraction-eval-dataset.md §3.3 " +
                "floor, so those rows are part of what a " +
                "signature covers"
        );
    }
    return problems;
}
