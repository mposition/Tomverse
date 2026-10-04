/**
 * Which datasets this tree can still supply cases for.
 *
 * Split out of `lib/memoryEvalDatasetRegistry.ts` on 2026-08-31, and the
 * reason is a cycle rather than tidiness.
 *
 * `lib/memoryEvalSucc4Manifest.ts` needs this table to prove succ-4's
 * composition against its predecessor, and it used to import it from the
 * registry. That made the registry a dependency of succ-4's manifest, and
 * therefore of succ-5's, which imports that manifest. While the registry held
 * only schema-1 and schema-2 datasets the cycle was harmless: nothing read
 * across it during initialisation, so a partially-built module was never
 * observed.
 *
 * Adding `mem-eval-succ-6` to the registry broke that, because succ-6 builds
 * its inherited cases from succ-5 *at module scope*. Importing succ-5 first
 * then ran succ-5 → succ-4's manifest → the registry → succ-6 → succ-5, and
 * the last step read an array that did not exist yet. The failure was order
 * dependent, so most entry points — the whole test suite among them — never
 * saw it.
 *
 * This table has no successor dependencies at all, so a module holding only
 * it is a leaf, and both the registry and succ-4's manifest can depend on it
 * without depending on each other.
 */

import type { EvalDatasetComposition } from "@/lib/memoryEvalDatasetManifests";
import { MEMORY_EVAL_CASES } from "@/lib/memoryExtractionEvalFixtures";
import { ADOPTED_BATCHES } from "@/lib/memoryExtractionEvalAdopted";
import { MEMORY_EVAL_SUCCESSOR_CASES } from "@/lib/memoryEvalSuccessorFixtures";
import { SUCCESSOR_ADOPTED_BATCHES } from "@/lib/memoryEvalSuccessorAdopted";
import { MEMORY_EVAL_SUCC3_CASES } from "@/lib/memoryEvalSucc3Fixtures";
import { SUCC3_ADOPTED_BATCHES } from "@/lib/memoryEvalSucc3Adopted";

/**
 * Every dataset this tree can still supply cases for, by version.
 *
 * A manifest without an entry here is still a record — it says what the
 * dataset was — but its artifacts cannot be classified, because classifying
 * a record means comparing it against that case's gold labels.
 *
 * Schema-3 datasets are not here. They carry their own manifests and
 * verifiers, and the registry lists them separately.
 */
export const EVAL_DATASET_COMPOSITIONS: Readonly<
    Record<string, EvalDatasetComposition>
> = {
    "mem-eval-seed-11": {
        schemaVersion: 1,
        batches: ADOPTED_BATCHES,
        cases: MEMORY_EVAL_CASES,
    },
    "mem-eval-succ-2": {
        schemaVersion: 2,
        batches: SUCCESSOR_ADOPTED_BATCHES,
        cases: MEMORY_EVAL_SUCCESSOR_CASES,
    },
    "mem-eval-succ-3": {
        schemaVersion: 2,
        batches: SUCC3_ADOPTED_BATCHES,
        cases: MEMORY_EVAL_SUCC3_CASES,
    },
};
