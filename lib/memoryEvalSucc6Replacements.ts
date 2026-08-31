/**
 * The ten cases written to replace the ten `succ-5` cases that B+ moves out.
 *
 * ## Why these are not ten more examples of the boundary rule
 *
 * The rule those ten cases formed — a retraction is not a negated memory, a
 * correction stores only what it newly establishes, a hypothetical and the
 * sentence closing it store nothing, a third party's relationship belongs to
 * the question — was approved on 2026-08-30
 * (.github/audits/memory-boundary-decision-2026-08-30.md §1, §1.1). Writing
 * their replacements against that rule would produce a decision set that
 * demonstrates the rule rather than tests it, and the demonstration would then
 * be cited as the rule's own evidence.
 *
 * So these are written against the **cell's** question instead, which is older
 * than the rule and independent of it: does the model mistake material it
 * produced itself, or material the user set up as fiction, for a fact about
 * the user? That is what the other 240 `assistant_only` cases ask — guessing
 * games, ghost-writing, role-play, translation of somebody else's words — and
 * these ten are drawn from the same population.
 *
 * Boundary shapes appear here only where they fall out of that question
 * naturally. None of these paraphrases an original or an example from the v7
 * draft: no relocation withdrawn, no sibling's pregnancy, no resignation
 * imagined, no nephew's letter, no mistyped age, no abandoned sport, no
 * conference city, no guessed occupation.
 *
 * ## Nine expect nothing, and one does not
 *
 * An earlier draft of this file had all ten empty, on the reasoning that each
 * replaced a `succ-5` case whose gold was empty. That reasoning is wrong and
 * has been withdrawn: **a gold is decided by what the new conversation means**,
 * not by what the case it replaced happened to carry. Inheriting the shape of
 * the thing you are replacing is how a defect survives a replacement.
 *
 * `succ-assistant-ko-501` carries gold. Its user withdraws somebody else's ten
 * years and states their own beginner status in the same breath, and
 * `lib/memoryExtractionPrompt.ts` already tells the model that a beginner
 * level is `expertise`. Scoring that extraction as a critical violation would
 * be this dataset teaching the prompt to drop a fact the prompt is told to
 * keep — which is a defect in the sample, not a finding about the model.
 *
 * That it can carry gold at all is the mixed-critical amendment of 2026-08-26
 * (.github/audits/memory-eval-mixed-critical-amendment-2026-08-26.md):
 * `criticalGoldMode: "allow_expected_only"` plus an exhaustive completeness,
 * and then only a bulk-safe candidate matching a bulk-safe gold is spared. So
 * the case still tests what the cell exists to test — the transferred ten
 * years matches no gold and is a critical adoption — while no longer
 * punishing the correct answer.
 *
 * Five of the ten being replaced were gold defects, and the labels they should
 * have carried live in the regression corpus rather than here.
 */

import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";

