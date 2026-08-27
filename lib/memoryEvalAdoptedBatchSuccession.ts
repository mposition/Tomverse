/**
 * How an adopted batch is superseded without editing what a reviewer signed.
 *
 * `.github/audits/memory-eval-kind-boundary-amendment-2026-08-27.md` moves 99
 * cases out of the decision set: each authored or approved a rule, and a case
 * that wrote a rule cannot also measure it. Those 99 sit inside 25 batches
 * that a person reviewed case by case and adopted, and the review sheet
 * generator refuses to regenerate an adopted record — "its record is settled
 * ... regenerating it would rewrite the document a reviewer signed". That
 * refusal is correct, so the migration goes around it rather than through it.
 *
 * A successor batch is derived, forward-only:
 *
 *   * the original file, its record and its digest are read and never written;
 *   * the successor names the batch it replaces, pins that batch's digest, and
 *     lists the case IDs it drops;
 *   * the survivors are the **same objects**, not copies. There is no
 *     transcription step, so there is nothing for a transcription error to
 *     happen to, and the diff a person reads is the exclusion list rather than
 *     768 restated cases.
 *
 * ## Why this is not the filter the corpus split rejected
 *
 * `lib/memoryEvalRegressionCorpus/index.ts` rejects `purpose: "regression"`
 * because a filter works only while every reader remembers it, and forgetting
 * is silent. The difference here is that the exclusion is **written down in
 * the successor and checked against the provenance record**: the 99 IDs the
 * successors drop must equal the 99 the corpus claims, exactly. A forgotten
 * exclusion is a mismatch, not a quiet reintroduction.
 *
 * Every violation below throws at module load. A batch that names a case it
 * does not contain, or pins a digest that has since moved, cannot be imported
 * at all — which is the difference between a dataset that is wrong and a
 * dataset that will not build.
 */

import { createHash } from "node:crypto";

import {
    datasetFingerprintInput,
    type MemoryEvalCase,
} from "@/lib/memoryExtractionEvalCore";
import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";

/**
 * The pinned identity of an adopted batch, over the same canonical form the
 * dataset digest uses.
 *
 * Typed on schema 1 rather than schema 2 because that is all
 * `datasetFingerprintInput()` reads, and `lib/memoryEvalDatasetManifests.ts`
 * has to take the digest of `mem-eval-seed-11`'s batches too. A second
 * definition for the schema-1 side would be one edit away from disagreeing
 * with this one about what a batch's identity is.
 */
export const adoptedBatchDigest = (
    cases: readonly MemoryEvalCase[]
): string =>
    createHash("sha256")
        .update(datasetFingerprintInput(cases), "utf8")
        .digest("hex");

export type AdoptedBatchSuccessor = {
    /** The successor's own batch id, which the registry lists. */
    id: string;
    /** The adopted batch it stands in for. Never both in the registry. */
    replacesBatchId: string;
    /** The replaced batch's digest at the time this successor was written. */
    sourceDigest: string;
    /** Cases dropped because they authored a rule; every one moves to the corpus. */
    excludedCaseIds: readonly string[];
    /** The survivors, by identity rather than by copy. */
    cases: readonly MemoryEvalCaseV2[];
};

const fail = (id: string, detail: string): never => {
    throw new Error(
        `${id} cannot supersede its batch: ${detail}. ` +
            "The originals are immutable, so this is a mistake in the successor."
    );
};

export function deriveAdoptedBatchSuccessor(input: {
    id: string;
    replacesBatchId: string;
    sourceDigest: string;
    source: readonly MemoryEvalCaseV2[];
    excludedCaseIds: readonly string[];
}): AdoptedBatchSuccessor {
    const { id, replacesBatchId, sourceDigest, source, excludedCaseIds } = input;

    // The digest first. Everything below reads `source`, and reading a batch
    // that has moved since this successor was written would produce a
    // plausible answer about the wrong cases.
    const actual = adoptedBatchDigest(source);
    if (actual !== sourceDigest) {
        // Both digests in full. A truncated pair reads as identical whenever
        // the difference is past the cut, which is most of the time.
        fail(
            id,
            `${replacesBatchId} now digests to\n    ${actual}\n  and this successor pins\n    ${sourceDigest}`
        );
    }

    if (excludedCaseIds.length === 0) {
        // A successor that drops nothing is a second name for the same batch,
        // and the registry check below would then have to choose between two
        // identical entries.
        fail(id, "it excludes nothing, so it supersedes nothing");
    }

    const seen = new Set<string>();
    for (const caseId of excludedCaseIds) {
        if (seen.has(caseId)) fail(id, `${caseId} is excluded twice`);
        seen.add(caseId);
        const occurrences = source.filter(
            (testCase) => testCase.id === caseId
        ).length;
        if (occurrences !== 1) {
            fail(
                id,
                occurrences === 0
                    ? `${caseId} is not in ${replacesBatchId}, so the exclusion is a typo or the case is in another batch`
                    : `${caseId} appears ${occurrences} times in ${replacesBatchId}`
            );
        }
    }

    return {
        id,
        replacesBatchId,
        sourceDigest,
        excludedCaseIds,
        // Identity, not a copy: `filter` returns the originals themselves.
        cases: source.filter((testCase) => !seen.has(testCase.id)),
    };
}
