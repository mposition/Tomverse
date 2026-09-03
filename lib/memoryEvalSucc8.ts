import { createHash } from "node:crypto";

import { datasetFingerprintInputV4 } from "@/lib/memoryEvalDatasetFingerprintV4";
import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";
import {
    MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    scoringContractDescriptorInput,
} from "@/lib/memoryEvalScoringContractDigest";
import {
    MEMORY_EVAL_SUCC7_CASES,
    MEMORY_EVAL_SUCC7_DATASET_VERSION,
    MEMORY_EVAL_SUCC7_MANIFEST,
    MEMORY_EVAL_SUCC7_SCORING_CONTRACT,
} from "@/lib/memoryEvalSucc7";

/**
 * `mem-eval-succ-8` — succ-7's 1,150 cases under a contract that rewrites
 * Korean numerals from a reviewed expression list instead of a cross-product.
 *
 * ## What this dataset is for
 *
 * Nothing about the sample. Every case, every gold, every anchor is succ-7's,
 * unchanged and not re-reviewed, and the dataset digest is the same value.
 * What changes is the contract it is bound to.
 *
 * `mem-score-v3.4` built the rewrite from every Korean numeral crossed with
 * every counter, so it fired on the last syllable of ordinary words. So
 * `토요일 일정` canonicalised to `토요1일정` and the token `격주토요일` existed in
 * no candidate that phrased it that way: `succ-durable-ko-611` could only
 * score a false negative for three of five plausible phrasings of the fact it
 * tests. `.github/audits/memory-eval-korean-numeral-amendment-2026-09-03.md`
 * has the evidence, the five phrasings, and the two boundary rules that were
 * tried and rejected before the cross-product was replaced by a table.
 *
 * ## Why the contract moved and the gold did not
 *
 * Shortening the gold to `["격주", "일정"]` or `["격주", "토요"]` makes all five
 * phrasings pass, and both were refused: the first drops 토요일, which is the
 * condition being tested, and the second only routes around the defect. A gold
 * adapted to a scorer bug is a gold that has stopped describing the fact.
 *
 * succ-7 is also frozen and signed. Editing a case would move its dataset
 * digest, and re-signing a moved sample under the same `datasetVersion` is
 * what docs/ops/memory-extraction-eval-dataset.md section 7.3 forbids.
 *
 * ## Why a new dataset version rather than a re-binding
 *
 * Because succ-7's manifest is frozen, and frozen has to mean the bytes rather
 * than the intent. Editing its `scoringContractDigest` would leave every
 * artifact resolved against it describing a binding that no longer exists, and
 * would make the freeze revisable — the one property a freeze is for. succ-7
 * stays bound to `mem-score-v3.4` for good; the same cases are scored under
 * v3.5 here.
 *
 * ## What a reader should NOT conclude
 *
 * That the cases were re-reviewed. They were not, and this record says so:
 * `MEMORY_EVAL_SUCC8_APPROVAL.scope` is `contract-only`. The case-level
 * adoption behind these 1,150 cases is succ-7's, signed by `@mposition` on
 * 2026-09-03 and recorded in
 * `.github/audits/memory-eval-succ7-adoption-2026-09-02.md`. It is not
 * restated here — restating it would make a second record of one human act.
 */

const sha256 = (input: string): string =>
    createHash("sha256").update(input, "utf8").digest("hex");

export const MEMORY_EVAL_SUCC8_DATASET_VERSION = "mem-eval-succ-8";
export const MEMORY_EVAL_SUCC8_SUPERSEDES = MEMORY_EVAL_SUCC7_DATASET_VERSION;

/**
 * Why this version exists, as a value rather than as prose.
 *
 * A successor that carries no case change has to say what it *did* change, or
 * the next reader assumes the sample moved and goes looking for the diff.
 */
// The wording is part of `manifestDigest`, so it is the record's identity and
// not a comment: it said "context-free expression table" while the rule read a
// lookbehind, which is a manifest describing a contract the tree does not have.
export const MEMORY_EVAL_SUCC8_CHANGE_REASON =
    "Korean numeral canonicalisation narrowed to a reviewed expression table, " +
    "bounded on the left only";