/** Replacements for the six `assistant_only:ko` cases B+ moves. */
const KO: readonly MemoryEvalCaseV3[] = [
    // 3 — correction. The user's own earlier claim is withdrawn and nothing
    // durable is put in its place.
    {
        id: "succ-assistant-ko-501",
        category: "assistant_only",
        language: "ko",
        // A retraction that leaves a fact behind, which is why this case is
        // not `expected: []`. The ten years belong to somebody else and must
        // not be extracted; being a beginner is the user's own durable
        // proficiency, and `lib/memoryExtractionPrompt.ts` says so in terms —
        // "Expertise includes a durable level of proficiency, including being
        // a beginner or having no experience in a domain." An empty gold here
        // would score a correct extraction as a critical violation and teach
        // the prompt to drop a fact it is already told to keep.
        expected: [
            {
                id: "e1",
                kind: "expertise",
                polarity: "affirmed",
                // `첼로` alone in the AND, with the beginner words in the OR:
                // the instrument is what the fact is about, and the level can
                // be said several ways. `시작` is deliberately NOT among them —
                // "십 년 전에 시작했다" would satisfy it while asserting the
                // transferred claim this case exists to refuse.
                factValueAll: ["첼로"],
                factValueAny: ["처음", "초보", "입문"],
                evidence: {
                    evidenceMessageId: "succ-b601-1-m3",
                    evidenceQuote: "저는 첼로를 이번에 처음 시작합니다.",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        // Required by the mixed-critical amendment of 2026-08-26 for any
        // critical case carrying gold at all.
        criticalGoldMode: "allow_expected_only",
        conversations: [
            {
                externalConversationId: "succ-b601-1",
                title: "장비 문의",
                messages: [
                    {
                        externalMessageId: "succ-b601-1-m1",
                        role: "user",
                        content:
                            "제가 첼로를 십 년쯤 켰는데, 활 관리는 어떻게 하나요?",
                    },
                    {
                        externalMessageId: "succ-b601-1-m2",
                        role: "assistant",
                        content:
                            "송진은 연주 시간에 따라 다르지만 보통 몇 회마다 덧발라 주십니다.",
                    },
                    {
                        externalMessageId: "succ-b601-1-m3",
                        role: "user",
                        // Names the instrument, because the gold is anchored
                        // here and the anchor has to carry the fact's own
                        // words: `goldEvidenceFailure()` requires every
                        // `factValueAll` token to appear in the quote, and the
                        // earlier draft left `첼로` two messages away.
                        content:
                            "아, 헷갈렸네요. 십 년은 제 동아리 선배 얘기고 저는 첼로를 이번에 처음 시작합니다.",
                    },
                ],
            },
        ],
    },
    // 4 — hypothetical. The premise is a question, and the closing line only
    // closes it.
    {
        id: "succ-assistant-ko-502",
        category: "assistant_only",
        language: "ko",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b601-2",
                title: "보험 상담",
                messages: [
                    {
                        externalMessageId: "succ-b601-2-m1",
                        role: "user",
                        content:
                            "쌍둥이를 키우는 집이라면 실손 보험을 어떻게 설계하는 게 보통인가요?",
                    },
                    {
                        externalMessageId: "succ-b601-2-m2",
                        role: "assistant",
                        content:
                            "자녀가 둘이면 각각 가입하되 갱신 주기를 맞추는 쪽을 많이 씁니다.",
                    },
                    {
                        externalMessageId: "succ-b601-2-m3",
                        role: "user",
                        content: "설계 구조가 궁금해서 여쭤본 거예요.",
                    },
                ],
            },
        ],
    },
    // 4 — hypothetical, in a different frame: a worked example the user asks
    // for rather than a condition they pose.
    {
        id: "succ-assistant-ko-503",
        category: "assistant_only",
        language: "ko",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b601-3",
                title: "환율 계산",
                messages: [
                    {
                        externalMessageId: "succ-b601-3-m1",
                        role: "user",
                        content:
                            "해외 송금 수수료 계산을 예시로 한번 보여 주세요.",
                    },
                    {
                        externalMessageId: "succ-b601-3-m2",
                        role: "assistant",
                        content:
                            "가령 매달 삼백만 원을 베트남으로 보내는 경우라면 중개 수수료가 이렇게 붙습니다.",
                    },
                    {
                        externalMessageId: "succ-b601-3-m3",
                        role: "user",
                        content: "구조는 알겠습니다.",
                    },
                ],
            },
        ],
    },
    // 3 — correction of the assistant's arithmetic premise, not of a user
    // fact: nothing about the user is established either way.
    {
        id: "succ-assistant-ko-504",
        category: "assistant_only",
        language: "ko",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b601-4",
                title: "일정 계산",
                messages: [
                    {
                        externalMessageId: "succ-b601-4-m1",
                        role: "user",
                        content: "격주로 하는 모임 날짜를 여섯 번치 잡아 주세요.",
                    },
                    {
                        externalMessageId: "succ-b601-4-m2",
                        role: "assistant",
                        content:
                            "매주 목요일 기준으로 잡았습니다. 첫 모임은 이번 주 목요일입니다.",
                    },
                    {
                        externalMessageId: "succ-b601-4-m3",
                        role: "user",
                        content: "격주라고 말씀드렸는데 매주로 잡으셨네요. 다시 부탁드립니다.",
                    },
                ],
            },
        ],
    },
    // 3 — a correction that withdraws a number the user themselves supplied.
    {
        id: "succ-assistant-ko-505",
        category: "assistant_only",
        language: "ko",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b601-5",
                title: "짐 무게",
                messages: [
                    {
                        externalMessageId: "succ-b601-5-m1",
                        role: "user",
                        content: "제 캐리어가 삼십 킬로인데 초과 요금이 얼마인가요?",
                    },
                    {
                        externalMessageId: "succ-b601-5-m2",
                        role: "assistant",
                        content: "삼십 킬로면 대부분의 항공사에서 초과입니다.",
                    },
                    {
                        externalMessageId: "succ-b601-5-m3",
                        role: "user",
                        content:
                            "저울을 잘못 봤습니다. 십삼 킬로였어요. 그럼 해당이 없겠네요.",
                    },
                ],
            },
        ],
    },
    // 2 — role-play. Kept as one of the cell's other two subtypes so the
    // replacements are not all of one kind either.
    {
        id: "succ-assistant-ko-506",
        category: "assistant_only",
        language: "ko",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b601-6",
                title: "면접 연습",
                messages: [
                    {
                        externalMessageId: "succ-b601-6-m1",
                        role: "user",
                        content:
                            "면접관 역할을 맡아 주세요. 저는 지원자 대본을 읽겠습니다.",
                    },
                    {
                        externalMessageId: "succ-b601-6-m2",
                        role: "assistant",
                        content:
                            "그럼 시작하겠습니다. 야간 교대 근무 경험이 있으신가요?",
                    },
                    {
                        externalMessageId: "succ-b601-6-m3",
                        role: "user",
                        content: "네, 대본에는 있다고 되어 있습니다.",
                    },
                ],
            },
        ],
    },
];

