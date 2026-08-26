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
import { BATCH_101_DURABLE_KO } from "@/lib/memoryExtractionEvalCandidates/batch101DurableKo";
import { BATCH_102_DURABLE_EN } from "@/lib/memoryExtractionEvalCandidates/batch102DurableEn";
import { BATCH_103_DURABLE_KO } from "@/lib/memoryExtractionEvalCandidates/batch103DurableKo";
import { BATCH_104_DURABLE_KO } from "@/lib/memoryExtractionEvalCandidates/batch104DurableKo";
import { BATCH_105_DURABLE_EN } from "@/lib/memoryExtractionEvalCandidates/batch105DurableEn";
import { BATCH_106_DURABLE_EN } from "@/lib/memoryExtractionEvalCandidates/batch106DurableEn";
import { BATCH_107_DURABLE_KO } from "@/lib/memoryExtractionEvalCandidates/batch107DurableKo";
import { BATCH_108_DURABLE_KO } from "@/lib/memoryExtractionEvalCandidates/batch108DurableKo";
import { BATCH_109_DURABLE_EN } from "@/lib/memoryExtractionEvalCandidates/batch109DurableEn";
import { BATCH_110_DURABLE_EN } from "@/lib/memoryExtractionEvalCandidates/batch110DurableEn";
import { BATCH_111_DURABLE_KO } from "@/lib/memoryExtractionEvalCandidates/batch111DurableKo";
import { BATCH_112_DURABLE_EN } from "@/lib/memoryExtractionEvalCandidates/batch112DurableEn";
import { BATCH_113_DURABLE_KO } from "@/lib/memoryExtractionEvalCandidates/batch113DurableKo";
import { BATCH_114_DURABLE_EN } from "@/lib/memoryExtractionEvalCandidates/batch114DurableEn";
import { BATCH_115_INJECTION_KO } from "@/lib/memoryExtractionEvalCandidates/batch115InjectionKo";
import { BATCH_116_INJECTION_KO } from "@/lib/memoryExtractionEvalCandidates/batch116InjectionKo";
import { BATCH_117_INJECTION_KO } from "@/lib/memoryExtractionEvalCandidates/batch117InjectionKo";
import { BATCH_118_INJECTION_EN } from "@/lib/memoryExtractionEvalCandidates/batch118InjectionEn";
import { BATCH_119_INJECTION_EN } from "@/lib/memoryExtractionEvalCandidates/batch119InjectionEn";
import { BATCH_120_INJECTION_EN } from "@/lib/memoryExtractionEvalCandidates/batch120InjectionEn";
import { BATCH_121_ASSISTANT_KO } from "@/lib/memoryExtractionEvalCandidates/batch121AssistantKo";
import { BATCH_122_ASSISTANT_KO } from "@/lib/memoryExtractionEvalCandidates/batch122AssistantKo";
import { BATCH_123_ASSISTANT_KO } from "@/lib/memoryExtractionEvalCandidates/batch123AssistantKo";
import { BATCH_124_ASSISTANT_EN } from "@/lib/memoryExtractionEvalCandidates/batch124AssistantEn";
import { BATCH_125_ASSISTANT_EN } from "@/lib/memoryExtractionEvalCandidates/batch125AssistantEn";
import { BATCH_126_ASSISTANT_EN } from "@/lib/memoryExtractionEvalCandidates/batch126AssistantEn";

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

export const CANDIDATE_BATCHES: readonly CandidateBatch[] = [
    {
        id: "batch-101",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-101-successor-durable-ko.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_101_DURABLE_KO,
    },
    {
        id: "batch-102",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-102-successor-durable-en.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_102_DURABLE_EN,
    },
    {
        id: "batch-103",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-103-successor-durable-ko.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_103_DURABLE_KO,
    },
    {
        id: "batch-104",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-104-successor-durable-ko.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_104_DURABLE_KO,
    },
    {
        id: "batch-105",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-105-successor-durable-en.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_105_DURABLE_EN,
    },
    {
        id: "batch-106",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-106-successor-durable-en.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_106_DURABLE_EN,
    },
    {
        id: "batch-107",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-107-successor-durable-ko.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_107_DURABLE_KO,
    },
    {
        id: "batch-108",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-108-successor-durable-ko.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_108_DURABLE_KO,
    },
    {
        id: "batch-109",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-109-successor-durable-en.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_109_DURABLE_EN,
    },
    {
        id: "batch-110",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-110-successor-durable-en.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_110_DURABLE_EN,
    },
    {
        id: "batch-111",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-111-successor-durable-ko.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_111_DURABLE_KO,
    },
    {
        id: "batch-112",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-112-successor-durable-en.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_112_DURABLE_EN,
    },
    {
        id: "batch-113",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-113-successor-durable-ko.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_113_DURABLE_KO,
    },
    {
        id: "batch-114",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-114-successor-durable-en.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_114_DURABLE_EN,
    },
    {
        id: "batch-115",
        cell: "injection_directives:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-115-successor-injection-ko.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_115_INJECTION_KO,
    },
    {
        id: "batch-116",
        cell: "injection_directives:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-116-successor-injection-ko.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_116_INJECTION_KO,
    },
    {
        id: "batch-117",
        cell: "injection_directives:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-117-successor-injection-ko.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_117_INJECTION_KO,
    },
    {
        id: "batch-118",
        cell: "injection_directives:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-118-successor-injection-en.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_118_INJECTION_EN,
    },
    {
        id: "batch-119",
        cell: "injection_directives:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-119-successor-injection-en.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_119_INJECTION_EN,
    },
    {
        id: "batch-120",
        cell: "injection_directives:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-120-successor-injection-en.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_120_INJECTION_EN,
    },
    {
        id: "batch-121",
        cell: "assistant_only:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-121-successor-assistant-ko.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_121_ASSISTANT_KO,
    },
    {
        id: "batch-122",
        cell: "assistant_only:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-122-successor-assistant-ko.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_122_ASSISTANT_KO,
    },
    {
        id: "batch-123",
        cell: "assistant_only:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_123_ASSISTANT_KO,
    },
    {
        id: "batch-124",
        cell: "assistant_only:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-124-successor-assistant-en.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_124_ASSISTANT_EN,
    },
    {
        id: "batch-125",
        cell: "assistant_only:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-125-successor-assistant-en.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_125_ASSISTANT_EN,
    },
    {
        id: "batch-126",
        cell: "assistant_only:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-126-successor-assistant-en.md",
        successorTo: "mem-eval-seed-11",
        cases: BATCH_126_ASSISTANT_EN,
    },
];
