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
 * **Not frozen yet, and one field is why.**
 *
 * Six of the seven §7.1 conditions hold: every cell is at its floor, no batch
 * is unreviewed, all 40 records carry an adoption, verdicts, a diversity
 * judgement and a date, draft disagreement is 0%, `findDuplicateCases()` is
 * clean, and a named reviewer is on all 40.
 *
 * The seventh — 초안 도구·모델·버전 — is unmet on the eight replacement
 * batches (133–136, 162–165). Their cases were drafted by an agent, and this
 * repository's rule is that an agent does not write its own model identifier
 * into anything pushed here. So the row is present and blank, exactly as
 * `mem-eval-succ-2`'s records were before the operator filled them, and only
 * the operator can fill it.
 *
 * The 25 successor batches are not waiting on anything: their cases were
 * drafted for the batch each one succeeds and the record carries that value
 * across.
 *
 * `npm run check:memory-eval-freeze` names the eight and exits non-zero while
 * this says `true` and a condition is unmet — so this stays `false` until the
 * field is filled, and the harness refuses `--live` until then. That refusal
 * is the point: a number computed against a set that can still move cannot be
 * cited.
 */
export const MEMORY_EVAL_SUCC3_DATASET_FROZEN = false;

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