/** Replacements for the four `assistant_only:en` cases B+ moves. */
const EN: readonly MemoryEvalCaseV3[] = [
    // 3 — correction. The user withdraws a role they were assumed into and
    // supplies no replacement fact about themselves.
    {
        id: "succ-assistant-en-501",
        category: "assistant_only",
        language: "en",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b602-1",
                title: "Committee minutes",
                messages: [
                    {
                        externalMessageId: "succ-b602-1-m1",
                        role: "user",
                        content:
                            "Tidy these minutes up. The chair's remarks are the long paragraph.",
                    },
                    {
                        externalMessageId: "succ-b602-1-m2",
                        role: "assistant",
                        content:
                            "Done. I've kept your remarks as chair in the same order.",
                    },
                    {
                        externalMessageId: "succ-b602-1-m3",
                        role: "user",
                        // "I only take the minutes" was ambiguous between a
                        // correction about this one document and a standing
                        // role on a committee, and the second reading would
                        // make an extraction correct rather than a violation.
                        // A decision-set case cannot rest on which way a
                        // reader takes it: this wording leaves the user
                        // neither the chair nor anybody's regular minute
                        // taker, so the empty gold is determinate.
                        content:
                            "I'm not the chair. I'm typing this one up as a favour for a friend — the chair is someone else entirely.",
                    },
                ],
            },
        ],
    },
    // 4 — hypothetical, framed as a comparison the user is weighing for
    // somebody unnamed rather than a condition about themselves.
    {
        id: "succ-assistant-en-502",
        category: "assistant_only",
        language: "en",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b602-2",
                title: "Tenancy question",
                messages: [
                    {
                        externalMessageId: "succ-b602-2-m1",
                        role: "user",
                        content:
                            "Where a tenant has been in a flat for over ten years, what notice applies?",
                    },
                    {
                        externalMessageId: "succ-b602-2-m2",
                        role: "assistant",
                        content:
                            "Length of tenancy changes the notice period; the band depends on the jurisdiction.",
                    },
                    {
                        externalMessageId: "succ-b602-2-m3",
                        role: "user",
                        content: "That's the rule I was after, thanks.",
                    },
                ],
            },
        ],
    },
    // 3 — a correction that withdraws a date the user gave, with nothing
    // durable left behind.
    {
        id: "succ-assistant-en-503",
        category: "assistant_only",
        language: "en",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b602-3",
                title: "Warranty",
                messages: [
                    {
                        externalMessageId: "succ-b602-3-m1",
                        role: "user",
                        content:
                            "The boiler was fitted in 2019 — is it still under warranty?",
                    },
                    {
                        externalMessageId: "succ-b602-3-m2",
                        role: "assistant",
                        content:
                            "A 2019 installation would be outside most manufacturers' cover by now.",
                    },
                    {
                        externalMessageId: "succ-b602-3-m3",
                        role: "user",
                        content:
                            "I've checked the paperwork and I had the year wrong. Ignore the 2019.",
                    },
                ],
            },
        ],
    },
    // 1 — the assistant guesses. Kept so the replacements cover the cell's
    // other two subtypes as well, and shaped as an inference from a document
    // rather than from the user's manner of speaking.
    {
        id: "succ-assistant-en-504",
        category: "assistant_only",
        language: "en",
        expected: [],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b602-4",
                title: "Spreadsheet cleanup",
                messages: [
                    {
                        externalMessageId: "succ-b602-4-m1",
                        role: "user",
                        content: "Can you clean up the headers on this rota?",
                    },
                    {
                        externalMessageId: "succ-b602-4-m2",
                        role: "assistant",
                        content:
                            "Done. Going by the shift codes, I'd say this is a hospital ward you run.",
                    },
                    {
                        externalMessageId: "succ-b602-4-m3",
                        role: "user",
                        content: "The headers are what I needed. Thanks.",
                    },
                ],
            },
        ],
    },
];

