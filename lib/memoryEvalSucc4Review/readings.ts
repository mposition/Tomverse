/**
 * The 121 `succ-4` golds a person had to read, and what the reading said.
 *
 * `npm run draft:memory-eval-succ4-golds` finds the anchor and reports what it
 * cannot settle. This is the other half: the settlement. Every entry here is a
 * judgement recorded before any batch was written, so that the 353 golds whose
 * anchor was unambiguous are assigned against a standard that already survived
 * the hard cases rather than one invented as they went past.
 *
 * ## What the marker scan is and is not
 *
 * The drafting tool proposes a polarity by scanning the quote for a negation
 * marker. That is the rule `.github/audits/memory-eval-gold-contract-2026-08-27.md`
 * §9.2 disqualified from scoring, and it is a **suggestion only**: a gold is
 * not reviewed because the scan agreed with it. `agreedWithScan` records
 * whether it happened to, and it is reporting, never evidence.
 *
 * ## The rule these were read against
 *
 * `MEMORY_EVAL_POLARITY_ASSIGNMENT_RULE`: does the memory assert
 * `factValueAll` of the user, or assert that it is not so of them. In practice
 * that is the grammatical polarity of the memory's **main predication**, which
 * is what keeps the readings consistent where the content is not:
 *
 *   * `전화 통화는 싫어해서` — an affirmative predication (the user dislikes
 *     phones), so `affirmed`, even though its consequence is avoidance.
 *   * `야간 운전은 못 합니다` — a denial, so `negated`.
 *   * `Peanuts are a hard no — anaphylaxis` — the memory is *the user has an
 *     anaphylactic peanut allergy*, an affirmative predication, so `affirmed`.
 *     The quote's own phrasing is a refusal of peanuts; the memory is not.
 *   * `견과류 알레르기 없습니다` — a denial of the allergy, so `negated`.
 *
 * The last two together are the pair the field exists for.
 */

export type Succ4GoldReading = {
    caseId: string;
    goldId: string;
    polarity: "affirmed" | "negated";
    /** Set only where the drafted list had to change, with the reason. */
    factValueAll?: readonly string[];
    factValueAny?: readonly string[];
    /** Set only where the proposed anchor was not the right one. */
    evidenceMessageId?: string;
    evidenceQuote?: string;
    /**
     * Whether this gold can be written at all under `mem-score-v3.2`.
     *
     * `blocked` means the reading found something no anchor and no relabelling
     * fixes — recorded here rather than papered over, and reported before any
     * replacement is authored.
     */
    status?: "blocked";
    note?: string;
};

/**
 * Golds whose main predication is a denial.
 *
 * Listed rather than derived: the derivation is the scan, and the scan is not
 * the reviewer.
 */
export const SUCC4_NEGATED: readonly string[] = [
    // durable_facts — the memory denies the token of the user
    "succ-durable-ko-12:e1",
    "succ-durable-ko-16:e2",
    "succ-durable-ko-20:e1",
    "succ-durable-en-8:e1",
    "succ-durable-en-22:e1",
    "succ-durable-ko-50:e1",
    "succ-durable-en-38:e2",
    "succ-durable-en-52:e1",
    "succ-durable-en-62:e1",
    "succ-durable-ko-111:e1",
    "succ-durable-en-88:e2",
    "succ-durable-en-90:e1",
    "succ-durable-en-110:e1",
    "succ-durable-en-112:e1",
    "succ-durable-en-116:e1",
    "succ-durable-ko-126:e1",
    "succ-durable-ko-128:e1",
    "succ-durable-ko-129:e1",
    "succ-durable-ko-130:e1",
    "succ-durable-ko-153:e1",
    "succ-durable-en-128:e1",
    "succ-durable-en-130:e1",
    "succ-durable-en-153:e1",
    "succ-durable-en-164:e1",
    "succ-durable-en-167:e1",
    "succ-durable-ko-199:e1",
    "succ-durable-en-173:e1",
    "succ-durable-en-181:e2",
    "succ-durable-ko-313:g1",
    // assistant_only — the user is correcting an assumption, and the
    // correction is the memory
    "succ-assistant-ko-301:g1",
    "succ-assistant-ko-302:g1",
    "succ-assistant-ko-303:g1",
    "succ-assistant-ko-304:g1",
    "succ-assistant-ko-304:g2",
    "succ-assistant-ko-305:g1",
    "succ-assistant-ko-306:g1",
    "succ-assistant-ko-307:g1",
    "succ-assistant-en-301:g1",
    "succ-assistant-en-302:g1",
    "succ-assistant-en-303:g1",
    "succ-assistant-en-304:g1",
    "succ-assistant-en-304:g2",
    "succ-assistant-en-305:g1",
    "succ-assistant-en-306:g1",
    "succ-assistant-en-307:g1",
];

