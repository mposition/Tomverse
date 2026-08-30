/**
 * The succ-3 -> succ-4 transition, as one manifest.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12. Approved
 * 2026-08-28: the 103 originals are excluded from canonical `succ-4`
 * structurally, and preserved as supersession history -- not as a second
 * hand-written list, but derived from here.
 *
 * ## Why one manifest and not several lists
 *
 * Five separate things have to agree about the same 103 cases: which ids
 * `succ-4` excludes, which replacements it must contain, the audit view, the
 * regression corpus's provenance, and the split between a case that moved
 * because a rule was formed on it and one whose gold was corrected. Written
 * as five lists they agree until someone edits one of them. Written here they
 * cannot disagree, because there is nothing to disagree with.
 *
 * ## Superseded cases are never in the decision set
 *
 * The originals are excluded from `succ-4` by construction, not marked inside
 * it. A `superseded` flag on a case in the canonical set is one careless
 * loader away from being scored again, and a scorer that reads a superseded
 * case reports a number for a gold the contract has already replaced.
 * `SUCC4_SUPERSESSIONS` below is an audit view over ids and reasons; it holds
 * no case content, so importing it cannot put a case back in front of a
 * model.
 *
 * ## `from` and `grounds` are different questions
 *
 * `from` is **when the case was found** -- during the 121 readings, during a
 * later batch, or while cross-checking the assembler. `grounds` is **why it
 * has to move**, and they do not follow from one another: `succ-assistant-en-306`
 * was found at assembly and moves on
 * .github/audits/memory-eval-gold-contract-2026-08-27.md §12.2, while
 * `succ-durable-en-20` was found in the 121 and moves on both sections of
 * .github/audits/memory-eval-gold-contract-2026-08-27.md -- §12.1 and §12.2.
 *
 * `grounds` is a list because five cases carry both. Their reading formed a
 * contract rule *and* changed the gold -- `succ-durable-en-20` is the clearest:
 * its two fact values sat in different user turns, which is what
 * `gold-evidence-covers-fact` was written for, and fixing it moved the anchor
 * and dropped a value. Collapsing that to one reason loses whichever half is
 * dropped, and .github/audits/memory-eval-gold-contract-2026-08-27.md §12.2 is
 * categorical about the half it would lose.
 *
 * ## Where each field comes from
 *
 * The rows are generated from the review records -- `SUCC4_B_PLUS_MOVES` for
 * the case and its `from`, `readings.ts` and the `gold-corrected-*` rule ids
 * for the gold change, and the five replacement tranches for the id -- and
 * then written out, because a manifest that is recomputed on import is not a
 * record of anything. `tests/memoryEvalSucc4Transition.test.mjs` re-derives
 * every field from those records and fails on any difference, so the file
 * cannot drift from the reviews it was made from.
 */

/** The audit sections a transition can rest on. Both may apply at once. */
export type Succ4TransitionGround =
    | "section-12.1-rule-exposure"
    | "section-12.2-gold-change";

export type Succ4Transition = {
    originalId: string;
    replacementId: string;
    /** Where the case was found, not why it moves. */
    from: "judgement-121" | "batch" | "assembly";
    /** Why it moves. Never empty; two entries where both apply. */
    grounds: readonly Succ4TransitionGround[];
    auditRef: string;
};

/**
 * The 103 transitions, by cell and then by original id.
 *
 * Ordered for reading rather than in the order the reviews happened; `from`
 * carries that.
 */