/**
 * False, pending a signature.
 *
 * A contract-only successor inherits its sample's adoption but not its freeze:
 * what has to be approved here is the contract change and the claim that the
 * cases are carried whole, which is a person's decision like any other.
 * `decideEvalRunMode()` refuses a decision-grade run against an unfrozen
 * sample, which is what should happen until then.
 */
export const MEMORY_EVAL_SUCC8_DATASET_FROZEN = false;

export const MEMORY_EVAL_SUCC8_DATASET_PURPOSE: "development" | "decision" =
    "decision";

/**
 * The cases, by reference and not by copy.
 *
 * A copy would be 1,150 cases that must be kept identical by hand, and the
 * first edit to one of them would silently make two datasets claiming the same
 * digest. Sharing the array makes "the sample is unchanged" true by
 * construction rather than by discipline.
 */
export const MEMORY_EVAL_SUCC8_CASES: readonly MemoryEvalCaseV3[] =
    MEMORY_EVAL_SUCC7_CASES;

/**
 * The human record, in the shape a signature actually takes.
 *
 * The four `signed*` fields are what makes this signable at all, and they are
 * separate from the manifest on purpose: a signature has to be able to
 * **disagree** with the tree. If a reviewer's approval were represented by a
 * boolean beside a recomputed digest, then editing the dataset after signing
 * would move the digest and the approval would follow it silently — which is
 * the one thing a signature exists to prevent. Here the signed values are
 * frozen text, and `succ8SignatureProblems()` fails when they stop matching
 * the pinned record.
 *
 * Null at rest. Signing means filling `approvedBy`, `approvedAt`,
 * `approvedCommit` and the two digests, and flipping
 * `MEMORY_EVAL_SUCC8_DATASET_FROZEN`. Nothing in this file may do that.
 */
export const MEMORY_EVAL_SUCC8_APPROVAL: {
    approvedBy: string | null;
    approvedAt: string | null;
    approvedCommit: string | null;
    signedDatasetDigest: string | null;
    signedManifestDigest: string | null;
    scope: "contract-only";
    record: string;
} = {
    approvedBy: null,
    approvedAt: null,
    approvedCommit: null,
    signedDatasetDigest: null,
    signedManifestDigest: null,
    /**
     * `contract-only` — the cases are inherited whole and were not
     * re-reviewed. Named so that nobody reads this record as a second case
     * adoption, and so a future successor that *does* change cases cannot
     * reuse it.
     */
    scope: "contract-only",
    record: ".github/audits/memory-eval-korean-numeral-amendment-2026-09-03.md",
};

export type Succ8Composition = {
    kind: "contract-correction";
    sourceDatasetVersion: string;
    /** Identical to this dataset's own digest, and checked to be. */
    sourceDatasetDigest: string;
    /**
     * succ-7's pairing digest, carried rather than recomputed.
     *
     * The sample says which cases exist; it cannot say which replacement stood
     * in for which original, and that is what fifty-three of succ-7's verdicts
     * were about. A contract-only successor that dropped it would inherit the
     * cases and lose what a reviewer actually judged.
     */
    sourceTransitionDigest: string;
    /** The contract the source was bound to, preserved as history. */
    supersededScoringContractVersion: string;
    supersededScoringContractDigest: string;
    changeReason: string;
};

