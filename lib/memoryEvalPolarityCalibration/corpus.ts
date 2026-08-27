/**
 * The corpus `K` is chosen on, and nothing else.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §9. **`K` is not
 * chosen on `mem-eval-succ-3`.** Picking a scoring parameter from a decision
 * set's own output tunes the scoring to the result, and under the B+ contract
 * every case used to pick it becomes a case that wrote the rule — which would
 * cost `succ-4` the sample it is being built to have.
 *
 * So these sentences exist for this measurement alone. None of them is in any
 * dataset, none will be scored, and nothing here is a memory the product would
 * ever store.
 *
 * ## What each item asks
 *
 * One question: **does this statement assert `factValueAll` with
 * `goldPolarity`?** `assertsGold` is that answer, judged by a person before
 * any distance was computed.
 *
 * The five shapes are not decoration. Two of them exist to show where a
 * proximity rule *cannot* reach:
 *
 *   * a **correction** puts the marker next to the value being replaced, not
 *     the one being asserted — "전주가 아니라 정읍이다" affirms 정읍 with 아니
 *     two characters away. These cap `K` from above.
 *   * a **double negative** cancels, and no distance can see that.
 *   * a **conditional** asserts nothing at all, which a marker's absence reads
 *     as an affirmation.
 *
 * If the measurement says those shapes cannot be handled, the answer is not a
 * cleverer distance — it is that a gold may not rest on them, written into the
 * contract.
 */

export type PolarityShape =
    | "affirmative"
    | "negative"
    | "double_negative"
    | "correction"
    | "conditional";

export type PolarityCalibrationCase = {
    id: string;
    language: "ko" | "en";
    shape: PolarityShape;
    /** A statement of the kind an extractor writes, not a user utterance. */
    statement: string;
    factValueAll: readonly string[];
    goldPolarity: "affirms" | "denies";
    /**
     * The human answer, recorded before any distance was measured.
     *
     * **Draft.** Transcribed for review — a person confirms each line before
     * `K` rests on it (`AGENTS.md`「기록을 채우는 경계는 관측과 판정입니다」).
     */
    assertsGold: boolean;
    /** Why, where the answer is not obvious. */
    note?: string;
};

