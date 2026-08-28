/**
 * What happens to each schema-2 `mustIncludeAny` when polarity becomes a field.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §1② and §12.3.
 * Twenty-three golds carry the disjunction, and it was doing two different
 * jobs:
 *
 *   * on seven, it lists **positive expression variants** of one fact —
 *     `처음 · 초보 · 기초 · 입문` for a beginner. Polarity does not touch that,
 *     so the list carries over as `factValueAny`.
 *   * on sixteen, it hides the **negation** — `인천에 살지 않 · 인천에 거주하지
 *     않 · 인천이 아니`, invented per case. That is what §1② removed. Polarity
 *     carries it now and the list goes.
 *
 * ## Why this is written out and not derived
 *
 * The two jobs correlate with the label but do not follow from it: three
 * negated golds stay in the decision set (`succ-assistant-ko-307`,
 * `succ-assistant-en-306`, `succ-assistant-en-307`), so "negated golds are the
 * ones that move" is close to true and false. An assembler that derived the
 * answer would be right about twenty of twenty-three and wrong quietly.
 *
 * ## Dropping is not always enough
 *
 * Two golds needed more than the list removed. `["견과류"]` negated reads as
 * *nuts do not hold of the user*, the opposite of a user who has no allergy;
 * the allergy is what is denied. Those two get a replacement disjunction from
 * their reading (§11.3), and it is a disjunction rather than a stem because
 * `알레르기 · 알러지` and `allergy · allergic` are a finite spelling choice
 * rather than a productive inflection (§12.3).
 *
 * The other fourteen read correctly as a bare token denied: `["인천"]` negated
 * is *does not live in Ottawa*, `["sibling"]` is *has no siblings*. Nothing
 * had to be added.
 */

export type FactValueAnyDecision =
    | { key: string; carryOver: readonly string[]; why: string }
    | { key: string; drop: true; why: string };

const POSITIVE_VARIANTS = "Positive expression variants of one fact. Polarity does not reach them.";
const NEGATION_HIDDEN =
    "The disjunction was the negation, invented for this case. Polarity carries it now.";

export const SUCC4_FACT_VALUE_ANY: readonly FactValueAnyDecision[] = [
    /* --- carried over: the list was expression variation ------------------ */
    { key: "succ-durable-ko-307:g1", carryOver: ["처음", "초보", "기초", "입문", "배우기 시작", "시작한 지"], why: POSITIVE_VARIANTS },
    { key: "succ-durable-ko-309:g1", carryOver: ["가게", "돕", "도우", "일손"], why: POSITIVE_VARIANTS },
    { key: "succ-durable-ko-311:g2", carryOver: ["상의", "함께", "같이", "공동"], why: POSITIVE_VARIANTS },
    { key: "succ-durable-ko-312:g2", carryOver: ["풀이", "설명", "풀어", "한 줄"], why: POSITIVE_VARIANTS },
    { key: "succ-durable-ko-314:g1", carryOver: ["걷", "산책", "저녁"], why: POSITIVE_VARIANTS },
    { key: "succ-durable-ko-315:g3", carryOver: ["매달", "매월", "달마다"], why: POSITIVE_VARIANTS },
    {
        key: "succ-durable-en-306:g1",
        carryOver: ["first", "beginner", "new to", "no experience", "novice", "just start", "starting out"],
        why:
            POSITIVE_VARIANTS +
            " `no experience` reads as a negation and is one of them: it names a beginner, which is what the gold asserts.",
    },

    /* --- dropped, and the gold reads correctly on its bare token ---------- */
    { key: "succ-assistant-ko-301:g1", drop: true, why: NEGATION_HIDDEN },
    { key: "succ-assistant-ko-302:g1", drop: true, why: NEGATION_HIDDEN },
    { key: "succ-assistant-ko-303:g1", drop: true, why: NEGATION_HIDDEN },
    { key: "succ-assistant-ko-304:g1", drop: true, why: NEGATION_HIDDEN },
    { key: "succ-assistant-ko-304:g2", drop: true, why: NEGATION_HIDDEN },
    {
        key: "succ-assistant-ko-306:g1",
        drop: true,
        why: `${NEGATION_HIDDEN} The reading narrowed factValueAll to 부양가족, which is what is denied.`,
    },
    {
        key: "succ-assistant-ko-307:g1",
        drop: true,
        why: `${NEGATION_HIDDEN} Stays in the decision set, and ["인터넷"] negated is exactly the fact.`,
    },
    { key: "succ-assistant-en-301:g1", drop: true, why: NEGATION_HIDDEN },
    { key: "succ-assistant-en-302:g1", drop: true, why: NEGATION_HIDDEN },
    { key: "succ-assistant-en-303:g1", drop: true, why: NEGATION_HIDDEN },
    { key: "succ-assistant-en-304:g1", drop: true, why: NEGATION_HIDDEN },
    { key: "succ-assistant-en-304:g2", drop: true, why: NEGATION_HIDDEN },
    {
        key: "succ-assistant-en-306:g1",
        drop: true,
        why: `${NEGATION_HIDDEN} Stays, and ["sibling"] negated is exactly the fact.`,
    },
    {
        key: "succ-assistant-en-307:g1",
        drop: true,
        why: `${NEGATION_HIDDEN} Stays, and ["print"] negated is exactly the fact.`,
    },

    /* --- dropped and replaced: the bare token denied said the opposite ---- */
    {
        key: "succ-assistant-ko-305:g1",
        carryOver: ["알레르기", "알러지"],
        why:
            "The negation phrases go, and the allergy replaces them: ['견과류'] negated " +
            "would read as nuts not holding of a user whose point is that they are fine.",
    },
    {
        key: "succ-assistant-en-305:g1",
        carryOver: ["allergy", "allergic"],
        why: "As its Korean pair. A finite spelling choice, so a disjunction and not a stem.",
    },
];
