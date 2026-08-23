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
import type { EvalBatch } from "@/lib/memoryEvalBatchRecord";
import { BATCH_009_DURABLE_KO } from "@/lib/memoryExtractionEvalCandidates/batch009DurableKo";
import { BATCH_010_DURABLE_EN } from "@/lib/memoryExtractionEvalCandidates/batch010DurableEn";
import { BATCH_011_DURABLE_KO } from "@/lib/memoryExtractionEvalCandidates/batch011DurableKo";
import { BATCH_012_DURABLE_EN } from "@/lib/memoryExtractionEvalCandidates/batch012DurableEn";

export type CandidateBatch = EvalBatch & { cases: readonly MemoryEvalCase[] };

export const CANDIDATE_BATCHES: readonly CandidateBatch[] = [
    {
        id: "batch-009",
        cell: "durable_facts:ko",
        record: "docs/ops/memory-extraction-eval-batches/batch-009-durable-facts-ko.md",
        cases: BATCH_009_DURABLE_KO,
    },
    {
        id: "batch-010",
        cell: "durable_facts:en",
        record: "docs/ops/memory-extraction-eval-batches/batch-010-durable-facts-en.md",
        cases: BATCH_010_DURABLE_EN,
    },
    {
        id: "batch-011",
        cell: "durable_facts:ko",
        record: "docs/ops/memory-extraction-eval-batches/batch-011-durable-facts-ko.md",
        cases: BATCH_011_DURABLE_KO,
    },
    {
        id: "batch-012",
        cell: "durable_facts:en",
        record: "docs/ops/memory-extraction-eval-batches/batch-012-durable-facts-en.md",
        cases: BATCH_012_DURABLE_EN,
    },
];
