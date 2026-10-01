/**
 * The successor dataset's adopted batches (`docs/ops/memory-extraction-eval-dataset.md` §6.3, §7.1).
 *
 * Separate from `lib/memoryExtractionEvalAdopted/` on purpose, and the reason
 * is a type rather than tidiness. That registry is declared
 * `readonly MemoryEvalCase[]` — schema 1 — and it is what
 * `lib/memoryExtractionEvalFixtures.ts` spreads into `mem-eval-seed-11`.
 * Widening it to admit schema-2 cases would put them into a **frozen**
 * dataset, which
 * `.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md` §6
 * forbids outright: the frozen set is preserved as diagnostic only, and the
 * rework becomes a new `datasetVersion` rather than an edit of the old one.
 *
 * So the two sets have two registries, two case types and two version
 * strings, and nothing can leak between them by accident.
 *
 * All 32 batches were reviewed and adopted on 2026-08-26 by @mposition. The
 * records listed here carry the verdicts, and
 * `tests/memoryEvalSuccessorAdoptedBatches.test.mjs` re-reads each one on
 * every run: if an adoption line stops saying 채택, those cases stop being
 * allowed.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";
import type { EvalBatch } from "@/lib/memoryEvalBatchRecord";
import { BATCH_101_DURABLE_KO } from "@/lib/memoryEvalSuccessorAdopted/batch101DurableKo";
import { BATCH_102_DURABLE_EN } from "@/lib/memoryEvalSuccessorAdopted/batch102DurableEn";
import { BATCH_103_DURABLE_KO } from "@/lib/memoryEvalSuccessorAdopted/batch103DurableKo";
import { BATCH_104_DURABLE_KO } from "@/lib/memoryEvalSuccessorAdopted/batch104DurableKo";
import { BATCH_105_DURABLE_EN } from "@/lib/memoryEvalSuccessorAdopted/batch105DurableEn";
import { BATCH_106_DURABLE_EN } from "@/lib/memoryEvalSuccessorAdopted/batch106DurableEn";
import { BATCH_107_DURABLE_KO } from "@/lib/memoryEvalSuccessorAdopted/batch107DurableKo";
import { BATCH_108_DURABLE_KO } from "@/lib/memoryEvalSuccessorAdopted/batch108DurableKo";
import { BATCH_109_DURABLE_EN } from "@/lib/memoryEvalSuccessorAdopted/batch109DurableEn";
import { BATCH_110_DURABLE_EN } from "@/lib/memoryEvalSuccessorAdopted/batch110DurableEn";
import { BATCH_111_DURABLE_KO } from "@/lib/memoryEvalSuccessorAdopted/batch111DurableKo";
import { BATCH_112_DURABLE_EN } from "@/lib/memoryEvalSuccessorAdopted/batch112DurableEn";
import { BATCH_113_DURABLE_KO } from "@/lib/memoryEvalSuccessorAdopted/batch113DurableKo";
import { BATCH_114_DURABLE_EN } from "@/lib/memoryEvalSuccessorAdopted/batch114DurableEn";
import { BATCH_115_INJECTION_KO } from "@/lib/memoryEvalSuccessorAdopted/batch115InjectionKo";
import { BATCH_116_INJECTION_KO } from "@/lib/memoryEvalSuccessorAdopted/batch116InjectionKo";
import { BATCH_117_INJECTION_KO } from "@/lib/memoryEvalSuccessorAdopted/batch117InjectionKo";
import { BATCH_118_INJECTION_EN } from "@/lib/memoryEvalSuccessorAdopted/batch118InjectionEn";
import { BATCH_119_INJECTION_EN } from "@/lib/memoryEvalSuccessorAdopted/batch119InjectionEn";
import { BATCH_120_INJECTION_EN } from "@/lib/memoryEvalSuccessorAdopted/batch120InjectionEn";
import { BATCH_121_ASSISTANT_KO } from "@/lib/memoryEvalSuccessorAdopted/batch121AssistantKo";
import { BATCH_122_ASSISTANT_KO } from "@/lib/memoryEvalSuccessorAdopted/batch122AssistantKo";
import { BATCH_123_ASSISTANT_KO } from "@/lib/memoryEvalSuccessorAdopted/batch123AssistantKo";
import { BATCH_124_ASSISTANT_EN } from "@/lib/memoryEvalSuccessorAdopted/batch124AssistantEn";
import { BATCH_125_ASSISTANT_EN } from "@/lib/memoryEvalSuccessorAdopted/batch125AssistantEn";
import { BATCH_126_ASSISTANT_EN } from "@/lib/memoryEvalSuccessorAdopted/batch126AssistantEn";
import { BATCH_127_SECRET_KO } from "@/lib/memoryEvalSuccessorAdopted/batch127SecretKo";
import { BATCH_128_SECRET_KO } from "@/lib/memoryEvalSuccessorAdopted/batch128SecretKo";
import { BATCH_129_SECRET_KO } from "@/lib/memoryEvalSuccessorAdopted/batch129SecretKo";
import { BATCH_130_SECRET_EN } from "@/lib/memoryEvalSuccessorAdopted/batch130SecretEn";
import { BATCH_131_SECRET_EN } from "@/lib/memoryEvalSuccessorAdopted/batch131SecretEn";
import { BATCH_132_SECRET_EN } from "@/lib/memoryEvalSuccessorAdopted/batch132SecretEn";

export type SuccessorAdoptedBatch = EvalBatch & {
    cases: readonly MemoryEvalCaseV2[];
};

export const SUCCESSOR_ADOPTED_BATCHES: readonly SuccessorAdoptedBatch[] = [
    {
        id: "batch-101",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-101-successor-durable-ko.md",
        cases: BATCH_101_DURABLE_KO,
    },
    {
        id: "batch-102",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-102-successor-durable-en.md",
        cases: BATCH_102_DURABLE_EN,
    },
    {
        id: "batch-103",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-103-successor-durable-ko.md",
        cases: BATCH_103_DURABLE_KO,
    },
    {
        id: "batch-104",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-104-successor-durable-ko.md",
        cases: BATCH_104_DURABLE_KO,
    },
    {
        id: "batch-105",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-105-successor-durable-en.md",
        cases: BATCH_105_DURABLE_EN,
    },
    {
        id: "batch-106",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-106-successor-durable-en.md",
        cases: BATCH_106_DURABLE_EN,
    },
    {
        id: "batch-107",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-107-successor-durable-ko.md",
        cases: BATCH_107_DURABLE_KO,
    },
    {
        id: "batch-108",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-108-successor-durable-ko.md",
        cases: BATCH_108_DURABLE_KO,
    },
    {
        id: "batch-109",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-109-successor-durable-en.md",
        cases: BATCH_109_DURABLE_EN,
    },
    {
        id: "batch-110",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-110-successor-durable-en.md",
        cases: BATCH_110_DURABLE_EN,
    },
    {
        id: "batch-111",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-111-successor-durable-ko.md",
        cases: BATCH_111_DURABLE_KO,
    },
    {
        id: "batch-112",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-112-successor-durable-en.md",
        cases: BATCH_112_DURABLE_EN,
    },
    {
        id: "batch-113",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-113-successor-durable-ko.md",
        cases: BATCH_113_DURABLE_KO,
    },
    {
        id: "batch-114",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-114-successor-durable-en.md",
        cases: BATCH_114_DURABLE_EN,
    },
    {
        id: "batch-115",
        cell: "injection_directives:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-115-successor-injection-ko.md",
        cases: BATCH_115_INJECTION_KO,
    },
    {
        id: "batch-116",
        cell: "injection_directives:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-116-successor-injection-ko.md",
        cases: BATCH_116_INJECTION_KO,
    },
    {
        id: "batch-117",
        cell: "injection_directives:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-117-successor-injection-ko.md",
        cases: BATCH_117_INJECTION_KO,
    },
    {
        id: "batch-118",
        cell: "injection_directives:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-118-successor-injection-en.md",
        cases: BATCH_118_INJECTION_EN,
    },
    {
        id: "batch-119",
        cell: "injection_directives:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-119-successor-injection-en.md",
        cases: BATCH_119_INJECTION_EN,
    },
    {
        id: "batch-120",
        cell: "injection_directives:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-120-successor-injection-en.md",
        cases: BATCH_120_INJECTION_EN,
    },
    {
        id: "batch-121",
        cell: "assistant_only:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-121-successor-assistant-ko.md",
        cases: BATCH_121_ASSISTANT_KO,
    },
    {
        id: "batch-122",
        cell: "assistant_only:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-122-successor-assistant-ko.md",
        cases: BATCH_122_ASSISTANT_KO,
    },
    {
        id: "batch-123",
        cell: "assistant_only:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-123-successor-assistant-ko.md",
        cases: BATCH_123_ASSISTANT_KO,
    },
    {
        id: "batch-124",
        cell: "assistant_only:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-124-successor-assistant-en.md",
        cases: BATCH_124_ASSISTANT_EN,
    },
    {
        id: "batch-125",
        cell: "assistant_only:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-125-successor-assistant-en.md",
        cases: BATCH_125_ASSISTANT_EN,
    },
    {
        id: "batch-126",
        cell: "assistant_only:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-126-successor-assistant-en.md",
        cases: BATCH_126_ASSISTANT_EN,
    },
    {
        id: "batch-127",
        cell: "sensitive_secrets:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-127-successor-secret-ko.md",
        cases: BATCH_127_SECRET_KO,
    },
    {
        id: "batch-128",
        cell: "sensitive_secrets:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-128-successor-secret-ko.md",
        cases: BATCH_128_SECRET_KO,
    },
    {
        id: "batch-129",
        cell: "sensitive_secrets:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-129-successor-secret-ko.md",
        cases: BATCH_129_SECRET_KO,
    },
    {
        id: "batch-130",
        cell: "sensitive_secrets:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-130-successor-secret-en.md",
        cases: BATCH_130_SECRET_EN,
    },
    {
        id: "batch-131",
        cell: "sensitive_secrets:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-131-successor-secret-en.md",
        cases: BATCH_131_SECRET_EN,
    },
    {
        id: "batch-132",
        cell: "sensitive_secrets:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-132-successor-secret-en.md",
        cases: BATCH_132_SECRET_EN,
    },
];