export const SUCC4_READINGS: readonly Succ4GoldReading[] = [
    /* ---------------------------------------------------------------------
     * Golds no anchor can carry.
     *
     * Both were named by the v5-run1 blind review as golds no model could
     * match, and the reading says why in each case.
     * ------------------------------------------------------------------ */
    {
        caseId: "succ-durable-en-20",
        goldId: "e1",
        polarity: "negated",
        factValueAll: ["evening"],
        evidenceMessageId: "succ-b102-20-m3",
        evidenceQuote:
            "I mention it so you don't suggest things that assume free evenings.",
        note:
            "`father` and `evening` are in different user turns, so no single quote " +
            "covers both and gold-evidence-covers-fact refuses the gold as drafted. " +
            "The durable fact under `constraint` is the evening one; `father` is its " +
            "cause and leaves the token list rather than the case. Reported as a gold " +
            "change, not a quiet narrowing.",
    },
    {
        caseId: "succ-durable-ko-301",
        goldId: "g1",
        polarity: "affirmed",
        factValueAll: ["6시"],
        evidenceMessageId: "succ-b162-1-m1",
        evidenceQuote:
            "아버지가 새벽 시장에 나가셔서 저희 집은 아침 여섯 시면 다들 깨어 있습니다.",
        note:
            "The gold wrote `여섯` and the user wrote `여섯 시`, which canon rewrites to " +
            "`6시` — the Korean numeral rule fires only when a counter follows, so a " +
            "bare numeral token can never match text where it was rewritten. §1③ asks " +
            "fact values to be written in canonical form and this is what that means.",
    },

    /* ---------------------------------------------------------------------
     * Under-specified: the conversation is about whether the thing holds, so
     * a memory of the opposite polarity would carry the same token.
     * ------------------------------------------------------------------ */
    {
        caseId: "succ-assistant-ko-305",
        goldId: "g1",
        polarity: "negated",
        factValueAll: ["견과류"],
        factValueAny: ["알레르기", "알러지"],
        evidenceMessageId: "succ-b164-5-m3",
        evidenceQuote: "저는 견과류 알레르기 없습니다.",
        note:
            "`['견과류']` negated reads as *nuts do not hold of the user*, which is the " +
            "opposite of the fact: the user has no allergy, so nuts are fine. The " +
            "allergy is what is denied, and it joins the gold as an alternative rather " +
            "than a second required token so a model writing 알러지 still matches.",
    },
    {
        caseId: "succ-assistant-en-305",
        goldId: "g1",
        polarity: "negated",
        factValueAll: ["shellfish"],
        factValueAny: ["allergy", "allergic"],
        evidenceMessageId: "succ-b165-5-m3",
        evidenceQuote: "I don't have a shellfish allergy.",
        note:
            "Same shape as its Korean pair. factValueAny rather than a stem: `allerg` " +
            "would be the registry's first entry and a new contract version, and the " +
            "disjunction expresses this gold exactly without one.",
    },

    /* ---------------------------------------------------------------------
     * One gold, two predications of opposite polarity.
     * ------------------------------------------------------------------ */
    {
        caseId: "succ-durable-ko-12",
        goldId: "e1",
        polarity: "negated",
        factValueAll: ["계단"],
        evidenceMessageId: "succ-b101-12-m1",
        evidenceQuote: "어머니가 휠체어를 쓰셔서 계단 있는 곳은 아예 못 갑니다.",
        note:
            "`휠체어` is affirmed of the mother and `계단` is denied of the user, so one " +
            "polarity cannot be right for both. The gold is a `constraint`, and the " +
            "constraint is the stairs; the wheelchair is its cause and leaves the " +
            "token list. Reported.",
    },
    {
        caseId: "succ-durable-en-19",
        goldId: "e1",
        polarity: "negated",
        factValueAll: ["audio"],
        evidenceMessageId: "succ-b102-19-m1",
        evidenceQuote:
            "My partner is deaf, so anything you suggest that's audio-only won't work for us.",
        note:
            "Same shape: `deaf` is affirmed of the partner, `audio` is denied of what " +
            "works. The constraint is the audio one.",
    },

    /* ---------------------------------------------------------------------
     * Corrections. §10.2 rule 6 — a resolved correction anchors on its plain
     * clause, never on the `X가 아니라 Y` clause.
     * ------------------------------------------------------------------ */
    {
        caseId: "succ-assistant-ko-308",
        goldId: "g1",
        polarity: "affirmed",
        evidenceMessageId: "succ-b164-8-m1",
        evidenceQuote: "정읍입니다.",
        note:
            "m3 is `전주가 아니라 정읍이에요`, where the marker sits one character from " +
            "the affirmed value — the shape the calibration corpus showed no distance " +
            "can read. m1 states it plainly and is the anchor.",
    },
];
