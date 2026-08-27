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
 * `lib/memoryEvalSuccessorFixtures.ts` does not import this directory, and a
 * test asserts it transitively, so a reintroduction has to be written rather
 * than forgotten.
 *
 * `tests/memoryEvalRegressionCorpusSeparation.test.mjs` holds the five
 * invariants: no shared IDs, the decision digest is computed without this
 * module, the decision loader's import graph excludes it, every entry has
 * complete provenance, and the cell floors survive the move.
 *
 * ## Empty, and not idle
 *
 * The 99 originals are still in the decision set: every cell sits exactly at
 * its §12.2 floor, so a case cannot leave until its replacement is written.
 * The migration is atomic per case — the original moves here and
 * `replacementId` is filled in the same change, or the invariant fails.
 * Until then this array is empty and `MEMORY_EVAL_REGRESSION_PROVENANCE`
 * carries the 99 planned moves with `replacementId: null`.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";

export const MEMORY_EVAL_REGRESSION_CASES: readonly MemoryEvalCaseV2[] = [];

export {
    MEMORY_EVAL_REGRESSION_PROVENANCE,
    type RegressionProvenance,
    type RegressionRuleId,
} from "./provenance";