export type Succ8DatasetManifest = {
    datasetVersion: "mem-eval-succ-8";
    schemaVersion: 3;
    supersedes: "mem-eval-succ-7";
    composition: Succ8Composition;
    caseCount: number;
    cellCounts: Readonly<Record<string, number>>;
    /** v4, as succ-7 is: the fingerprint covers `conversation.title`. */
    fingerprintVersion: 4;
    /** The same value succ-7 records. Equality is the point, not a coincidence. */
    datasetDigest: string;
    scoringContractDigest: string;
    scoringContractVersion: string;
    /**
     * Lifecycle state, reported but NOT part of `manifestDigest` — as in
     * succ-7, so the digest a reviewer signs is the digest that gets frozen.
     */
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
export function succ8ManifestFingerprintInput(
    manifest: Omit<Succ8DatasetManifest, "manifestDigest">
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
        `sourceTransitionDigest=${manifest.composition.sourceTransitionDigest}`,
        `supersededContractVersion=${manifest.composition.supersededScoringContractVersion}`,
        `supersededContractDigest=${manifest.composition.supersededScoringContractDigest}`,
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
export function buildSucc8Manifest(): Succ8DatasetManifest {
    const datasetDigest = sha256(
        datasetFingerprintInputV4(MEMORY_EVAL_SUCC8_CASES)
    );
    const withoutDigest: Omit<Succ8DatasetManifest, "manifestDigest"> = {
        datasetVersion: "mem-eval-succ-8",
        schemaVersion: 3,
        supersedes: "mem-eval-succ-7",
        composition: {
            kind: "contract-correction",
            sourceDatasetVersion: MEMORY_EVAL_SUCC7_DATASET_VERSION,
            sourceDatasetDigest: datasetDigest,
            sourceTransitionDigest: MEMORY_EVAL_SUCC7_MANIFEST.transitionDigest,
            supersededScoringContractVersion:
                MEMORY_EVAL_SUCC7_SCORING_CONTRACT.version,
            supersededScoringContractDigest:
                MEMORY_EVAL_SUCC7_SCORING_CONTRACT.digest,
            changeReason: MEMORY_EVAL_SUCC8_CHANGE_REASON,
        },
        caseCount: MEMORY_EVAL_SUCC8_CASES.length,
        cellCounts: cellCountsOf(MEMORY_EVAL_SUCC8_CASES),
        fingerprintVersion: 4,
        datasetDigest,
        scoringContractDigest: sha256(scoringContractDescriptorInput()),
        scoringContractVersion: MEMORY_EVAL_SCORING_CONTRACT_VERSION,
        frozen: MEMORY_EVAL_SUCC8_DATASET_FROZEN,
    };
    return {
        ...withoutDigest,
        manifestDigest: sha256(succ8ManifestFingerprintInput(withoutDigest)),
    };
}

/**
 * The two digests the record is built from, named so the literal below reads
 * as a claim rather than a wall of hex.
 *
 * `SUCC8_SCORING_CONTRACT_DIGEST` is `mem-score-v3.5`'s descriptor mixed with
 * this sample's labelling; `SUCC8_MANIFEST_DIGEST` is what a signature would
 * be given for.
 */
const SUCC8_SCORING_CONTRACT_DIGEST =
    "fa32bcfc87aa9203ff05a3e608f01562e3c396ea403b0054226122778fa3cc93";
const SUCC8_MANIFEST_DIGEST =
    "2aa4de5516769c15cb01fea2cfe42c1d8fdd48791832a78d4a5e5420ff6fe7da";

/**
 * The manifest as a **record**, written out.
 *
 * The reason it is a literal and not `buildSucc8Manifest()` is the whole point
 * of a manifest, and this programme has already got it wrong once: succ-6
 * shipped with the builder on both sides of its verifier, so the check
 * compared the tree with itself and would have passed through any edit at all.
 * A signature is given to *these bytes*; if the value a reviewer signs is
 * recomputed at read time, nothing was pinned and the signature covers
 * whatever the tree happens to say today.
 *
 * Every value here is also stated in
 * `.github/audits/memory-eval-korean-numeral-amendment-2026-09-03.md`, so a
 * diff of this constant is a diff of the claim.
 */
export const MEMORY_EVAL_SUCC8_MANIFEST: Succ8DatasetManifest = {
    datasetVersion: "mem-eval-succ-8",
    schemaVersion: 3,
    supersedes: "mem-eval-succ-7",
    composition: {
        kind: "contract-correction",
        sourceDatasetVersion: "mem-eval-succ-7",
        sourceDatasetDigest:
            "9326730a889d99008ca1c5709fcaaa4226f6031c25b9aced7b1fb26e46498251",
        sourceTransitionDigest:
            "36a18e179bb1e5b2e0de79872f7f458696abac0ed1f3ddb3ed14fae7c9241bb1",
        supersededScoringContractVersion: "mem-score-v3.4",
        supersededScoringContractDigest:
            "a62f4bdd8d2073345e19e478541c20d81275a0d11fb78aa6e4df86ec0489b4cd",
        changeReason: MEMORY_EVAL_SUCC8_CHANGE_REASON,
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
    fingerprintVersion: 4,
    datasetDigest:
        "9326730a889d99008ca1c5709fcaaa4226f6031c25b9aced7b1fb26e46498251",
    scoringContractDigest: SUCC8_SCORING_CONTRACT_DIGEST,
    scoringContractVersion: "mem-score-v3.5",
    frozen: MEMORY_EVAL_SUCC8_DATASET_FROZEN,
    manifestDigest: SUCC8_MANIFEST_DIGEST,
};

/**
 * The pinned record against itself, then against the tree.
 *
 * Both directions, and both defaults are load-bearing — `record` defaults to
 * the literal and `built` to the builder. succ-6 once passed this shape with
 * the builder on both sides, which compares the tree with itself and proves
 * nothing.
 *
 * The self-hash is first because comparing two digest *strings* only proves
 * the strings match: every other field of the record — the case count, the
 * cell tally, the contract version, the carried transition digest — could be
 * edited with the digest left alone. succ-7 demonstrated exactly that on
 * 2026-09-02 with `caseCount: 999` verifying clean.
 */
export function verifySucc8Manifest(
    manifest: Succ8DatasetManifest = MEMORY_EVAL_SUCC8_MANIFEST,
    built: Succ8DatasetManifest = buildSucc8Manifest()
): readonly string[] {
    const failures: string[] = [];
    const { manifestDigest: recordedDigest, ...recordedFields } = manifest;
    const recomputed = sha256(succ8ManifestFingerprintInput(recordedFields));
    if (recordedDigest !== recomputed) {
        failures.push(
            "the pinned record does not hash to its own manifestDigest: " +
                `records ${recordedDigest}, its fields hash to ${recomputed}`
        );
    }
    for (const field of [
        "datasetDigest",
        "manifestDigest",
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
        manifest.composition.sourceTransitionDigest !==
        built.composition.sourceTransitionDigest
    ) {
        failures.push(
            "sourceTransitionDigest: recorded " +
                `${manifest.composition.sourceTransitionDigest}, tree computes ` +
                `${built.composition.sourceTransitionDigest}. Which replacement ` +
                "stood in for which original changed, and an inherited case set " +
                "alone cannot show it."
        );
    }
    // Outside the digest by design, so neither check above can see it.
    if (manifest.frozen !== MEMORY_EVAL_SUCC8_DATASET_FROZEN) {
        failures.push(
            `frozen: the record says ${manifest.frozen}, the module declares ` +
                `${MEMORY_EVAL_SUCC8_DATASET_FROZEN}. This field is outside the ` +
                "digest, so nothing else here would have caught it."
        );
    }
    return [...failures, ...succ8Problems(manifest)];
}

/**
 * Everything a contract-only successor can be wrong about.
 *
 * Two invariants and they pull in opposite directions, which is the whole
 * shape of this kind of successor: the sample must NOT have moved, and the
 * contract MUST have. A record failing the first is a case change wearing a
 * contract label; one failing the second changes nothing and should not exist.
 *
 * Defaults to the **pinned record** rather than the builder, for the reason
 * `verifySucc8Manifest` states.
 */
export function succ8Problems(
    manifest: Succ8DatasetManifest = MEMORY_EVAL_SUCC8_MANIFEST
): readonly string[] {
    const problems: string[] = [];
    if (manifest.datasetDigest !== MEMORY_EVAL_SUCC7_MANIFEST.datasetDigest) {
        problems.push(
            `dataset digest differs from ${MEMORY_EVAL_SUCC7_MANIFEST.datasetVersion}: ` +
                `${manifest.datasetDigest} vs ${MEMORY_EVAL_SUCC7_MANIFEST.datasetDigest}. ` +
                "A contract-only successor whose sample moved is not one."
        );
    }
    if (
        manifest.composition.sourceTransitionDigest !==
        MEMORY_EVAL_SUCC7_MANIFEST.transitionDigest
    ) {
        problems.push(
            "the carried transition digest is not succ-7's, so the pairing " +
                "fifty-three verdicts were about is no longer bound"
        );
    }
    if (
        manifest.scoringContractDigest ===
        MEMORY_EVAL_SUCC7_SCORING_CONTRACT.digest
    ) {
        problems.push(
            "the scoring contract digest is identical to the superseded one; a " +
                "contract correction that corrected nothing is not a successor."
        );
    }
    if (manifest.scoringContractVersion === MEMORY_EVAL_SUCC7_SCORING_CONTRACT.version) {
        problems.push(
            `the contract version is still ${MEMORY_EVAL_SUCC7_SCORING_CONTRACT.version}`
        );
    }
    if (MEMORY_EVAL_SUCC8_CASES !== MEMORY_EVAL_SUCC7_CASES) {
        problems.push(
            "the cases are a copy rather than succ-7's array; two datasets that " +
                "agree today can disagree after one edit"
        );
    }
    if (MEMORY_EVAL_SUCC8_DATASET_FROZEN && !MEMORY_EVAL_SUCC8_APPROVAL.approvedBy) {
        problems.push("frozen with nobody's name on it");
    }
    return problems;
}

const HEX_64 = /^[0-9a-f]{64}$/;
const SHA_40 = /^[0-9a-f]{40}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * What a succ-8 signature has to look like to count as one.
 *
 * Two states are legitimate and nothing between them: **unsigned**, with all
 * five fields null, and **signed**, with all five present and the two digests
 * equal to the pinned record's. A half-filled record — a reviewer's name with
 * no digests, or digests with nobody's name — is the shape that lets an
 * approval be claimed for bytes nobody looked at, so it is refused rather than
 * treated as "mostly signed".
 *
 * The digest comparison is against `MEMORY_EVAL_SUCC8_MANIFEST`, the literal,
 * never against `buildSucc8Manifest()`. Comparing a signature to a recomputed
 * value would make it agree with whatever the tree currently says, which is
 * the failure this whole shape exists to prevent.
 */
export function succ8SignatureProblems(
    approval = MEMORY_EVAL_SUCC8_APPROVAL,
    manifest: Succ8DatasetManifest = MEMORY_EVAL_SUCC8_MANIFEST
): readonly string[] {
    const problems: string[] = [];
    const filled = [
        approval.approvedBy,
        approval.approvedAt,
        approval.approvedCommit,
        approval.signedDatasetDigest,
        approval.signedManifestDigest,
    ].filter((value) => value !== null);

    if (filled.length === 0) {
        // Unsigned is a valid state, and the freeze flag is what must agree
        // with it. `succ8Problems()` catches the other direction.
        if (MEMORY_EVAL_SUCC8_DATASET_FROZEN) {
            problems.push(
                "the dataset is frozen and the approval is empty; a freeze is a " +
                    "signature, and there is none here"
            );
        }
        return problems;
    }
    if (filled.length < 5) {
        problems.push(
            `the approval is partly filled (${filled.length} of 5 fields). A ` +
                "signature is all five or none: a name without digests approves " +
                "nothing in particular, and digests without a name are not an " +
                "approval."
        );
        return problems;
    }
    if (!ISO_DAY.test(String(approval.approvedAt))) {
        problems.push(`approvedAt is not an ISO day: ${approval.approvedAt}`);
    }
    if (!SHA_40.test(String(approval.approvedCommit))) {
        problems.push(
            `approvedCommit is not a full commit sha: ${approval.approvedCommit}`
        );
    }
    for (const [field, signed, recorded] of [
        ["datasetDigest", approval.signedDatasetDigest, manifest.datasetDigest],
        ["manifestDigest", approval.signedManifestDigest, manifest.manifestDigest],
    ] as const) {
        if (!HEX_64.test(String(signed))) {
            problems.push(`signed ${field} is not a sha256: ${signed}`);
            continue;
        }
        if (signed !== recorded) {
            problems.push(
                `the signed ${field} is ${signed} and the pinned record says ` +
                    `${recorded}. The tree moved after signing, so the signature ` +
                    "covers bytes this dataset no longer has."
            );
        }
    }
    if (!MEMORY_EVAL_SUCC8_DATASET_FROZEN) {
        problems.push(
            "a full signature is recorded but the dataset is not frozen; the two " +
                "are set together or the record says two different things"
        );
    }
    return problems;
}
