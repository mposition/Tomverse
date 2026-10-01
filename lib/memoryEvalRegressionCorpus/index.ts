/**
 * Cases that authored the rules, kept out of the set that measures them.
 *
 * A case used to write or approve a rule cannot also be evidence for that
 * rule: the run would be scoring the prompt against the cases the prompt was
 * written from, and the number would be a restatement rather than a
 * measurement. run1 exposed 112 cases; 99 decided a rule or a verdict and
 * belong here, and 13 were read without influencing anything and stay in the
 * decision set.
 *
 * ## Why a separate module rather than a field
 *
 * A `purpose: "regression"` field would work exactly as long as every reader
 * remembers to filter on it. One loader that forgets puts these cases back
 * into the decision set and the digest, and nothing says so — the digest
 * moves for a reason, the sample grows for a reason, and both look
 * legitimate. Separating the import graph makes that structural instead:
 * `lib/memoryEvalSucc3Fixtures.ts` does not import this directory, and a test
 * asserts it transitively, so a reintroduction has to be written rather than
 * forgotten.
 *
 * `tests/memoryEvalRegressionCorpusSeparation.test.mjs` holds the five
 * invariants: no shared IDs, the decision digest is computed without this
 * module, the decision loader's import graph excludes it, every entry has
 * complete provenance, and the cell floors survive the move.
 *
 * ## Taken by identity, from the batches that still hold them
 *
 * `mem-eval-succ-2` was not edited and still contains all 99. What changed is
 * that `mem-eval-succ-3` reaches those batches through successors that drop
 * them. So this module reads the same batch modules and picks the 99 out by
 * id — the same objects, not copies. `pick()` refuses an id the batch does
 * not hold, which is what stops this list and the successors' exclusion lists
 * from drifting apart.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";
import { BATCH_101_DURABLE_KO } from "@/lib/memoryEvalSuccessorAdopted/batch101DurableKo";
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
import { BATCH_117_INJECTION_KO } from "@/lib/memoryEvalSuccessorAdopted/batch117InjectionKo";
import { BATCH_118_INJECTION_EN } from "@/lib/memoryEvalSuccessorAdopted/batch118InjectionEn";
import { BATCH_120_INJECTION_EN } from "@/lib/memoryEvalSuccessorAdopted/batch120InjectionEn";
import { BATCH_121_ASSISTANT_KO } from "@/lib/memoryEvalSuccessorAdopted/batch121AssistantKo";
import { BATCH_122_ASSISTANT_KO } from "@/lib/memoryEvalSuccessorAdopted/batch122AssistantKo";
import { BATCH_123_ASSISTANT_KO } from "@/lib/memoryEvalSuccessorAdopted/batch123AssistantKo";
import { BATCH_124_ASSISTANT_EN } from "@/lib/memoryEvalSuccessorAdopted/batch124AssistantEn";
import { BATCH_125_ASSISTANT_EN } from "@/lib/memoryEvalSuccessorAdopted/batch125AssistantEn";
import { BATCH_126_ASSISTANT_EN } from "@/lib/memoryEvalSuccessorAdopted/batch126AssistantEn";
import { BATCH_129_SECRET_KO } from "@/lib/memoryEvalSuccessorAdopted/batch129SecretKo";
import { BATCH_132_SECRET_EN } from "@/lib/memoryEvalSuccessorAdopted/batch132SecretEn";

/**
 * The named cases from one batch, in the batch's own order.
 *
 * Throws at module load on an id the batch does not hold. A silent miss here
 * would leave a rule-authoring case in the decision set with nothing saying
 * so, which is the one failure this corpus exists to prevent.
 */
const pick = (
    batch: readonly MemoryEvalCaseV2[],
    ids: readonly string[]
): readonly MemoryEvalCaseV2[] => {
    const wanted = new Set(ids);
    const found = batch.filter((testCase) => wanted.has(testCase.id));
    if (found.length !== ids.length) {
        const missing = ids.filter(
            (id) => !batch.some((testCase) => testCase.id === id)
        );
        throw new Error(
            `memory eval regression corpus: ${missing.join(", ")} is not in this batch, ` +
                "so the corpus and the successor that excluded it disagree about which " +
                "cases moved."
        );
    }
    return found;
};

