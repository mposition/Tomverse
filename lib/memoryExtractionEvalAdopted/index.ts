/**
 * Batches a person reviewed and adopted (docs/ops/memory-extraction-eval-dataset.md §6.3, §7.1).
 *
 * The registry exists so adoption stays checkable after the fact. A batch
 * that has moved here is imported by `lib/memoryExtractionEvalFixtures.ts`
 * and is therefore scored, counted toward its cell's floor, and covered by
 * the dataset digest -- so "who admitted these cases, and on what record"
 * has to remain answerable, not become a fact about a past commit.
 *
 * `tests/memoryEvalAdoptedBatches.test.mjs` re-reads every record listed here
 * on each run and fails if one of them no longer carries the explicit
 * adoption line docs/ops/memory-extraction-eval-dataset.md §6.3 requires.
 */

import type { MemoryEvalCase } from "@/lib/memoryExtractionEvalCore";
import type { EvalBatch } from "@/lib/memoryEvalBatchRecord";
import { BATCH_001_DURABLE_KO } from "@/lib/memoryExtractionEvalAdopted/batch001DurableKo";
import { BATCH_002_DURABLE_EN } from "@/lib/memoryExtractionEvalAdopted/batch002DurableEn";
import { BATCH_003_ASSISTANT_KO } from "@/lib/memoryExtractionEvalAdopted/batch003AssistantKo";
import { BATCH_004_ASSISTANT_EN } from "@/lib/memoryExtractionEvalAdopted/batch004AssistantEn";
import { BATCH_005_SECRET_KO } from "@/lib/memoryExtractionEvalAdopted/batch005SecretKo";

export type AdoptedBatch = EvalBatch & { cases: readonly MemoryEvalCase[] };

export const ADOPTED_BATCHES: readonly AdoptedBatch[] = [
    {
        id: "batch-001",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-001-durable-facts-ko.md",
        cases: BATCH_001_DURABLE_KO,
    },
    {
        id: "batch-002",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-002-durable-facts-en.md",
        cases: BATCH_002_DURABLE_EN,
    },
    {
        id: "batch-003",
        cell: "assistant_only:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-003-assistant-only-ko.md",
        cases: BATCH_003_ASSISTANT_KO,
    },
    {
        id: "batch-004",
        cell: "assistant_only:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-004-assistant-only-en.md",
        cases: BATCH_004_ASSISTANT_EN,
    },
    {
        id: "batch-005",
        cell: "sensitive_secrets:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-005-sensitive-secrets-ko.md",
        cases: BATCH_005_SECRET_KO,
    },
];
