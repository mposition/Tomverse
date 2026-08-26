/**
 * `mem-eval-succ-1` — the successor evaluation dataset (schema 2).
 *
 * The set a decision-grade verdict will be computed on, replacing
 * `mem-eval-seed-11` rather than editing it. That separation is the rule
 * `.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md` §6
 * sets: a frozen dataset is never modified, the old version is preserved as
 * diagnostic only, and the rework becomes a new `datasetVersion` whose
 * reasons are recorded.
 *
 * ## Why the two sets cannot share a module
 *
 * `mem-eval-seed-11` is schema 1: no `expectedDisposition`, no
 * `goldCompleteness`. Adding those as optional fields would have made the
 * frozen set *look* loadable by the amended scorer while answering both
 * questions with a guess, so schema 2 is a separate type, this is a separate
 * module, and `lib/memoryEvalSuccessorAdopted/` is a separate registry.
 * `lib/memoryEvalLegacyDataset.ts` remains the only place the two meet, and
 * only for reproducing past diagnostics.
 *
 * ## What changed from the frozen set
 *
 * The conversations did not. All 1,150 cases declare the frozen case they
 * rework in `sourceCaseId`, and `tests/memoryEvalSuccessorBatches.test.mjs`
 * asserts the conversation text is byte-identical to its source — a rework
 * that quietly authored new cases would stop the 2026-08-23 adoption records
 * describing what a reviewer read.
 *
 * What changed is the labelling, per the amendment:
 *
 *   * every expected memory states an `expectedDisposition`;
 *   * every case states `goldCompleteness`, and category ① golds were
 *     completed where a single-memory gold was not the whole truth;
 *   * kinds were relabelled where the amended taxonomy puts a dedicated kind
 *     ahead of a generic one, and `decision` narrowed to settled choices;
 *   * ten critical-negative cases carry a gold under `criticalGoldMode`
 *     (`.github/audits/memory-eval-mixed-critical-amendment-2026-08-26.md`).
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";
import { SUCCESSOR_ADOPTED_BATCHES } from "@/lib/memoryEvalSuccessorAdopted";

export const MEMORY_EVAL_SUCCESSOR_DATASET_VERSION = "mem-eval-succ-1";

/**
 * The version this one replaces, named rather than implied.
 *
 * A verdict cites a dataset version. Recording what `mem-eval-succ-1`
 * supersedes is what lets a later reader tell that no seed-11 verdict was
 * carried across — there were none to carry, and this line is what keeps
 * that checkable rather than remembered.
 */
export const MEMORY_EVAL_SUCCESSOR_SUPERSEDES = "mem-eval-seed-11";

/**
 * Whether this dataset is frozen for a decision-grade run
 * (docs/policy/external-conversation-import-and-memory.md §12.2).
 *
 * Frozen on 2026-08-26, against the seven conditions in
 * `docs/ops/memory-extraction-eval-dataset.md` §7.1 — all of them checked
 * mechanically by `npm run check:memory-eval-freeze` before this line
 * changed, and the script re-checks them on every run:
 *
 *   * every cell at or above the §12.2 floor (1,150 cases across 8 cells);
 *   * no batch left unreviewed;
 *   * explicit adoption, verdicts, a diversity judgement and a date on all
 *     32 batches;
 *   * draft disagreement recorded on every batch (max 0%);
 *   * `findDuplicateCases()` clean;
 *   * the drafting tool, model and version on all 32 records;
 *   * a named reviewer on all 32.
 *
 * The last two are a person's to supply and were supplied on 2026-08-26 by
 * @mposition, who also reviewed and adopted all 32 batches that day.
 *
 * The flag is not the freeze — the check is. It exits non-zero if this says
 * true while a condition is unmet, so the two cannot drift apart.
 *
 * Editing a frozen dataset means a NEW version and invalidates any verdict
 * computed against this one — docs/ops/memory-extraction-eval-dataset.md §7.3.
 * The harness refuses `--live` on an unfrozen set, which is the point:
 * a number computed against a set that can still move cannot be cited.
 */
export const MEMORY_EVAL_SUCCESSOR_DATASET_FROZEN = true;

/**
 * Which set this is. `mem-extract-v3` and `v4` were tuned against the
 * 17-case development probe, never against these cases — a prompt tuned on
 * its own test set reports its own overfitting as quality.
 */
export const MEMORY_EVAL_SUCCESSOR_DATASET_PURPOSE: "development" | "decision" =
    "decision";

/**
 * The cases, in registry order.
 *
 * Derived from the adopted registry rather than listed again here: a second
 * list is one edit away from disagreeing with the records that admitted
 * them, and the registry is what ties each batch to its review.
 */
export const MEMORY_EVAL_SUCCESSOR_CASES: readonly MemoryEvalCaseV2[] =
    SUCCESSOR_ADOPTED_BATCHES.flatMap((batch) => batch.cases);
