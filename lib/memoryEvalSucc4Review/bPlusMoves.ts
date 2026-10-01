/**
 * The `succ-3` cases that leave the decision set for `succ-4`, and why.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12, approved
 * 2026-08-28.
 *
 * ## B+ covers contract rules too
 *
 * The earlier reading — that B+ binds only rules the model is shown — was
 * rejected. Deriving what a scorer counts, or what a gold means, from a
 * decision case fits the evaluator to that case; not being shown to the model
 * does not restore its independence. So the line is **forming** a rule against
 * **applying** a frozen one:
 *
 *   * used to make, amend or choose a rule  -> moves here
 *   * assigned a polarity under a rule already frozen  -> may stay
 *
 * ## Why 99 and not 101
 *
 * The report separated 121 golds into 101 whose quote carried a negation
 * marker and 20 whose did not, and that split is not the B+ split. Ninety-three
 * distinct cases carry those 101 golds, and every one was in front of a
 * reviewer while `MEMORY_EVAL_POLARITY_ASSIGNMENT_RULE` was being written —
 * `야간 운전은 못 합니다` is what forced the rule to exist, the oven pair
 * decided that polarity is about whether `factValueAll` holds, and `aisle` and
 * `penicillin` decided that a marker in the quote settles nothing. None of
 * them can be called a case that merely applied the rule.
 *
 * Six of the twenty join them, four for forming a rule and two because §12.2
 * moves a gold whose match target or anchor changed. The remaining thirteen
 * were read after `mem-score-v3.2` was frozen, changed nothing, and stay.
 *
 * ## The union is 198, not 99 + 99
 *
 * The corpus already holds 99 cases from succ-2 -> succ-3. They left that
 * dataset then, so they cannot be in this set, and the union is 198 with no
 * overlap. What the arithmetic hides is that a seat can be replaced twice:
 * `succ-durable-ko-301` belongs to batch-162, which was itself written to
 * replace one of the first 99. That is a fact about this corpus, not a
 * miscount, and `ruleId` records which rule each departure served.
 */

export type Succ4MoveRuleId =
    /** `MEMORY_EVAL_POLARITY_ASSIGNMENT_RULE` and its under-specification bar. */
    | "contract-polarity-assignment"
    /** §1② — polarity leaves `mustIncludeAny` and becomes a field. */
    | "contract-polarity-is-a-field"
    /** The under-specification clause's worked example. */
    | "contract-under-specification"
    /** `gold-evidence-covers-fact` (`mem-score-v3.1`). */
    | "contract-gold-evidence-covers-fact"
    /** §12.3 — approved stem against `factValueAny`. */
    | "contract-stem-vs-factvalueany"
    /** §12.4 — one gold, one atomic proposition, one polarity. */
    | "contract-atomic-proposition"
    /** No rule formed; the gold's fact value was rewritten in canonical form. */
    | "gold-corrected-canonical-form"
    /** No rule formed; the anchor moved to the plainly-stated clause. */
    | "gold-corrected-anchor-clause"
    /**
     * No rule formed; the frozen under-specification clause was applied to a
     * gold read during the batches, and its token list named a topic.
     */
    | "gold-corrected-under-specified";

export type Succ4Move = {
    originalId: string;
    cell: string;
    ruleId: Succ4MoveRuleId;
    /**
     * Which reading moved this case.
     *
     * The first 99 came out of the 121 golds a reviewer had to settle before a
     * standard existed. `batch` ones were ruled while reading the remaining
     * 353, `assembly` ones while assembling the schema-3 cases — the
     * arithmetic has to keep them apart or "99 move and 13 stay" stops being
     * checkable against anything.
     */
    from: "judgement-121" | "batch" | "assembly";
    /** Where a reader would otherwise have to reconstruct the reason. */
    note?: string;
};

