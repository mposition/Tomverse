/**
 * Which replacement stands in for which moved case.
 *
 * The 99 originals in `lib/memoryEvalRegressionCorpus/provenance.ts` carry
 * `replacementId: null`, and that is not a to-do. The separation test reads it
 * as an invariant — a case has a replacement exactly when it has left the
 * decision set — so it may only be filled in during the one atomic change that
 * wires `mem-eval-succ-3`. Setting it now would claim a migration that has not
 * happened.
 *
 * The mapping itself exists now, though, because the replacements are written.
 * Keeping it here rather than in a comment makes it checkable:
 * `tests/memoryEvalReplacementPlan.test.mjs` holds it to the provenance list
 * exactly, to the replacement batches, and to the cell of the case each one
 * replaces. At wiring time the plan is copied into `replacementId` and the
 * same test proves nothing moved in between.
 *
 * ## Written canonically, not in shorthand
 *
 * Every id below is a full case id. A batch's own comments say "Replaces
 * ko-79", which is unambiguous inside a `durable_facts:ko` file and ambiguous
 * everywhere else: `succ-durable-ko-79` and `succ-assistant-ko-79` are
 * different cases with different rulings, and reading one for the other has
 * already produced a wrong count once
 * (`.github/audits/memory-eval-kind-boundary-correction-2026-08-27.md`).
 */

export type ReplacementPlanEntry = {
    /** The case moving to `lib/memoryEvalRegressionCorpus/`. */
    originalId: string;
    /** The decision-set case written to take its place. */
    replacementId: string;
};

