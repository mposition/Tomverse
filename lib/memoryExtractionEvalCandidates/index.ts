/**
 * Batches awaiting human review (docs/ops/memory-extraction-eval-dataset.md §6.2, §6.5).
 *
 * Nothing here is dataset. These are AI drafts, and policy docs/policy/external-conversation-import-and-memory.md §12.6 says an
 * agent's output is a candidate pool until a person adopts it. The barrier is
 * structural: `lib/memoryExtractionEvalFixtures.ts` does not import this
 * directory, so no candidate can be scored, counted toward a cell's floor, or
 * covered by the dataset digest. `tests/memoryEvalCandidateIsolation.test.mjs`
 * fails if that ever stops being true.
 *
 * Adoption moves a batch's file into `lib/memoryExtractionEvalAdopted/` and
 * removes its entry here. That is a file move rather than a flag, because a
 * flag would leave the fixtures file able to import a batch nobody judged.
 *
 * An empty list is a normal state, not an error: it means every drafted batch
 * has been reviewed and the next cell has not been drafted yet.
 */

import type { MemoryEvalCase } from "@/lib/memoryExtractionEvalCore";
import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";
import type { EvalBatch } from "@/lib/memoryEvalBatchRecord";

/**
 * Either schema. The successor batches are schema 2 and the frozen set's are
 * schema 1, and both pass through the same barrier on the way in: what makes
 * a case a candidate is that nothing scores it, which does not depend on
 * which shape it has.
 */
export type CandidateBatch = EvalBatch & {
    cases: readonly (MemoryEvalCase | MemoryEvalCaseV2)[];
    /**
     * The dataset version this batch's cases are meant to *replace*, when it
     * is a rework rather than an addition.
     *
     * A batch drafted for the current dataset blocks that dataset's freeze:
     * a frozen set with an unreviewed batch waiting for it is a set that is
     * not finished. A successor batch is the opposite — it exists because
     * the current set is finished and its scoring contract was superseded,
     * and it will never join it. Counting one as the other made the freeze
     * check report `mem-eval-seed-11` as unfrozen the moment the first
     * successor batch was drafted.
     *
     * Declared here rather than inferred from the cases' schema, so that the
     * claim is a claim somebody wrote.
     */
    successorTo?: string;
};

export const CANDIDATE_BATCHES: readonly CandidateBatch[] = [];