export const SUCC4_TRANSITIONS: readonly Succ4Transition[] = [
    {
        originalId: "succ-assistant-en-301",
        replacementId: "succ-assistant-en-403",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-assistant-en-302",
        replacementId: "succ-assistant-en-404",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-assistant-en-303",
        replacementId: "succ-assistant-en-405",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-assistant-en-304",
        replacementId: "succ-assistant-en-406",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-assistant-en-305",
        replacementId: "succ-assistant-en-407",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure", "section-12.2-gold-change"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-assistant-en-306",
        replacementId: "succ-assistant-en-401",
        from: "assembly",
        grounds: ["section-12.2-gold-change"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.9",
    },
    {
        originalId: "succ-assistant-en-307",
        replacementId: "succ-assistant-en-402",
        from: "assembly",
        grounds: ["section-12.2-gold-change"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.9",
    },
    {
        originalId: "succ-assistant-ko-301",
        replacementId: "succ-assistant-ko-402",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-assistant-ko-302",
        replacementId: "succ-assistant-ko-403",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-assistant-ko-303",
        replacementId: "succ-assistant-ko-404",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-assistant-ko-304",
        replacementId: "succ-assistant-ko-405",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-assistant-ko-305",
        replacementId: "succ-assistant-ko-406",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure", "section-12.2-gold-change"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-assistant-ko-306",
        replacementId: "succ-assistant-ko-407",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-assistant-ko-308",
        replacementId: "succ-assistant-ko-401",
        from: "judgement-121",
        grounds: ["section-12.2-gold-change"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.2",
    },
    {
        originalId: "succ-durable-en-10",
        replacementId: "succ-durable-en-407",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-101",
        replacementId: "succ-durable-en-424",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-108",
        replacementId: "succ-durable-en-425",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-109",
        replacementId: "succ-durable-en-426",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-110",
        replacementId: "succ-durable-en-427",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-111",
        replacementId: "succ-durable-en-428",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-112",
        replacementId: "succ-durable-en-429",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-113",
        replacementId: "succ-durable-en-430",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-116",
        replacementId: "succ-durable-en-431",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-122",
        replacementId: "succ-durable-en-432",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-128",
        replacementId: "succ-durable-en-433",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-129",
        replacementId: "succ-durable-en-401",
        from: "batch",
        grounds: ["section-12.2-gold-change"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.8",
    },
    {
        originalId: "succ-durable-en-130",
        replacementId: "succ-durable-en-434",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-146",
        replacementId: "succ-durable-en-435",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-153",
        replacementId: "succ-durable-en-436",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-160",
        replacementId: "succ-durable-en-437",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-162",
        replacementId: "succ-durable-en-438",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-164",
        replacementId: "succ-durable-en-439",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-166",
        replacementId: "succ-durable-en-440",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-167",
        replacementId: "succ-durable-en-441",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-168",
        replacementId: "succ-durable-en-442",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-173",
        replacementId: "succ-durable-en-443",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-177",
        replacementId: "succ-durable-en-444",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-178",
        replacementId: "succ-durable-en-445",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-181",
        replacementId: "succ-durable-en-446",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-19",
        replacementId: "succ-durable-en-403",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure", "section-12.2-gold-change"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-199",
        replacementId: "succ-durable-en-447",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-20",
        replacementId: "succ-durable-en-408",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure", "section-12.2-gold-change"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-21",
        replacementId: "succ-durable-en-409",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-22",
        replacementId: "succ-durable-en-410",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-23",
        replacementId: "succ-durable-en-411",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-26",
        replacementId: "succ-durable-en-412",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-3",
        replacementId: "succ-durable-en-404",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-302",
        replacementId: "succ-durable-en-448",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-303",
        replacementId: "succ-durable-en-449",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-304",
        replacementId: "succ-durable-en-450",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-305",
        replacementId: "succ-durable-en-451",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-308",
        replacementId: "succ-durable-en-452",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-311",
        replacementId: "succ-durable-en-453",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-312",
        replacementId: "succ-durable-en-454",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-316",
        replacementId: "succ-durable-en-402",
        from: "batch",
        grounds: ["section-12.2-gold-change"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.8",
    },
    {
        originalId: "succ-durable-en-320",
        replacementId: "succ-durable-en-455",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-38",
        replacementId: "succ-durable-en-413",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-52",
        replacementId: "succ-durable-en-414",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-58",
        replacementId: "succ-durable-en-415",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-61",
        replacementId: "succ-durable-en-416",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-62",
        replacementId: "succ-durable-en-417",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-63",
        replacementId: "succ-durable-en-418",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-65",
        replacementId: "succ-durable-en-419",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-7",
        replacementId: "succ-durable-en-405",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-73",
        replacementId: "succ-durable-en-420",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-76",
        replacementId: "succ-durable-en-421",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-8",
        replacementId: "succ-durable-en-406",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-88",
        replacementId: "succ-durable-en-422",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-en-90",
        replacementId: "succ-durable-en-423",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-109",
        replacementId: "succ-durable-ko-403",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-111",
        replacementId: "succ-durable-ko-404",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-112",
        replacementId: "succ-durable-ko-405",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-113",
        replacementId: "succ-durable-ko-406",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-118",
        replacementId: "succ-durable-ko-407",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-12",
        replacementId: "succ-durable-ko-402",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure", "section-12.2-gold-change"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-126",
        replacementId: "succ-durable-ko-408",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-127",
        replacementId: "succ-durable-ko-409",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-128",
        replacementId: "succ-durable-ko-410",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-129",
        replacementId: "succ-durable-ko-411",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-130",
        replacementId: "succ-durable-ko-412",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-140",
        replacementId: "succ-durable-ko-413",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-153",
        replacementId: "succ-durable-ko-414",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-159",
        replacementId: "succ-durable-ko-415",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-16",
        replacementId: "succ-durable-ko-416",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-161",
        replacementId: "succ-durable-ko-417",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-162",
        replacementId: "succ-durable-ko-418",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-172",
        replacementId: "succ-durable-ko-419",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-173",
        replacementId: "succ-durable-ko-420",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-181",
        replacementId: "succ-durable-ko-421",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-199",
        replacementId: "succ-durable-ko-422",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-20",
        replacementId: "succ-durable-ko-423",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-200",
        replacementId: "succ-durable-ko-424",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-301",
        replacementId: "succ-durable-ko-401",
        from: "judgement-121",
        grounds: ["section-12.2-gold-change"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.2",
    },
    {
        originalId: "succ-durable-ko-313",
        replacementId: "succ-durable-ko-425",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-323",
        replacementId: "succ-durable-ko-426",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-326",
        replacementId: "succ-durable-ko-427",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-50",
        replacementId: "succ-durable-ko-428",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-51",
        replacementId: "succ-durable-ko-429",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-52",
        replacementId: "succ-durable-ko-430",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-68",
        replacementId: "succ-durable-ko-431",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-durable-ko-84",
        replacementId: "succ-durable-ko-432",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-injection-en-119",
        replacementId: "succ-injection-en-401",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
    {
        originalId: "succ-injection-en-123",
        replacementId: "succ-injection-en-402",
        from: "judgement-121",
        grounds: ["section-12.1-rule-exposure"],
        auditRef: ".github/audits/memory-eval-gold-contract-2026-08-27.md §12.5",
    },
];

/** Every original the canonical `succ-4` set must not contain. */
export const SUCC4_SUPERSEDED_CASE_IDS: ReadonlySet<string> = new Set(
    SUCC4_TRANSITIONS.map((transition) => transition.originalId)
);

/** Every replacement the canonical `succ-4` set must contain. */
export const SUCC4_REPLACEMENT_CASE_IDS: ReadonlySet<string> = new Set(
    SUCC4_TRANSITIONS.map((transition) => transition.replacementId)
);

/**
 * The audit view: what left, what took its place, and on what grounds.
 *
 * Ids and reasons only. No case content passes through here, which is what
 * keeps a superseded conversation from reaching a scorer by way of an audit
 * import.
 */
export const SUCC4_SUPERSESSIONS: readonly {
    superseded: string;
    supersededBy: string;
    grounds: readonly Succ4TransitionGround[];
    foundAt: Succ4Transition["from"];
    auditRef: string;
}[] = SUCC4_TRANSITIONS.map((transition) => ({
    superseded: transition.originalId,
    supersededBy: transition.replacementId,
    grounds: transition.grounds,
    foundAt: transition.from,
    auditRef: transition.auditRef,
}));

/**
 * What a digest over this manifest hashes.
 *
 * Freezing `succ-4` freezes which 1,150 cases it holds. It does not, on its
 * own, freeze *which original each replacement stands for* -- that pairing
 * lives here, and a dataset digest would be identical whether
 * `succ-durable-ko-403` replaced `ko-109` or `ko-111`. So the pairing gets a
 * digest of its own, and the composition pins it.
 *
 * Sorted by original id, so the order the rows are written in is not part of
 * the identity. `grounds` is sorted too: it is a set of reasons, and a manifest
 * that listed them the other way round is the same manifest.
 *
 * No hashing here -- this module stays free of `node:crypto` like the rest of
 * the eval schema.
 */
export function succ4TransitionFingerprintInput(
    transitions: readonly Succ4Transition[]
): string {
    return [...transitions]
        .sort((a, b) =>
            a.originalId < b.originalId ? -1 : a.originalId > b.originalId ? 1 : 0
        )
        .map((transition) =>
            [
                `original=${transition.originalId}`,
                `replacement=${transition.replacementId}`,
                `from=${transition.from}`,
                `grounds=${[...transition.grounds].sort().join("|")}`,
                `auditRef=${transition.auditRef}`,
            ].join("\u0000")
        )
        .join("\u0001");
}

/** The transition for one original, or `undefined`. */
export function succ4TransitionFor(originalId: string): Succ4Transition | undefined {
    return SUCC4_TRANSITIONS.find(
        (transition) => transition.originalId === originalId
    );
}

/**
 * The split drawn by .github/audits/memory-eval-gold-contract-2026-08-27.md §12.1 and §12.2,
 * as counts.
 *
 * `bothGrounds` is not a rounding error to be folded into one of the other
 * two: a case that formed a rule and had its gold changed answers to both
 * sections, and a report that assigns it to one of them is wrong about the
 * other.
 */
export function succ4TransitionCounts(): {
    total: number;
    ruleExposureOnly: number;
    goldChangeOnly: number;
    bothGrounds: number;
} {
    let ruleExposureOnly = 0;
    let goldChangeOnly = 0;
    let bothGrounds = 0;
    for (const transition of SUCC4_TRANSITIONS) {
        const exposure = transition.grounds.includes("section-12.1-rule-exposure");
        const change = transition.grounds.includes("section-12.2-gold-change");
        if (exposure && change) bothGrounds += 1;
        else if (exposure) ruleExposureOnly += 1;
        else goldChangeOnly += 1;
    }
    return {
        total: SUCC4_TRANSITIONS.length,
        ruleExposureOnly,
        goldChangeOnly,
        bothGrounds,
    };
}
