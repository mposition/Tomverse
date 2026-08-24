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
import { BATCH_006_SECRET_EN } from "@/lib/memoryExtractionEvalAdopted/batch006SecretEn";
import { BATCH_007_INJECTION_KO } from "@/lib/memoryExtractionEvalAdopted/batch007InjectionKo";
import { BATCH_008_INJECTION_EN } from "@/lib/memoryExtractionEvalAdopted/batch008InjectionEn";
import { BATCH_009_DURABLE_KO } from "@/lib/memoryExtractionEvalAdopted/batch009DurableKo";
import { BATCH_010_DURABLE_EN } from "@/lib/memoryExtractionEvalAdopted/batch010DurableEn";
import { BATCH_011_DURABLE_KO } from "@/lib/memoryExtractionEvalAdopted/batch011DurableKo";
import { BATCH_012_DURABLE_EN } from "@/lib/memoryExtractionEvalAdopted/batch012DurableEn";
import { BATCH_013_DURABLE_KO } from "@/lib/memoryExtractionEvalAdopted/batch013DurableKo";
import { BATCH_014_DURABLE_EN } from "@/lib/memoryExtractionEvalAdopted/batch014DurableEn";
import { BATCH_015_DURABLE_KO } from "@/lib/memoryExtractionEvalAdopted/batch015DurableKo";
import { BATCH_016_DURABLE_EN } from "@/lib/memoryExtractionEvalAdopted/batch016DurableEn";
import { BATCH_017_ASSISTANT_KO } from "@/lib/memoryExtractionEvalAdopted/batch017AssistantKo";
import { BATCH_018_ASSISTANT_EN } from "@/lib/memoryExtractionEvalAdopted/batch018AssistantEn";
import { BATCH_019_ASSISTANT_KO } from "@/lib/memoryExtractionEvalAdopted/batch019AssistantKo";
import { BATCH_020_ASSISTANT_EN } from "@/lib/memoryExtractionEvalAdopted/batch020AssistantEn";
import { BATCH_021_SECRET_KO } from "@/lib/memoryExtractionEvalAdopted/batch021SecretKo";
import { BATCH_022_SECRET_EN } from "@/lib/memoryExtractionEvalAdopted/batch022SecretEn";
import { BATCH_023_INJECTION_KO } from "@/lib/memoryExtractionEvalAdopted/batch023InjectionKo";
import { BATCH_024_INJECTION_EN } from "@/lib/memoryExtractionEvalAdopted/batch024InjectionEn";
import { BATCH_025_SECRET_KO } from "@/lib/memoryExtractionEvalAdopted/batch025SecretKo";
import { BATCH_026_SECRET_EN } from "@/lib/memoryExtractionEvalAdopted/batch026SecretEn";
import { BATCH_027_INJECTION_KO } from "@/lib/memoryExtractionEvalAdopted/batch027InjectionKo";
import { BATCH_028_INJECTION_EN } from "@/lib/memoryExtractionEvalAdopted/batch028InjectionEn";

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
    {
        id: "batch-006",
        cell: "sensitive_secrets:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-006-sensitive-secrets-en.md",
        cases: BATCH_006_SECRET_EN,
    },
    {
        id: "batch-007",
        cell: "injection_directives:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-007-injection-directives-ko.md",
        cases: BATCH_007_INJECTION_KO,
    },
    {
        id: "batch-008",
        cell: "injection_directives:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-008-injection-directives-en.md",
        cases: BATCH_008_INJECTION_EN,
    },
    {
        id: "batch-009",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-009-durable-facts-ko.md",
        cases: BATCH_009_DURABLE_KO,
    },
    {
        id: "batch-010",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-010-durable-facts-en.md",
        cases: BATCH_010_DURABLE_EN,
    },
    {
        id: "batch-011",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-011-durable-facts-ko.md",
        cases: BATCH_011_DURABLE_KO,
    },
    {
        id: "batch-012",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-012-durable-facts-en.md",
        cases: BATCH_012_DURABLE_EN,
    },
    {
        id: "batch-013",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-013-durable-facts-ko.md",
        cases: BATCH_013_DURABLE_KO,
    },
    {
        id: "batch-014",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-014-durable-facts-en.md",
        cases: BATCH_014_DURABLE_EN,
    },
    {
        id: "batch-015",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-015-durable-facts-ko.md",
        cases: BATCH_015_DURABLE_KO,
    },
    {
        id: "batch-016",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-016-durable-facts-en.md",
        cases: BATCH_016_DURABLE_EN,
    },
    {
        id: "batch-017",
        cell: "assistant_only:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-017-assistant-only-ko.md",
        cases: BATCH_017_ASSISTANT_KO,
    },
    {
        id: "batch-018",
        cell: "assistant_only:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-018-assistant-only-en.md",
        cases: BATCH_018_ASSISTANT_EN,
    },
    {
        id: "batch-019",
        cell: "assistant_only:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-019-assistant-only-ko.md",
        cases: BATCH_019_ASSISTANT_KO,
    },
    {
        id: "batch-020",
        cell: "assistant_only:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-020-assistant-only-en.md",
        cases: BATCH_020_ASSISTANT_EN,
    },
    {
        id: "batch-021",
        cell: "sensitive_secrets:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-021-sensitive-secrets-ko.md",
        cases: BATCH_021_SECRET_KO,
    },
    {
        id: "batch-022",
        cell: "sensitive_secrets:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-022-sensitive-secrets-en.md",
        cases: BATCH_022_SECRET_EN,
    },
    {
        id: "batch-023",
        cell: "injection_directives:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-023-injection-directives-ko.md",
        cases: BATCH_023_INJECTION_KO,
    },
    {
        id: "batch-024",
        cell: "injection_directives:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-024-injection-directives-en.md",
        cases: BATCH_024_INJECTION_EN,
    },
    {
        id: "batch-025",
        cell: "sensitive_secrets:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-025-sensitive-secrets-ko.md",
        cases: BATCH_025_SECRET_KO,
    },
    {
        id: "batch-026",
        cell: "sensitive_secrets:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-026-sensitive-secrets-en.md",
        cases: BATCH_026_SECRET_EN,
    },
    {
        id: "batch-027",
        cell: "injection_directives:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-027-injection-directives-ko.md",
        cases: BATCH_027_INJECTION_KO,
    },
    {
        id: "batch-028",
        cell: "injection_directives:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-028-injection-directives-en.md",
        cases: BATCH_028_INJECTION_EN,
    },
];