export const POLARITY_CALIBRATION_CASES: readonly PolarityCalibrationCase[] = [
    /* ---------------------------------------------- ko · affirmative ---- */
    {
        id: "cal-ko-aff-1",
        language: "ko",
        shape: "affirmative",
        statement: "사용자는 인천에 산다.",
        factValueAll: ["인천"],
        goldPolarity: "affirms",
        assertsGold: true,
    },
    {
        id: "cal-ko-aff-2",
        language: "ko",
        shape: "affirmative",
        statement: "사용자는 인천에 살며 이사 계획이 없다.",
        factValueAll: ["인천"],
        goldPolarity: "affirms",
        assertsGold: true,
        note: "표지 없이 있지만 걸리는 곳은 이사 계획입니다. 전역 스캔이 틀리는 문장.",
    },
    {
        id: "cal-ko-aff-3",
        language: "ko",
        shape: "affirmative",
        statement: "사용자는 제빵사로 일하며 야간 근무는 하지 않는다.",
        factValueAll: ["제빵"],
        goldPolarity: "affirms",
        assertsGold: true,
        note: "않이 걸리는 곳은 야간 근무.",
    },
    {
        id: "cal-ko-aff-4",
        language: "ko",
        shape: "affirmative",
        statement: "사용자는 견과류 알레르기가 있어 대체 메뉴를 아직 정하지 못했다.",
        factValueAll: ["견과류"],
        goldPolarity: "affirms",
        assertsGold: true,
        note: "못이 걸리는 곳은 대체 메뉴.",
    },
    {
        id: "cal-ko-aff-5",
        language: "ko",
        shape: "affirmative",
        statement: "사용자는 부양가족이 둘 있다.",
        factValueAll: ["부양"],
        goldPolarity: "affirms",
        assertsGold: true,
    },
    {
        id: "cal-ko-aff-6",
        language: "ko",
        shape: "affirmative",
        statement: "사용자는 매운 음식을 즐기며 가리는 것이 없다.",
        factValueAll: ["매운"],
        goldPolarity: "affirms",
        assertsGold: true,
        note: "없이 걸리는 곳은 가리는 것.",
    },

    /* ------------------------------------------------- ko · negative ---- */
    {
        id: "cal-ko-neg-1",
        language: "ko",
        shape: "negative",
        statement: "사용자는 인천에 살지 않는다.",
        factValueAll: ["인천"],
        goldPolarity: "denies",
        assertsGold: true,
    },
    {
        id: "cal-ko-neg-2",
        language: "ko",
        shape: "negative",
        statement: "사용자는 견과류 알레르기가 없다.",
        factValueAll: ["견과류"],
        goldPolarity: "denies",
        assertsGold: true,
    },
    {
        id: "cal-ko-neg-3",
        language: "ko",
        shape: "negative",
        statement: "사용자는 한양대학교에 다닌 적이 없다.",
        factValueAll: ["한양대"],
        goldPolarity: "denies",
        assertsGold: true,
        note: "사실값과 표지 사이에 학교에 다닌 적이 — succ-3에서 실제로 놓친 문장.",
    },
    {
        id: "cal-ko-neg-4",
        language: "ko",
        shape: "negative",
        statement: "사용자는 매운 음식을 먹지 못한다.",
        factValueAll: ["매운"],
        goldPolarity: "denies",
        assertsGold: true,
    },
    {
        id: "cal-ko-neg-5",
        language: "ko",
        shape: "negative",
        statement: "사용자에게는 부양할 가족이 없다.",
        factValueAll: ["부양"],
        goldPolarity: "denies",
        assertsGold: true,
    },
    {
        id: "cal-ko-neg-6",
        language: "ko",
        shape: "negative",
        statement:
            "사용자의 집에는 인터넷 회선이 들어오지 않아 온라인 절차를 밟을 수 없다.",
        factValueAll: ["인터넷"],
        goldPolarity: "denies",
        assertsGold: true,
        note: "표지가 회선이 들어오지 뒤에 옵니다 — 정당하지만 먼 경우.",
    },

    /* ------------------------------------------ ko · double negative ---- */
    {
        id: "cal-ko-dbl-1",
        language: "ko",
        shape: "double_negative",
        statement: "사용자가 매운 음식을 못 먹는 것은 아니다.",
        factValueAll: ["매운"],
        goldPolarity: "affirms",
        assertsGold: true,
        note: "이중부정이 상쇄돼 먹을 수 있다는 주장. 거리로는 볼 수 없습니다.",
    },
    {
        id: "cal-ko-dbl-2",
        language: "ko",
        shape: "double_negative",
        statement: "사용자가 인천에 살지 않는 것은 아니다.",
        factValueAll: ["인천"],
        goldPolarity: "affirms",
        assertsGold: true,
        note: "같음.",
    },
    {
        id: "cal-ko-dbl-3",
        language: "ko",
        shape: "double_negative",
        statement: "사용자는 견과류를 피하지 않는다.",
        factValueAll: ["견과류"],
        goldPolarity: "affirms",
        assertsGold: true,
        note: "부정어는 하나지만 피하다의 부정이므로 사실은 긍정.",
    },
    {
        id: "cal-ko-dbl-4",
        language: "ko",
        shape: "double_negative",
        statement: "사용자가 부양가족이 없는 것은 아니다.",
        factValueAll: ["부양"],
        goldPolarity: "affirms",
        assertsGold: true,
    },
    {
        id: "cal-ko-dbl-5",
        language: "ko",
        shape: "double_negative",
        statement: "사용자가 한양대학교를 다니지 않은 것은 아니다.",
        factValueAll: ["한양대"],
        goldPolarity: "affirms",
        assertsGold: true,
    },
    {
        id: "cal-ko-dbl-6",
        language: "ko",
        shape: "double_negative",
        statement: "사용자에게 인터넷이 없는 것은 아니다.",
        factValueAll: ["인터넷"],
        goldPolarity: "affirms",
        assertsGold: true,
    },

    /* ----------------------------------------------- ko · correction ---- */
    {
        id: "cal-ko-cor-1",
        language: "ko",
        shape: "correction",
        statement: "사용자의 출신지는 전주가 아니라 정읍이다.",
        factValueAll: ["정읍"],
        goldPolarity: "affirms",
        assertsGold: true,
        note: "표지는 대체되는 값(전주)에 걸립니다. K의 상한을 정하는 형태.",
    },
    {
        id: "cal-ko-cor-2",
        language: "ko",
        shape: "correction",
        statement: "사용자의 나이는 마흔이 아니라 서른이다.",
        factValueAll: ["서른"],
        goldPolarity: "affirms",
        assertsGold: true,
        note: "같음.",
    },
    {
        id: "cal-ko-cor-3",
        language: "ko",
        shape: "correction",
        statement: "사용자는 서울이 아니라 부산에 산다.",
        factValueAll: ["부산"],
        goldPolarity: "affirms",
        assertsGold: true,
        note: "같음.",
    },
    {
        id: "cal-ko-cor-4",
        language: "ko",
        shape: "correction",
        statement: "사용자는 채식주의자가 아니다.",
        factValueAll: ["채식"],
        goldPolarity: "denies",
        assertsGold: true,
    },
    {
        id: "cal-ko-cor-5",
        language: "ko",
        shape: "correction",
        statement: "사용자는 개발자가 아니며 코드 예시는 도움이 되지 않는다.",
        factValueAll: ["개발"],
        goldPolarity: "denies",
        assertsGold: true,
    },
    {
        id: "cal-ko-cor-6",
        language: "ko",
        shape: "correction",
        statement: "사용자는 대구에 산 적이 없다.",
        factValueAll: ["대구"],
        goldPolarity: "denies",
        assertsGold: true,
    },

    /* ---------------------------------------------- ko · conditional ---- */
    {
        id: "cal-ko-cnd-1",
        language: "ko",
        shape: "conditional",
        statement: "사용자가 해외로 이주하면 국민연금 반환일시금 대상이 될 수 있다.",
        factValueAll: ["해외"],
        goldPolarity: "affirms",
        assertsGold: false,
        note: "가정입니다. 사실을 주장하지 않으므로 어떤 polarity도 성립하지 않습니다.",
    },
    {
        id: "cal-ko-cnd-2",
        language: "ko",
        shape: "conditional",
        statement: "사용자가 사업자를 낸다면 부가가치세 신고 의무가 생긴다.",
        factValueAll: ["사업자"],
        goldPolarity: "affirms",
        assertsGold: false,
        note: "같음.",
    },
    {
        id: "cal-ko-cnd-3",
        language: "ko",
        shape: "conditional",
        statement: "사용자가 견과류 알레르기가 있다면 해당 메뉴는 제외해야 한다.",
        factValueAll: ["견과류"],
        goldPolarity: "affirms",
        assertsGold: false,
    },
    {
        id: "cal-ko-cnd-4",
        language: "ko",
        shape: "conditional",
        statement: "사용자가 인천에 살지 않는다면 다른 권역으로 다시 골라야 한다.",
        factValueAll: ["인천"],
        goldPolarity: "denies",
        assertsGold: false,
        note: "표지가 가까이 있지만 조건절이라 주장이 아닙니다.",
    },
    {
        id: "cal-ko-cnd-5",
        language: "ko",
        shape: "conditional",
        statement: "사용자가 부양가족이 없을 경우 해당 수당은 적용되지 않는다.",
        factValueAll: ["부양"],
        goldPolarity: "denies",
        assertsGold: false,
        note: "같음.",
    },
    {
        id: "cal-ko-cnd-6",
        language: "ko",
        shape: "conditional",
        statement: "사용자가 유학을 간다면 건강보험 자격을 확인해야 한다.",
        factValueAll: ["유학"],
        goldPolarity: "affirms",
        assertsGold: false,
    },

    /* ---------------------------------------------- en · affirmative ---- */
    {
        id: "cal-en-aff-1",
        language: "en",
        shape: "affirmative",
        statement: "The user lives in Ottawa.",
        factValueAll: ["ottawa"],
        goldPolarity: "affirms",
        assertsGold: true,
    },
    {
        id: "cal-en-aff-2",
        language: "en",
        shape: "affirmative",
        statement: "The user lives in Ottawa and has no plans to move.",
        factValueAll: ["ottawa"],
        goldPolarity: "affirms",
        assertsGold: true,
        note: "The marker belongs to the plans. Whole-statement scanning fails here.",
    },
    {
        id: "cal-en-aff-3",
        language: "en",
        shape: "affirmative",
        statement: "The user is teetotal and does not drink at work events.",
        factValueAll: ["teetotal"],
        goldPolarity: "affirms",
        assertsGold: true,
    },
    {
        id: "cal-en-aff-4",
        language: "en",
        shape: "affirmative",
        statement: "The user has a shellfish allergy and cannot eat prawns.",
        factValueAll: ["shellfish"],
        goldPolarity: "affirms",
        assertsGold: true,
        note: "cannot carries no listed marker, but n't and not are near words like it.",
    },
    {
        id: "cal-en-aff-5",
        language: "en",
        shape: "affirmative",
        statement: "The user has two siblings and no children.",
        factValueAll: ["sibling"],
        goldPolarity: "affirms",
        assertsGold: true,
        note: "The marker belongs to children, six characters away.",
    },
    {
        id: "cal-en-aff-6",
        language: "en",
        shape: "affirmative",
        statement: "The user owns a printer, though it is not connected to the network.",
        factValueAll: ["printer"],
        goldPolarity: "affirms",
        assertsGold: true,
    },

    /* ------------------------------------------------- en · negative ---- */
    {
        id: "cal-en-neg-1",
        language: "en",
        shape: "negative",
        statement: "The user does not live in Ottawa.",
        factValueAll: ["ottawa"],
        goldPolarity: "denies",
        assertsGold: true,
    },
    {
        id: "cal-en-neg-2",
        language: "en",
        shape: "negative",
        statement: "The user is not teetotal.",
        factValueAll: ["teetotal"],
        goldPolarity: "denies",
        assertsGold: true,
    },
    {
        id: "cal-en-neg-3",
        language: "en",
        shape: "negative",
        statement: "The user does not have a shellfish allergy.",
        factValueAll: ["shellfish"],
        goldPolarity: "denies",
        assertsGold: true,
    },
    {
        id: "cal-en-neg-4",
        language: "en",
        shape: "negative",
        statement: "The user has never lived in Ottawa.",
        factValueAll: ["ottawa"],
        goldPolarity: "denies",
        assertsGold: true,
    },
    {
        id: "cal-en-neg-5",
        language: "en",
        shape: "negative",
        statement: "The user does not have access to a printer.",
        factValueAll: ["printer"],
        goldPolarity: "denies",
        assertsGold: true,
        note: "succ-3에서 실제로 놓친 문장. 표지가 사실값보다 앞에 옵니다.",
    },
    {
        id: "cal-en-neg-6",
        language: "en",
        shape: "negative",
        statement: "The user has no siblings.",
        factValueAll: ["sibling"],
        goldPolarity: "denies",
        assertsGold: true,
    },

    /* ------------------------------------------ en · double negative ---- */
    {
        id: "cal-en-dbl-1",
        language: "en",
        shape: "double_negative",
        statement: "It is not true that the user has no siblings.",
        factValueAll: ["sibling"],
        goldPolarity: "affirms",
        assertsGold: true,
        note: "Two markers cancel. No distance can see that.",
    },
    {
        id: "cal-en-dbl-2",
        language: "en",
        shape: "double_negative",
        statement: "The user is not without a printer.",
        factValueAll: ["printer"],
        goldPolarity: "affirms",
        assertsGold: true,
    },
    {
        id: "cal-en-dbl-3",
        language: "en",
        shape: "double_negative",
        statement: "It would be wrong to say the user does not live in Ottawa.",
        factValueAll: ["ottawa"],
        goldPolarity: "affirms",
        assertsGold: true,
    },
    {
        id: "cal-en-dbl-4",
        language: "en",
        shape: "double_negative",
        statement: "The user never denies being teetotal.",
        factValueAll: ["teetotal"],
        goldPolarity: "affirms",
        assertsGold: true,
    },
    {
        id: "cal-en-dbl-5",
        language: "en",
        shape: "double_negative",
        statement: "The user does not avoid shellfish.",
        factValueAll: ["shellfish"],
        goldPolarity: "affirms",
        assertsGold: true,
        note: "One marker, but it negates avoiding, so the fact is affirmed.",
    },
    {
        id: "cal-en-dbl-6",
        language: "en",
        shape: "double_negative",
        statement: "It is not the case that the user has no children.",
        factValueAll: ["children"],
        goldPolarity: "affirms",
        assertsGold: true,
    },

    /* ----------------------------------------------- en · correction ---- */
    {
        id: "cal-en-cor-1",
        language: "en",
        shape: "correction",
        statement: "The user lives in Ottawa, not Manchester.",
        factValueAll: ["ottawa"],
        goldPolarity: "affirms",
        assertsGold: true,
        note: "The marker attaches to the value being replaced. Caps K from above.",
    },
    {
        id: "cal-en-cor-2",
        language: "en",
        shape: "correction",
        statement: "The user is thirty, not forty.",
        factValueAll: ["thirty"],
        goldPolarity: "affirms",
        assertsGold: true,
        note: "Same shape, and the marker is very close.",
    },
    {
        id: "cal-en-cor-3",
        language: "en",
        shape: "correction",
        statement: "The user is an architect, not a surveyor.",
        factValueAll: ["architect"],
        goldPolarity: "affirms",
        assertsGold: true,
    },
    {
        id: "cal-en-cor-4",
        language: "en",
        shape: "correction",
        statement: "The user is not an architect.",
        factValueAll: ["architect"],
        goldPolarity: "denies",
        assertsGold: true,
    },
    {
        id: "cal-en-cor-5",
        language: "en",
        shape: "correction",
        statement: "The user has never lived in Manchester.",
        factValueAll: ["manchester"],
        goldPolarity: "denies",
        assertsGold: true,
    },
    {
        id: "cal-en-cor-6",
        language: "en",
        shape: "correction",
        statement: "The user is not on Pacific time.",
        factValueAll: ["pacific"],
        goldPolarity: "denies",
        assertsGold: true,
    },

    /* ---------------------------------------------- en · conditional ---- */
    {
        id: "cal-en-cnd-1",
        language: "en",
        shape: "conditional",
        statement: "If the user studies abroad, the health cover must be declared.",
        factValueAll: ["abroad"],
        goldPolarity: "affirms",
        assertsGold: false,
        note: "Hypothetical. Nothing is asserted, so no polarity holds.",
    },
    {
        id: "cal-en-cnd-2",
        language: "en",
        shape: "conditional",
        statement: "Should the user have a shellfish allergy, those dishes come out.",
        factValueAll: ["shellfish"],
        goldPolarity: "affirms",
        assertsGold: false,
    },
    {
        id: "cal-en-cnd-3",
        language: "en",
        shape: "conditional",
        statement: "If the user does not live in Ottawa, the region needs choosing again.",
        factValueAll: ["ottawa"],
        goldPolarity: "denies",
        assertsGold: false,
        note: "The marker is close, but a conditional asserts nothing.",
    },
    {
        id: "cal-en-cnd-4",
        language: "en",
        shape: "conditional",
        statement: "Were the user an architect, the drawings would need no explanation.",
        factValueAll: ["architect"],
        goldPolarity: "affirms",
        assertsGold: false,
    },
    {
        id: "cal-en-cnd-5",
        language: "en",
        shape: "conditional",
        statement: "If the user had no printer, a postal form would not be an option.",
        factValueAll: ["printer"],
        goldPolarity: "denies",
        assertsGold: false,
    },
    {
        id: "cal-en-cnd-6",
        language: "en",
        shape: "conditional",
        statement: "Unless the user is teetotal, the bar package can stay.",
        factValueAll: ["teetotal"],
        goldPolarity: "affirms",
        assertsGold: false,
    },
];
