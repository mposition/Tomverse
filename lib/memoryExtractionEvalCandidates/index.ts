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
import { BATCH_004_ASSISTANT_EN } from "@/lib/memoryExtractionEvalCandidates/batch004AssistantEn";
import { BATCH_005_SECRET_KO } from "@/lib/memoryExtractionEvalCandidates/batch005SecretKo";
import { BATCH_006_SECRET_EN } from "@/lib/memoryExtractionEvalCandidates/batch006SecretEn";
import { BATCH_007_INJECTION_KO } from "@/lib/memoryExtractionEvalCandidates/batch007InjectionKo";
import { BATCH_008_INJECTION_EN } from "@/lib/memoryExtractionEvalCandidates/batch008InjectionEn";

export type CandidateBatch = EvalBatch & { cases: readonly MemoryEvalCase[] };

export const CANDIDATE_BATCHES: readonly CandidateBatch[] = [
    {
        id: "batch-004",
        cell: "assistant_only:en",
        record: "docs/ops/memory-extraction-eval-batches/batch-004-assistant-only-en.md",
        cases: BATCH_004_ASSISTANT_EN,
    },
    {
        id: "batch-005",
        cell: "sensitive_secrets:ko",
        record: "docs/ops/memory-extraction-eval-batches/batch-005-sensitive-secrets-ko.md",
        cases: BATCH_005_SECRET_KO,
    },
    {
        id: "batch-006",
        cell: "sensitive_secrets:en",
        record: "docs/ops/memory-extraction-eval-batches/batch-006-sensitive-secrets-en.md",
        cases: BATCH_006_SECRET_EN,
    },
    {
        id: "batch-007",
        cell: "injection_directives:ko",
        record: "docs/ops/memory-extraction-eval-batches/batch-007-injection-directives-ko.md",
        cases: BATCH_007_INJECTION_KO,
    },
    {
        id: "batch-008",
        cell: "injection_directives:en",
        record: "docs/ops/memory-extraction-eval-batches/batch-008-injection-directives-en.md",
        cases: BATCH_008_INJECTION_EN,
    },
];