export const SUCC4_B_PLUS_MOVES: readonly Succ4Move[] = [
    { originalId: "succ-assistant-en-301", cell: "assistant_only:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-assistant-en-302", cell: "assistant_only:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-assistant-en-303", cell: "assistant_only:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-assistant-en-304", cell: "assistant_only:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-assistant-en-305", cell: "assistant_only:en", ruleId: "contract-stem-vs-factvalueany", from: "judgement-121" },
    { originalId: "succ-assistant-ko-301", cell: "assistant_only:ko", ruleId: "contract-polarity-is-a-field", from: "judgement-121" },
    { originalId: "succ-assistant-ko-302", cell: "assistant_only:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-assistant-ko-303", cell: "assistant_only:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-assistant-ko-304", cell: "assistant_only:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-assistant-ko-305", cell: "assistant_only:ko", ruleId: "contract-under-specification", from: "judgement-121" },
    { originalId: "succ-assistant-ko-306", cell: "assistant_only:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-assistant-ko-308", cell: "assistant_only:ko", ruleId: "gold-corrected-anchor-clause", from: "judgement-121" },
    { originalId: "succ-durable-en-10", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-101", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-108", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-109", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-110", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-111", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-112", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-113", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-116", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-122", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-128", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-130", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-146", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-153", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-160", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-162", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-164", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-166", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-167", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-168", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-173", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-177", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-178", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-181", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-19", cell: "durable_facts:en", ruleId: "contract-atomic-proposition", from: "judgement-121" },
    { originalId: "succ-durable-en-199", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-20", cell: "durable_facts:en", ruleId: "contract-gold-evidence-covers-fact", from: "judgement-121" },
    { originalId: "succ-durable-en-21", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-22", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-23", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-26", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-3", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-302", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-303", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-304", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-305", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-308", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-311", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-312", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-320", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-38", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-52", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-58", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-61", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-62", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-63", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-65", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-7", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-73", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-76", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-8", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-88", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-en-90", cell: "durable_facts:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-109", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-111", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-112", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-113", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-118", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-12", cell: "durable_facts:ko", ruleId: "contract-atomic-proposition", from: "judgement-121" },
    { originalId: "succ-durable-ko-126", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-127", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-128", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-129", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-130", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-140", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-153", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-159", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-16", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-161", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-162", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-172", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-173", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-181", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-199", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-20", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-200", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-301", cell: "durable_facts:ko", ruleId: "gold-corrected-canonical-form", from: "judgement-121" },
    { originalId: "succ-durable-ko-313", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-323", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-326", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-50", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-51", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-52", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-68", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-durable-ko-84", cell: "durable_facts:ko", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-injection-en-119", cell: "injection_directives:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    { originalId: "succ-injection-en-123", cell: "injection_directives:en", ruleId: "contract-polarity-assignment", from: "judgement-121" },
    /* ---------------------------------------------------------------------
     * Ruled 2026-08-28, during the batches.
     *
     * Not a new rule. `spoken for` and `constrained` are affirmative in form
     * and deny the availability of the weekend and the space, which is what
     * the canonical proposition is about; reading them as affirmed would make
     * a score move with the paraphrase. Both then fail the frozen
     * under-specification clause for the same reason — `["weekend"]` and
     * `["space"]` name a topic where the opposite reading is live — so the
     * labels are not simply flipped and left in the decision set. The cases
     * move and are replaced by ones whose predicate is explicit.
     * ------------------------------------------------------------------ */
    {
        originalId: "succ-durable-en-129",
        cell: "durable_facts:en",
        ruleId: "gold-corrected-under-specified",
        from: "batch",
        note:
            "Its Korean pair ko-129 was already moving, on the polarity assignment " +
            "rule. One fact, two arms, and now one label.",
    },
    {
        originalId: "succ-durable-en-316",
        cell: "durable_facts:en",
        ruleId: "gold-corrected-under-specified",
        from: "batch",
        note:
            "The whole case moves, so g1 (`artist`) goes with g2 (`space`) although " +
            "only g2 was misread. It is itself the replacement written for " +
            "succ-durable-en-57 under rule-4, so the provenance runs en-57 -> en-316 " +
            "-> a further replacement, and its two-gold shape should be kept.",
    },

    /* ---------------------------------------------------------------------
     * Found while assembling, and moved by
     * .github/audits/memory-eval-gold-contract-2026-08-27.md §12.2 rather than §12.1.
     *
     * No rule was formed from either: the anchor proposal takes the first user
     * message carrying the tokens, and in a correction that is the user
     * quoting the assistant's premise back rather than stating the fact. The
     * reading moved each anchor to the turn that states it.
     *
     * .github/audits/memory-eval-gold-contract-2026-08-27.md §12.2 is
     * categorical about a gold whose anchor changed, and it does not
     * ask when the change happened. `succ-durable-ko-301` and
     * `succ-assistant-ko-308` moved under it having formed no rule either, so
     * leaving these two would apply the same clause two ways.
     * ------------------------------------------------------------------ */
    {
        originalId: "succ-assistant-en-306",
        cell: "assistant_only:en",
        ruleId: "gold-corrected-anchor-clause",
        from: "assembly",
        note:
            "Anchored on «The onboarding checklist you drafted has a section on " +
            "sibling carer leave», which is the user quoting the draft. Moved to m3, " +
            "«I have no siblings». goldEvidenceFailure passed on the first: a user " +
            "message, an exact span, the token present — it does not check that the " +
            "quote carries the polarity.",
    },
    {
        originalId: "succ-assistant-en-307",
        cell: "assistant_only:en",
        ruleId: "gold-corrected-anchor-clause",
        from: "assembly",
        note: "Same shape: m1 describes the options, m3 states «I don't have a printer».",
    },
];

/**
 * Cases read during the review that stay in the decision set.
 *
 * Listed rather than left implicit: "these thirteen were not moved" is a claim
 * about each of them, and a claim nobody can enumerate is one nobody can
 * check. Each was read after `mem-score-v3.2` was frozen, had its polarity
 * assigned under it, and kept its gold and its anchor unchanged.
 */
export const SUCC4_REVIEWED_AND_KEPT: readonly string[] = [
    "succ-durable-ko-25",
    "succ-durable-ko-72",
    "succ-durable-ko-193",
    "succ-durable-ko-307",
    "succ-durable-ko-309",
    "succ-durable-ko-311",
    "succ-durable-ko-312",
    "succ-durable-ko-314",
    "succ-durable-ko-315",
    "succ-durable-en-306",
    "succ-assistant-ko-307",
];
