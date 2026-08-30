/**
 * `mem-eval-succ-3`'s adopted batches — a third registry, not an edit of the
 * second.
 *
 * `lib/memoryEvalSuccessorAdopted/` stays exactly as it was and keeps holding
 * `mem-eval-succ-2`. That is the whole construction: run1's verdict was
 * computed against succ-2, and a superseded dataset that is quietly
 * reassembled underneath its own manifest takes every artifact scored against
 * it with it. The same reasoning that gave schema 1 and schema 2 two
 * registries applies again here, for a different reason — not incompatible
 * types this time, but an immutable record.
 *
 * ## Forty batches, three provenances
 *
 *   * **7 unchanged** — no case in them authored a rule, so they are the same
 *     objects, under their original ids, pointing at their original records.
 *     Re-adopting them would claim a review that did not happen.
 *   * **25 successors** (137–161) — the batches that held a rule-authoring
 *     case, minus that case. Derived rather than rewritten: every survivor is
 *     the object the source batch already held.
 *   * **8 replacements** (133–136, 162–165) — 99 new cases, one batch per
 *     cell, taking the place of the 99 that left for
 *     `lib/memoryEvalRegressionCorpus/`.
 *
 * A batch appears here as either the original or its successor, never both.
 * `tests/memoryEvalSucc3AdoptedBatches.test.mjs` checks that, and checks that
 * the 40 records still say 채택 — an adoption withdrawn tomorrow stops these
 * cases the same day.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";
import type { EvalBatch } from "@/lib/memoryEvalBatchRecord";
import { BATCH_102_DURABLE_EN } from "@/lib/memoryEvalSuccessorAdopted/batch102DurableEn";
import { BATCH_116_INJECTION_KO } from "@/lib/memoryEvalSuccessorAdopted/batch116InjectionKo";
import { BATCH_119_INJECTION_EN } from "@/lib/memoryEvalSuccessorAdopted/batch119InjectionEn";
import { BATCH_127_SECRET_KO } from "@/lib/memoryEvalSuccessorAdopted/batch127SecretKo";
import { BATCH_128_SECRET_KO } from "@/lib/memoryEvalSuccessorAdopted/batch128SecretKo";
import { BATCH_130_SECRET_EN } from "@/lib/memoryEvalSuccessorAdopted/batch130SecretEn";
import { BATCH_131_SECRET_EN } from "@/lib/memoryEvalSuccessorAdopted/batch131SecretEn";
import { BATCH_133_INJECTION_KO } from "@/lib/memoryEvalSuccessorAdopted/batch133InjectionKo";
import { BATCH_134_INJECTION_EN } from "@/lib/memoryEvalSuccessorAdopted/batch134InjectionEn";
import { BATCH_135_SECRET_KO } from "@/lib/memoryEvalSuccessorAdopted/batch135SecretKo";
import { BATCH_136_SECRET_EN } from "@/lib/memoryEvalSuccessorAdopted/batch136SecretEn";
import { BATCH_162_DURABLE_KO } from "@/lib/memoryEvalSuccessorAdopted/batch162DurableKo";
import { BATCH_163_DURABLE_EN } from "@/lib/memoryEvalSuccessorAdopted/batch163DurableEn";
import { BATCH_164_ASSISTANT_KO } from "@/lib/memoryEvalSuccessorAdopted/batch164AssistantKo";
import { BATCH_165_ASSISTANT_EN } from "@/lib/memoryEvalSuccessorAdopted/batch165AssistantEn";
import {
    BATCH_137_INJECTION_KO,
    BATCH_138_INJECTION_KO,
    BATCH_139_INJECTION_EN,
    BATCH_140_INJECTION_EN,
    BATCH_141_SECRET_KO,
    BATCH_142_SECRET_EN,
} from "@/lib/memoryEvalSuccessorAdopted/tranche1Successors";
import {
    BATCH_143_DURABLE_KO,
    BATCH_144_DURABLE_KO,
    BATCH_145_DURABLE_KO,
    BATCH_146_DURABLE_EN,
    BATCH_147_DURABLE_EN,
    BATCH_148_DURABLE_KO,
    BATCH_149_DURABLE_KO,
    BATCH_150_DURABLE_EN,
    BATCH_151_DURABLE_EN,
    BATCH_152_DURABLE_KO,
    BATCH_153_DURABLE_EN,
    BATCH_154_DURABLE_KO,
    BATCH_155_DURABLE_EN,
    BATCH_156_ASSISTANT_KO,
    BATCH_157_ASSISTANT_KO,
    BATCH_158_ASSISTANT_KO,
    BATCH_159_ASSISTANT_EN,
    BATCH_160_ASSISTANT_EN,
    BATCH_161_ASSISTANT_EN,
} from "@/lib/memoryEvalSuccessorAdopted/tranche2Successors";

export type Succ3AdoptedBatch = EvalBatch & {
    cases: readonly MemoryEvalCaseV2[];
};

export const SUCC3_ADOPTED_BATCHES: readonly Succ3AdoptedBatch[] = [

    {
        id: "batch-143",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-143-succ3-durable-ko.md",
        cases: BATCH_143_DURABLE_KO.cases,
    },
    {
        id: "batch-102",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-102-successor-durable-en.md",
        cases: BATCH_102_DURABLE_EN,
    },
    {
        id: "batch-144",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-144-succ3-durable-ko.md",
        cases: BATCH_144_DURABLE_KO.cases,
    },
    {
        id: "batch-145",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-145-succ3-durable-ko.md",
        cases: BATCH_145_DURABLE_KO.cases,
    },
    {
        id: "batch-146",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-146-succ3-durable-en.md",
        cases: BATCH_146_DURABLE_EN.cases,
    },
    {
        id: "batch-147",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-147-succ3-durable-en.md",
        cases: BATCH_147_DURABLE_EN.cases,
    },
    {
        id: "batch-148",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-148-succ3-durable-ko.md",
        cases: BATCH_148_DURABLE_KO.cases,
    },
    {
        id: "batch-149",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-149-succ3-durable-ko.md",
        cases: BATCH_149_DURABLE_KO.cases,
    },
    {
        id: "batch-150",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-150-succ3-durable-en.md",
        cases: BATCH_150_DURABLE_EN.cases,
    },
    {
        id: "batch-151",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-151-succ3-durable-en.md",
        cases: BATCH_151_DURABLE_EN.cases,
    },
    {
        id: "batch-152",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-152-succ3-durable-ko.md",
        cases: BATCH_152_DURABLE_KO.cases,
    },
    {
        id: "batch-153",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-153-succ3-durable-en.md",
        cases: BATCH_153_DURABLE_EN.cases,
    },
    {
        id: "batch-154",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-154-succ3-durable-ko.md",
        cases: BATCH_154_DURABLE_KO.cases,
    },
    {
        id: "batch-155",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-155-succ3-durable-en.md",
        cases: BATCH_155_DURABLE_EN.cases,
    },
    {
        id: "batch-137",
        cell: "injection_directives:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-137-succ3-injection-ko.md",
        cases: BATCH_137_INJECTION_KO.cases,
    },
    {
        id: "batch-116",
        cell: "injection_directives:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-116-successor-injection-ko.md",
        cases: BATCH_116_INJECTION_KO,
    },
    {
        id: "batch-138",
        cell: "injection_directives:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-138-succ3-injection-ko.md",
        cases: BATCH_138_INJECTION_KO.cases,
    },
    {
        id: "batch-139",
        cell: "injection_directives:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-139-succ3-injection-en.md",
        cases: BATCH_139_INJECTION_EN.cases,
    },
    {
        id: "batch-119",
        cell: "injection_directives:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-119-successor-injection-en.md",
        cases: BATCH_119_INJECTION_EN,
    },
    {
        id: "batch-140",
        cell: "injection_directives:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-140-succ3-injection-en.md",
        cases: BATCH_140_INJECTION_EN.cases,
    },
    {
        id: "batch-156",
        cell: "assistant_only:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-156-succ3-assistant-ko.md",
        cases: BATCH_156_ASSISTANT_KO.cases,
    },
    {
        id: "batch-157",
        cell: "assistant_only:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-157-succ3-assistant-ko.md",
        cases: BATCH_157_ASSISTANT_KO.cases,
    },
    {
        id: "batch-158",
        cell: "assistant_only:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-158-succ3-assistant-ko.md",
        cases: BATCH_158_ASSISTANT_KO.cases,
    },
    {
        id: "batch-159",
        cell: "assistant_only:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-159-succ3-assistant-en.md",
        cases: BATCH_159_ASSISTANT_EN.cases,
    },
    {
        id: "batch-160",
        cell: "assistant_only:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-160-succ3-assistant-en.md",
        cases: BATCH_160_ASSISTANT_EN.cases,
    },
    {
        id: "batch-161",
        cell: "assistant_only:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-161-succ3-assistant-en.md",
        cases: BATCH_161_ASSISTANT_EN.cases,
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
        id: "batch-141",
        cell: "sensitive_secrets:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-141-succ3-secret-ko.md",
        cases: BATCH_141_SECRET_KO.cases,
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
        id: "batch-142",
        cell: "sensitive_secrets:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-142-succ3-secret-en.md",
        cases: BATCH_142_SECRET_EN.cases,
    },
    {
        id: "batch-133",
        cell: "injection_directives:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-133-succ3-injection-ko.md",
        cases: BATCH_133_INJECTION_KO,
    },
    {
        id: "batch-134",
        cell: "injection_directives:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-134-succ3-injection-en.md",
        cases: BATCH_134_INJECTION_EN,
    },
    {
        id: "batch-135",
        cell: "sensitive_secrets:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-135-succ3-secret-ko.md",
        cases: BATCH_135_SECRET_KO,
    },
    {
        id: "batch-136",
        cell: "sensitive_secrets:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-136-succ3-secret-en.md",
        cases: BATCH_136_SECRET_EN,
    },
    {
        id: "batch-162",
        cell: "durable_facts:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-162-succ3-durable-ko.md",
        cases: BATCH_162_DURABLE_KO,
    },
    {
        id: "batch-163",
        cell: "durable_facts:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-163-succ3-durable-en.md",
        cases: BATCH_163_DURABLE_EN,
    },
    {
        id: "batch-164",
        cell: "assistant_only:ko",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-164-succ3-assistant-ko.md",
        cases: BATCH_164_ASSISTANT_KO,
    },
    {
        id: "batch-165",
        cell: "assistant_only:en",
        record:
            "docs/ops/memory-extraction-eval-batches/batch-165-succ3-assistant-en.md",
        cases: BATCH_165_ASSISTANT_EN,
    },
];