export const MEMORY_EVAL_REGRESSION_CASES: readonly MemoryEvalCaseV2[] = [

    // batch-101
    ...pick(BATCH_101_DURABLE_KO, [
        "succ-durable-ko-2",
        "succ-durable-ko-15",
        "succ-durable-ko-21",
        "succ-durable-ko-23",
    ]),
    // batch-103
    ...pick(BATCH_103_DURABLE_KO, [
        "succ-durable-ko-28",
        "succ-durable-ko-29",
        "succ-durable-ko-47",
    ]),
    // batch-104
    ...pick(BATCH_104_DURABLE_KO, [
        "succ-durable-ko-59",
        "succ-durable-ko-61",
        "succ-durable-ko-62",
    ]),
    // batch-105
    ...pick(BATCH_105_DURABLE_EN, [
        "succ-durable-en-28",
        "succ-durable-en-29",
        "succ-durable-en-30",
        "succ-durable-en-41",
    ]),
    // batch-106
    ...pick(BATCH_106_DURABLE_EN, [
        "succ-durable-en-56",
        "succ-durable-en-57",
    ]),
    // batch-107
    ...pick(BATCH_107_DURABLE_KO, [
        "succ-durable-ko-76",
        "succ-durable-ko-78",
        "succ-durable-ko-79",
        "succ-durable-ko-83",
        "succ-durable-ko-99",
    ]),
    // batch-108
    ...pick(BATCH_108_DURABLE_KO, [
        "succ-durable-ko-105",
        "succ-durable-ko-106",
        "succ-durable-ko-107",
        "succ-durable-ko-116",
    ]),
    // batch-109
    ...pick(BATCH_109_DURABLE_EN, [
        "succ-durable-en-78",
        "succ-durable-en-79",
        "succ-durable-en-83",
        "succ-durable-en-91",
    ]),
    // batch-110
    ...pick(BATCH_110_DURABLE_EN, [
        "succ-durable-en-105",
        "succ-durable-en-106",
    ]),
    // batch-111
    ...pick(BATCH_111_DURABLE_KO, [
        "succ-durable-ko-133",
        "succ-durable-ko-134",
        "succ-durable-ko-145",
        "succ-durable-ko-156",
        "succ-durable-ko-157",
        "succ-durable-ko-158",
        "succ-durable-ko-163",
    ]),
    // batch-112
    ...pick(BATCH_112_DURABLE_EN, [
        "succ-durable-en-133",
        "succ-durable-en-134",
        "succ-durable-en-144",
        "succ-durable-en-145",
        "succ-durable-en-156",
    ]),
    // batch-113
    ...pick(BATCH_113_DURABLE_KO, [
        "succ-durable-ko-175",
        "succ-durable-ko-189",
        "succ-durable-ko-190",
    ]),
    // batch-114
    ...pick(BATCH_114_DURABLE_EN, [
        "succ-durable-en-182",
        "succ-durable-en-189",
        "succ-durable-en-190",
    ]),
    // batch-115
    ...pick(BATCH_115_INJECTION_KO, [
        "succ-injection-ko-1",
        "succ-injection-ko-2",
        "succ-injection-ko-3",
        "succ-injection-ko-23",
        "succ-injection-ko-26",
    ]),
    // batch-117
    ...pick(BATCH_117_INJECTION_KO, [
        "succ-injection-ko-87",
        "succ-injection-ko-95",
        "succ-injection-ko-125",
    ]),
    // batch-118
    ...pick(BATCH_118_INJECTION_EN, [
        "succ-injection-en-23",
        "succ-injection-en-26",
    ]),
    // batch-120
    ...pick(BATCH_120_INJECTION_EN, [
        "succ-injection-en-86",
        "succ-injection-en-87",
        "succ-injection-en-93",
    ]),
    // batch-121
    ...pick(BATCH_121_ASSISTANT_KO, [
        "succ-assistant-ko-8",
        "succ-assistant-ko-13",
    ]),
    // batch-122
    ...pick(BATCH_122_ASSISTANT_KO, [
        "succ-assistant-ko-36",
        "succ-assistant-ko-47",
        "succ-assistant-ko-65",
        "succ-assistant-ko-78",
        "succ-assistant-ko-79",
    ]),
    // batch-123
    ...pick(BATCH_123_ASSISTANT_KO, [
        "succ-assistant-ko-80",
        "succ-assistant-ko-81",
        "succ-assistant-ko-82",
        "succ-assistant-ko-83",
        "succ-assistant-ko-84",
        "succ-assistant-ko-85",
        "succ-assistant-ko-86",
        "succ-assistant-ko-92",
        "succ-assistant-ko-93",
        "succ-assistant-ko-95",
        "succ-assistant-ko-106",
    ]),
    // batch-124
    ...pick(BATCH_124_ASSISTANT_EN, [
        "succ-assistant-en-8",
        "succ-assistant-en-13",
        "succ-assistant-en-16",
        "succ-assistant-en-23",
    ]),
    // batch-125
    ...pick(BATCH_125_ASSISTANT_EN, [
        "succ-assistant-en-65",
        "succ-assistant-en-78",
        "succ-assistant-en-79",
    ]),
    // batch-126
    ...pick(BATCH_126_ASSISTANT_EN, [
        "succ-assistant-en-80",
        "succ-assistant-en-81",
        "succ-assistant-en-82",
        "succ-assistant-en-83",
        "succ-assistant-en-84",
        "succ-assistant-en-85",
        "succ-assistant-en-86",
        "succ-assistant-en-119",
    ]),
    // batch-129
    ...pick(BATCH_129_SECRET_KO, [
        "succ-secret-ko-91",
        "succ-secret-ko-121",
    ]),
    // batch-132
    ...pick(BATCH_132_SECRET_EN, [
        "succ-secret-en-91",
        "succ-secret-en-121",
    ]),
];

export {
    MEMORY_EVAL_REGRESSION_PROVENANCE,
    type RegressionProvenance,
    type RegressionRuleId,
} from "./provenance";
