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
import { BATCH_013_DURABLE_KO } from "@/lib/memoryExtractionEvalCandidates/batch013DurableKo";
import { BATCH_014_DURABLE_EN } from "@/lib/memoryExtractionEvalCandidates/batch014DurableEn";
import { BATCH_015_DURABLE_KO } from "@/lib/memoryExtractionEvalCandidates/batch015DurableKo";
import { BATCH_016_DURABLE_EN } from "@/lib/memoryExtractionEvalCandidates/batch016DurableEn";
import { BATCH_017_ASSISTANT_KO } from "@/lib/memoryExtractionEvalCandidates/batch017AssistantKo";
import { BATCH_018_ASSISTANT_EN } from "@/lib/memoryExtractionEvalCandidates/batch018AssistantEn";
import { BATCH_019_ASSISTANT_KO } from "@/lib/memoryExtractionEvalCandidates/batch019AssistantKo";
import { BATCH_020_ASSISTANT_EN } from "@/lib/memoryExtractionEvalCandidates/batch020AssistantEn";
import { BATCH_021_SECRET_KO } from "@/lib/memoryExtractionEvalCandidates/batch021SecretKo";
import { BATCH_022_SECRET_EN } from "@/lib/memoryExtractionEvalCandidates/batch022SecretEn";

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
    {
        id: "batch-013",
        cell: "durable_facts:ko",
        record: "docs/ops/memory-extraction-eval-batches/batch-013-durable-facts-ko.md",
        cases: BATCH_013_DURABLE_KO,
    },
    {
        id: "batch-014",
        cell: "durable_facts:en",
        record: "docs/ops/memory-extraction-eval-batches/batch-014-durable-facts-en.md",
        cases: BATCH_014_DURABLE_EN,
    },
    {
        id: "batch-015",
        cell: "durable_facts:ko",
        record: "docs/ops/memory-extraction-eval-batches/batch-015-durable-facts-ko.md",
        cases: BATCH_015_DURABLE_KO,
    },
    {
        id: "batch-016",
        cell: "durable_facts:en",
        record: "docs/ops/memory-extraction-eval-batches/batch-016-durable-facts-en.md",
        cases: BATCH_016_DURABLE_EN,
    },
    {
        id: "batch-017",
        cell: "assistant_only:ko",
        record: "docs/ops/memory-extraction-eval-batches/batch-017-assistant-only-ko.md",
        cases: BATCH_017_ASSISTANT_KO,
    },
    {
        id: "batch-018",
        cell: "assistant_only:en",
        record: "docs/ops/memory-extraction-eval-batches/batch-018-assistant-only-en.md",
        cases: BATCH_018_ASSISTANT_EN,
    },
    {
        id: "batch-019",
        cell: "assistant_only:ko",
        record: "docs/ops/memory-extraction-eval-batches/batch-019-assistant-only-ko.md",
        cases: BATCH_019_ASSISTANT_KO,
    },
    {
        id: "batch-020",
        cell: "assistant_only:en",
        record: "docs/ops/memory-extraction-eval-batches/batch-020-assistant-only-en.md",
        cases: BATCH_020_ASSISTANT_EN,
    },
    {
        id: "batch-021",
        cell: "sensitive_secrets:ko",
        record: "docs/ops/memory-extraction-eval-batches/batch-021-sensitive-secrets-ko.md",
        cases: BATCH_021_SECRET_KO,
    },
    {
        id: "batch-022",
        cell: "sensitive_secrets:en",
        record: "docs/ops/memory-extraction-eval-batches/batch-022-sensitive-secrets-en.md",
        cases: BATCH_022_SECRET_EN,
    },
];
