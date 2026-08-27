/**
 * `mem-eval-succ-3` — the decision set the next run is scored against.
 *
 * ## Why there is a third version
 *
 * run1 scored `mem-eval-succ-2` against `mem-extract-v4` and did not pass. The
 * diagnosis produced five prompt rules and a set of gold rulings, frozen in
 * `.github/audits/memory-eval-kind-boundary-amendment-2026-08-27.md`, and 99
 * cases were used to author or approve them. A case that wrote a rule cannot
 * also measure it, so those 99 move to `lib/memoryEvalRegressionCorpus/` and
 * 99 new cases take their place.
 *
 * That is a change to the sample, which under
 * `docs/ops/memory-extraction-eval-dataset.md` §7.3 is a new version rather
 * than an edit — a frozen dataset is never modified.
 *
 * ## succ-2 is not touched, and that is the point
 *
 * `lib/memoryEvalSuccessorFixtures.ts` still exports succ-2, still frozen,
 * still 1,150 cases, still fingerprinting to `60aa43f1...`. Its manifest in
 * `lib/memoryEvalDatasetManifests.ts` recomputes on every build, and
 * `resolveArtifactDataset()` still resolves run1's artifact to it and reads
 * it. A superseded dataset that cannot be read is not preserved; one that is
 * quietly reassembled under its own manifest is worse.
 *
 * ## What changed from succ-2, exactly
 *
 * The conversations of 1,051 cases did not change at all — they are the same
 * objects, reached through successor batches that drop a case rather than
 * rewrite the batch. The 99 that left are named, with the rule each one
 * authored, in `lib/memoryEvalRegressionCorpus/provenance.ts`. The 99 that
 * arrived keep the boundary their predecessor tested and change the
 * situation, and they carry the labels the amendment settled rather than the
 * pre-amendment ones their predecessors still show.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";
import { SUCC3_ADOPTED_BATCHES } from "@/lib/memoryEvalSucc3Adopted";

export const MEMORY_EVAL_SUCC3_DATASET_VERSION = "mem-eval-succ-3";

/**
 * The version this one replaces, named rather than implied.
 *
 * succ-2 keeps its own manifest and its own module. This line is what lets a
 * later reader see that no succ-2 verdict was carried across — run1's was a
 * not-a-pass and it stays attached to the sample that produced it.
 */
export const MEMORY_EVAL_SUCC3_SUPERSEDES = "mem-eval-succ-2";

/**
 * Frozen on 2026-08-27, against the seven conditions in
 * `docs/ops/memory-extraction-eval-dataset.md` §7.1 — all of them checked
 * mechanically by `npm run check:memory-eval-freeze` before this line changed:
 *
 *   * every cell at or above the §12.2 floor (1,150 cases across 8 cells);
 *   * no batch left unreviewed;
 *   * explicit adoption, verdicts, a diversity judgement and a date on all
 *     40 batches;
 *   * draft disagreement recorded on every batch (max 0%);
 *   * `findDuplicateCases()` clean;
 *   * the drafting tool, model and version on all 40;
 *   * a named reviewer on all 40.
 *
 * The last two are a person's to supply. The reviewer and the case verdicts
 * came on 2026-08-27; the drafting row was the one thing still outstanding
 * after the registry was wired, because an agent does not write its own model
 * identifier into anything pushed here, and the operator supplied it the same
 * day. The 25 successor batches never waited on it — their cases were drafted
 * for the batch each one succeeds and the record carries that value across.
 *
 * The flag is not the freeze — the check is. It exits non-zero if this says
 * true while a condition is unmet, so the two cannot drift apart.
 *
 * Editing a frozen dataset means a NEW version and invalidates any verdict
 * computed against this one — §7.3. The harness refuses `--live` on an
 * unfrozen set, which is the point: a number computed against a set that can
 * still move cannot be cited.
 */
export const MEMORY_EVAL_SUCC3_DATASET_FROZEN = true;

/**
 * `mem-extract-v5` was written from the 99 cases that are no longer in here.
 * That separation is what this version exists for, and
 * `tests/memoryEvalRegressionCorpusSeparation.test.mjs` is what keeps it.
 */
export const MEMORY_EVAL_SUCC3_DATASET_PURPOSE: "development" | "decision" =
    "decision";

/**
 * The cases, in registry order.
 *
 * Derived from the adopted registry rather than listed again: a second list is
 * one edit away from disagreeing with the records that admitted them.
 */
export const MEMORY_EVAL_SUCC3_CASES: readonly MemoryEvalCaseV2[] =
    SUCC3_ADOPTED_BATCHES.flatMap((batch) => batch.cases);
