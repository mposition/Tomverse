import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";

import { SUCC7_ASSISTANT_ONLY } from "@/lib/memoryEvalSucc7Replacements/assistantOnly";
import { SUCC7_DURABLE_FACTS } from "@/lib/memoryEvalSucc7Replacements/durableFacts";

/**
 * Every succ-7 replacement written so far.
 *
 * Deliberately not the full 54 yet. `check:memory-eval-succ7` reads this list
 * against `SUCC7_TRANSITION` and fails while any body is missing, so an
 * unfinished successor stays visibly unfinished rather than passing quietly.
 */
export const MEMORY_EVAL_SUCC7_REPLACEMENTS: readonly MemoryEvalCaseV3[] = [
    ...SUCC7_ASSISTANT_ONLY,
    ...SUCC7_DURABLE_FACTS,
];