/** All 99, sorted by the id of the case being replaced. */
export const MEMORY_EVAL_REPLACEMENT_PLAN: readonly ReplacementPlanEntry[] = [
    { originalId: "succ-assistant-en-119", replacementId: "succ-assistant-en-315" },
    { originalId: "succ-assistant-en-13", replacementId: "succ-assistant-en-309" },
    { originalId: "succ-assistant-en-16", replacementId: "succ-assistant-en-310" },
    { originalId: "succ-assistant-en-23", replacementId: "succ-assistant-en-311" },
    { originalId: "succ-assistant-en-65", replacementId: "succ-assistant-en-312" },
    { originalId: "succ-assistant-en-78", replacementId: "succ-assistant-en-313" },
    { originalId: "succ-assistant-en-79", replacementId: "succ-assistant-en-301" },
    { originalId: "succ-assistant-en-8", replacementId: "succ-assistant-en-308" },
    { originalId: "succ-assistant-en-80", replacementId: "succ-assistant-en-302" },
    { originalId: "succ-assistant-en-81", replacementId: "succ-assistant-en-303" },
    { originalId: "succ-assistant-en-82", replacementId: "succ-assistant-en-304" },
    { originalId: "succ-assistant-en-83", replacementId: "succ-assistant-en-305" },
    { originalId: "succ-assistant-en-84", replacementId: "succ-assistant-en-306" },
    { originalId: "succ-assistant-en-85", replacementId: "succ-assistant-en-307" },
    { originalId: "succ-assistant-en-86", replacementId: "succ-assistant-en-314" },
    { originalId: "succ-assistant-ko-106", replacementId: "succ-assistant-ko-318" },
    { originalId: "succ-assistant-ko-13", replacementId: "succ-assistant-ko-310" },
    { originalId: "succ-assistant-ko-36", replacementId: "succ-assistant-ko-311" },
    { originalId: "succ-assistant-ko-47", replacementId: "succ-assistant-ko-312" },
    { originalId: "succ-assistant-ko-65", replacementId: "succ-assistant-ko-313" },
    { originalId: "succ-assistant-ko-78", replacementId: "succ-assistant-ko-314" },
    { originalId: "succ-assistant-ko-79", replacementId: "succ-assistant-ko-301" },
    { originalId: "succ-assistant-ko-8", replacementId: "succ-assistant-ko-309" },
    { originalId: "succ-assistant-ko-80", replacementId: "succ-assistant-ko-302" },
    { originalId: "succ-assistant-ko-81", replacementId: "succ-assistant-ko-303" },
    { originalId: "succ-assistant-ko-82", replacementId: "succ-assistant-ko-304" },
    { originalId: "succ-assistant-ko-83", replacementId: "succ-assistant-ko-305" },
    { originalId: "succ-assistant-ko-84", replacementId: "succ-assistant-ko-306" },
    { originalId: "succ-assistant-ko-85", replacementId: "succ-assistant-ko-307" },
    { originalId: "succ-assistant-ko-86", replacementId: "succ-assistant-ko-315" },
    { originalId: "succ-assistant-ko-92", replacementId: "succ-assistant-ko-308" },
    { originalId: "succ-assistant-ko-93", replacementId: "succ-assistant-ko-316" },
    { originalId: "succ-assistant-ko-95", replacementId: "succ-assistant-ko-317" },
    { originalId: "succ-durable-en-105", replacementId: "succ-durable-en-301" },
    { originalId: "succ-durable-en-106", replacementId: "succ-durable-en-302" },
    { originalId: "succ-durable-en-133", replacementId: "succ-durable-en-303" },
    { originalId: "succ-durable-en-134", replacementId: "succ-durable-en-304" },
    { originalId: "succ-durable-en-144", replacementId: "succ-durable-en-305" },
    { originalId: "succ-durable-en-145", replacementId: "succ-durable-en-306" },
    { originalId: "succ-durable-en-156", replacementId: "succ-durable-en-307" },
    { originalId: "succ-durable-en-182", replacementId: "succ-durable-en-308" },
    { originalId: "succ-durable-en-189", replacementId: "succ-durable-en-309" },
    { originalId: "succ-durable-en-190", replacementId: "succ-durable-en-310" },
    { originalId: "succ-durable-en-28", replacementId: "succ-durable-en-311" },
    { originalId: "succ-durable-en-29", replacementId: "succ-durable-en-312" },
    { originalId: "succ-durable-en-30", replacementId: "succ-durable-en-313" },
    { originalId: "succ-durable-en-41", replacementId: "succ-durable-en-314" },
    { originalId: "succ-durable-en-56", replacementId: "succ-durable-en-315" },
    { originalId: "succ-durable-en-57", replacementId: "succ-durable-en-316" },
    { originalId: "succ-durable-en-78", replacementId: "succ-durable-en-317" },
    { originalId: "succ-durable-en-79", replacementId: "succ-durable-en-318" },
    { originalId: "succ-durable-en-83", replacementId: "succ-durable-en-319" },
    { originalId: "succ-durable-en-91", replacementId: "succ-durable-en-320" },
    { originalId: "succ-durable-ko-105", replacementId: "succ-durable-ko-301" },
    { originalId: "succ-durable-ko-106", replacementId: "succ-durable-ko-302" },
    { originalId: "succ-durable-ko-107", replacementId: "succ-durable-ko-303" },
    { originalId: "succ-durable-ko-116", replacementId: "succ-durable-ko-304" },
    { originalId: "succ-durable-ko-133", replacementId: "succ-durable-ko-305" },
    { originalId: "succ-durable-ko-134", replacementId: "succ-durable-ko-306" },
    { originalId: "succ-durable-ko-145", replacementId: "succ-durable-ko-307" },
    { originalId: "succ-durable-ko-15", replacementId: "succ-durable-ko-308" },
    { originalId: "succ-durable-ko-156", replacementId: "succ-durable-ko-309" },
    { originalId: "succ-durable-ko-157", replacementId: "succ-durable-ko-310" },
    { originalId: "succ-durable-ko-158", replacementId: "succ-durable-ko-311" },
    { originalId: "succ-durable-ko-163", replacementId: "succ-durable-ko-312" },
    { originalId: "succ-durable-ko-175", replacementId: "succ-durable-ko-313" },
    { originalId: "succ-durable-ko-189", replacementId: "succ-durable-ko-314" },
    { originalId: "succ-durable-ko-190", replacementId: "succ-durable-ko-315" },
    { originalId: "succ-durable-ko-2", replacementId: "succ-durable-ko-316" },
    { originalId: "succ-durable-ko-21", replacementId: "succ-durable-ko-317" },
    { originalId: "succ-durable-ko-23", replacementId: "succ-durable-ko-318" },
    { originalId: "succ-durable-ko-28", replacementId: "succ-durable-ko-319" },
    { originalId: "succ-durable-ko-29", replacementId: "succ-durable-ko-320" },
    { originalId: "succ-durable-ko-47", replacementId: "succ-durable-ko-321" },
    { originalId: "succ-durable-ko-59", replacementId: "succ-durable-ko-322" },
    { originalId: "succ-durable-ko-61", replacementId: "succ-durable-ko-323" },
    { originalId: "succ-durable-ko-62", replacementId: "succ-durable-ko-324" },
    { originalId: "succ-durable-ko-76", replacementId: "succ-durable-ko-325" },
    { originalId: "succ-durable-ko-78", replacementId: "succ-durable-ko-326" },
    { originalId: "succ-durable-ko-79", replacementId: "succ-durable-ko-327" },
    { originalId: "succ-durable-ko-83", replacementId: "succ-durable-ko-328" },
    { originalId: "succ-durable-ko-99", replacementId: "succ-durable-ko-329" },
    { originalId: "succ-injection-en-23", replacementId: "succ-injection-en-301" },
    { originalId: "succ-injection-en-26", replacementId: "succ-injection-en-302" },
    { originalId: "succ-injection-en-86", replacementId: "succ-injection-en-303" },
    { originalId: "succ-injection-en-87", replacementId: "succ-injection-en-304" },
    { originalId: "succ-injection-en-93", replacementId: "succ-injection-en-305" },
    { originalId: "succ-injection-ko-1", replacementId: "succ-injection-ko-301" },
    { originalId: "succ-injection-ko-125", replacementId: "succ-injection-ko-308" },
    { originalId: "succ-injection-ko-2", replacementId: "succ-injection-ko-302" },
    { originalId: "succ-injection-ko-23", replacementId: "succ-injection-ko-304" },
    { originalId: "succ-injection-ko-26", replacementId: "succ-injection-ko-305" },
    { originalId: "succ-injection-ko-3", replacementId: "succ-injection-ko-303" },
    { originalId: "succ-injection-ko-87", replacementId: "succ-injection-ko-306" },
    { originalId: "succ-injection-ko-95", replacementId: "succ-injection-ko-307" },
    { originalId: "succ-secret-en-121", replacementId: "succ-secret-en-302" },
    { originalId: "succ-secret-en-91", replacementId: "succ-secret-en-301" },
    { originalId: "succ-secret-ko-121", replacementId: "succ-secret-ko-302" },
    { originalId: "succ-secret-ko-91", replacementId: "succ-secret-ko-301" },
];