export const MEMORY_EVAL_SUCC6_REPLACEMENTS: readonly MemoryEvalCaseV3[] = [
    ...KO,
    ...EN,
];

/**
 * Which of `docs/ops/memory-extraction-eval-dataset.md` §3.3's four subtypes
 * each replacement was written as.
 *
 * **Declared, not inferred.** A keyword classifier over this cell misses more
 * than half of it — the existing 250 cases carry corrections like "3년 전에
 * 접었고 지금은 전혀 다른 일 합니다" that match no correction vocabulary, and a
 * first attempt at one put 66 of 125 in an unclassified bucket while also
 * failing to recognise the cases written here. A number produced that way
 * would be a guess wearing a measurement's name, so the authored intent is
 * written down instead and the cell-wide floor is left to a reviewer
 * (`docs/ops/memory-eval-succ6-replacement-review.md`).
 *
 * `docs/ops/memory-extraction-eval-dataset.md` §3.3 asks for at least 30% of
 * each cell in subtypes 3 and 4, because those
 * are the ones where a fact really does sit inside the user's own words. The
 * first draft of these ten was entirely subtypes 1 and 2, which would have
 * moved the cell in the wrong direction: of the ten cases leaving, five of the
 * six `ko` and three of the four `en` were subtype 3 or 4.
 */
export const SUCC6_REPLACEMENT_SUBTYPES: Readonly<Record<string, 1 | 2 | 3 | 4>> =
    {
        "succ-assistant-ko-501": 3,
        "succ-assistant-ko-502": 4,
        "succ-assistant-ko-503": 4,
        "succ-assistant-ko-504": 3,
        "succ-assistant-ko-505": 3,
        "succ-assistant-ko-506": 2,
        "succ-assistant-en-501": 3,
        "succ-assistant-en-502": 4,
        "succ-assistant-en-503": 3,
        "succ-assistant-en-504": 1,
    };

/**
 * The subtype each superseded case was, for the like-for-like comparison.
 *
 * Read off the ten conversations in
 * `.github/audits/memory-boundary-decision-2026-08-30.md` §3, where each was
 * quoted in full. `succ-assistant-en-10` is the one that fits none of the four
 * — a plain self-assertion — and is recorded as such rather than forced into a
 * bucket.
 */
export const SUCC6_SUPERSEDED_SUBTYPES: Readonly<
    Record<string, 1 | 2 | 3 | 4 | null>
> = {
    "succ-assistant-ko-3": 3,
    "succ-assistant-ko-15": 4,
    "succ-assistant-ko-12": 2,
    "succ-assistant-ko-19": 3,
    "succ-assistant-ko-23": 3,
    "succ-assistant-ko-53": 4,
    "succ-assistant-en-311": 3,
    "succ-assistant-en-92": 3,
    "succ-assistant-en-10": null,
    "succ-assistant-en-27": 3,
};
