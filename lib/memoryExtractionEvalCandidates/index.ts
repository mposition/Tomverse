/**
 * Candidate batches awaiting human review
 * (docs/ops/memory-extraction-eval-dataset.md §6.2, §6.5).
 *
 * Nothing here is dataset. These are AI drafts, and policy docs/policy/external-conversation-import-and-memory.md §12.6 says an
 * agent's output is a candidate pool until a person adopts it. The barrier is
 * structural: `lib/memoryExtractionEvalFixtures.ts` does not import this file,
 * so no candidate can be scored, counted toward a cell's floor, or covered by
 * the dataset digest. `tests/memoryEvalCandidateIsolation.test.mjs` fails if
 * that ever stops being true.
 */

import type { MemoryEvalCase } from "@/lib/memoryExtractionEvalCore";
import { BATCH_001_DURABLE_KO } from "@/lib/memoryExtractionEvalCandidates/batch001DurableKo";

export type CandidateBatch = {
    /** Batch number, matching its record in docs/ops/memory-extraction-eval-batches/. */
    id: string;
    cell: string;
    /** The record file a reviewer writes their verdicts into. */
    record: string;
    cases: readonly MemoryEvalCase[];
};

export const CANDIDATE_BATCHES: readonly CandidateBatch[] = [
    {
        id: "batch-001",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-001-durable-facts-ko.md",
        cases: BATCH_001_DURABLE_KO,
    },
];
