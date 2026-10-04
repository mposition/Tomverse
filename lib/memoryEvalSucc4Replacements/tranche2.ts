/**
 * The twenty-five `durable_facts:ko` replacements.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12.1 and §12.10.
 * These moved for one reason and not for a defect of their own: they were in
 * front of a reviewer while the polarity assignment rule was being written, so
 * a rule formed on them cannot also be tested by them. Tranche 1 took the
 * eight whose reason for moving was particular; from here the reason is B+ and
 * `movedBecause` records which reading each one contributed.
 *
 * **Not wired into any registry.** `succ-4` is assembled once all 103 exist.
 *
 * ## What a replacement has to do
 *
 * Keep the cell, the gold count, the kinds, the dispositions and the boundary;
 * change the situation and the wording so it is not the original with the
 * nouns swapped; and carry a gold whose predicate is explicit wherever the
 * opposite reading is live in the same conversation. Two of these were
 * rewritten for that last clause after a first pass: `succ-durable-ko-414`
 * named the subscription the user used to hold, and `succ-durable-ko-418`
 * named the guess without the act asked for.
 *
 * Every gold here has its `polarity`, `evidenceMessageId` and `evidenceQuote`
 * written out and reviewed one at a time
 * (.github/audits/memory-eval-gold-contract-2026-08-27.md §12.11). The anchor
 * ids were generated from each conversation by locating the one user message
 * holding the quote, and the generator refused any gold whose quote sat in
 * none or in more than one, or whose quote did not cover every fact value --
 * so the ids here are checked facts, not transcriptions.
 */

import type { Succ4Replacement } from "@/lib/memoryEvalSucc4Replacements/tranche1";

export const SUCC4_TRANCHE_2: readonly Succ4Replacement[] = [
    {
        originalId: "succ-durable-ko-109",
        movedBecause:
            "Read during the 121 while the polarity assignment rule was being written: " +
            "«요금제가 저용량이라» was the reading that showed a token naming the account rather " +
            "than the limit, so it helped form the bar it would otherwise be testing.",
        boundary:
            "A resource limit the user states about their own service, which the model " +
            "has to store as a constraint on what methods can be proposed.",
        differsBy:
            "A connection method rather than a plan tier, and the gold names the method " +
            "itself — which is the fact — instead of the account it sits on.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-403",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "affirmed",
                    factValueAll: ["테더링"],
                    evidence: {
                        evidenceMessageId: "succ-b405-1-m1",
                        evidenceQuote:
                            "집 인터넷 없이 휴대폰 테더링으로만 씁니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-1",
                    title: "연결 방식",
                    messages: [
                        {
                            externalMessageId: "succ-b405-1-m1",
                            role: "user",
                            content:
                                "집 인터넷 없이 휴대폰 테더링으로만 씁니다.",
                        },
                        {
                            externalMessageId: "succ-b405-1-m2",
                            role: "assistant",
                            content:
                                "그러면 용량이 큰 자료는 피해서 정리해 드리겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-111",
        movedBecause:
            "In front of the reviewer during the 121, and its [\"평일 낮\"] is the shape the " +
            "under-specification bar was written for — a period with the predicate left " +
            "to the sentence.",
        boundary:
            "A blanket unavailability over a named part of the day, denied of the user, " +
            "which becomes a scheduling constraint.",
        differsBy:
            "A caregiving window in the afternoon rather than weekday daytime as a " +
            "whole, and the gold names what is denied (일정) beside the period, so a " +
            "memory of the opposite polarity cannot contain every token.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-404",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "negated",
                    factValueAll: ["오후", "일정"],
                    evidence: {
                        evidenceMessageId: "succ-b405-2-m1",
                        evidenceQuote:
                            "오후에는 아이 하원 때문에 어떤 일정도 잡지 못합니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-2",
                    title: "가능한 시간대",
                    messages: [
                        {
                            externalMessageId: "succ-b405-2-m1",
                            role: "user",
                            content:
                                "오후에는 아이 하원 때문에 어떤 일정도 잡지 못합니다.",
                        },
                        {
                            externalMessageId: "succ-b405-2-m2",
                            role: "assistant",
                            content:
                                "오전 시간대로만 후보를 잡겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-112",
        movedBecause:
            "Read during the 121. [\"소음\"] asserts a nuisance of the user rather than a " +
            "fact about them, and settling what it asserted is part of how the " +
            "assignment rule came to be phrased.",
        boundary:
            "A living-situation fact that rules out a whole way of working at home.",
        differsBy:
            "A pet loose in the room rather than neighbours below, and the gold names " +
            "the household member that is the fact rather than the abstract nuisance.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-405",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "affirmed",
                    factValueAll: ["반려묘"],
                    evidence: {
                        evidenceMessageId: "succ-b405-3-m1",
                        evidenceQuote:
                            "집에 반려묘가 있어서 바닥에 부품을 늘어놓는 방식은 못 씁니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-3",
                    title: "작업 공간",
                    messages: [
                        {
                            externalMessageId: "succ-b405-3-m1",
                            role: "user",
                            content:
                                "집에 반려묘가 있어서 바닥에 부품을 늘어놓는 방식은 못 씁니다.",
                        },
                        {
                            externalMessageId: "succ-b405-3-m2",
                            role: "assistant",
                            content:
                                "탁자 위에서 끝나는 순서로 정리해 드릴게요.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-113",
        movedBecause:
            "Read during the 121, where a monthly period carrying 없 in its clause had " +
            "to be settled as affirmed of the user; that settlement is part of the " +
            "rule's formation.",
        boundary:
            "A recurring period the user is unavailable in, stated as a fact about " +
            "their calendar.",
        differsBy:
            "A fortnightly night duty and the morning after it, rather than the first " +
            "week of every month, and the gold names the duty rather than the ordinal " +
            "week.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-406",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "recurring_context",
                    polarity: "affirmed",
                    factValueAll: ["당직"],
                    evidence: {
                        evidenceMessageId: "succ-b405-4-m1",
                        evidenceQuote:
                            "격주 수요일에 야간 당직이 있어서 그 다음 날 오전은 늘 비워 둡니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-4",
                    title: "당직",
                    messages: [
                        {
                            externalMessageId: "succ-b405-4-m1",
                            role: "user",
                            content:
                                "격주 수요일에 야간 당직이 있어서 그 다음 날 오전은 늘 비워 둡니다.",
                        },
                        {
                            externalMessageId: "succ-b405-4-m2",
                            role: "assistant",
                            content:
                                "그 오전은 일정에서 제외하겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-118",
        movedBecause:
            "Read during the 121: «너무 딱딱하지 않게, 친근한 말투로» puts a marked clause beside the " +
            "affirmed one, and deciding that the marker settles nothing is what the " +
            "rule now says.",
        boundary:
            "A tone preference stated with a rejected register beside the wanted one.",
        differsBy:
            "A register named positively (구어체) against a rejected written one, rather " +
            "than warmth against stiffness.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-407",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "tone",
                    polarity: "affirmed",
                    factValueAll: ["구어체"],
                    evidence: {
                        evidenceMessageId: "succ-b405-5-m1",
                        evidenceQuote:
                            "격식 차린 문어체 말고 구어체로 풀어서 설명해 주세요.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-5",
                    title: "문체",
                    messages: [
                        {
                            externalMessageId: "succ-b405-5-m1",
                            role: "user",
                            content:
                                "격식 차린 문어체 말고 구어체로 풀어서 설명해 주세요.",
                        },
                        {
                            externalMessageId: "succ-b405-5-m2",
                            role: "assistant",
                            content:
                                "말하듯이 풀어 쓰겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-126",
        movedBecause:
            "Read during the 121 as the plainest negated case in the cell, and the " +
            "readings that fixed 못 먹습니다 as a denial of the food are part of how the " +
            "rule was written.",
        boundary:
            "A medical dietary exclusion held for review, where the food is denied of the user.",
        differsBy:
            "An intolerance to a different food group, and the condition is named in " +
            "the same sentence so the denial is not carried by the marker alone.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-408",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "negated",
                    factValueAll: ["유제품"],
                    evidence: {
                        evidenceMessageId: "succ-b405-6-m1",
                        evidenceQuote:
                            "유당불내증이라 유제품이 들어간 건 못 먹습니다.",
                    },
                    expectedDisposition: "sensitive_review",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-6",
                    title: "먹지 못하는 것",
                    messages: [
                        {
                            externalMessageId: "succ-b405-6-m1",
                            role: "user",
                            content:
                                "유당불내증이라 유제품이 들어간 건 못 먹습니다.",
                        },
                        {
                            externalMessageId: "succ-b405-6-m2",
                            role: "assistant",
                            content:
                                "유제품을 뺀 쪽으로만 골라 드리겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-127",
        movedBecause:
            "Read during the 121, where [\"냄새\"] named the stimulus and the sentence " +
            "carried 못; separating the sensitivity from what triggers it is one of the " +
            "readings the rule generalises.",
        boundary:
            "A bodily sensitivity stated affirmatively, held for review, which rules " +
            "out a class of situations.",
        differsBy:
            "A hearing condition and a place constraint rather than a chemical " +
            "sensitivity and a product constraint, and the gold names the condition " +
            "rather than the stimulus.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-409",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "affirmed",
                    factValueAll: ["난청"],
                    evidence: {
                        evidenceMessageId: "succ-b405-7-m1",
                        evidenceQuote:
                            "소음성 난청이 있어서 사람 많은 곳에서는 대화를 알아듣지 못합니다.",
                    },
                    expectedDisposition: "sensitive_review",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-7",
                    title: "감각",
                    messages: [
                        {
                            externalMessageId: "succ-b405-7-m1",
                            role: "user",
                            content:
                                "소음성 난청이 있어서 사람 많은 곳에서는 대화를 알아듣지 못합니다.",
                        },
                        {
                            externalMessageId: "succ-b405-7-m2",
                            role: "assistant",
                            content:
                                "조용한 장소를 전제로 안내하겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-128",
        movedBecause:
            "Read during the 121. An ability the user denies of themselves, with the " +
            "denial split across two sentences, was one of the shapes the assignment " +
            "rule had to cover.",
        boundary:
            "An ability the user denies of themselves, which excludes every method that " +
            "assumes it.",
        differsBy:
            "A software skill rather than a licence, and what is excluded is an " +
            "operation rather than a vehicle.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-410",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "negated",
                    factValueAll: ["수식"],
                    evidence: {
                        evidenceMessageId: "succ-b405-8-m1",
                        evidenceQuote:
                            "엑셀 수식은 다룰 줄 모릅니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-8",
                    title: "다룰 줄 모르는 것",
                    messages: [
                        {
                            externalMessageId: "succ-b405-8-m1",
                            role: "user",
                            content:
                                "엑셀 수식은 다룰 줄 모릅니다. 수식을 짜야 하는 방법은 빼주세요.",
                        },
                        {
                            externalMessageId: "succ-b405-8-m2",
                            role: "assistant",
                            content:
                                "손으로 옮겨 적는 방식으로만 안내하겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-129",
        movedBecause:
            "The Korean counterpart of succ-durable-en-129, read in batch 8 and ruled " +
            "negated on 2026-08-28; [\"주말\"] named the period and left the predicate to " +
            "the sentence.",
        boundary:
            "A recurring unavailability over a named period, which the model has to " +
            "store as a scheduling constraint.",
        differsBy:
            "A fixed annual absence rather than every weekend, and the gold names the " +
            "thing denied (일정) beside the period, so the opposite reading cannot " +
            "contain every token.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-411",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "negated",
                    factValueAll: ["연말", "일정"],
                    evidence: {
                        evidenceMessageId: "succ-b405-9-m1",
                        evidenceQuote:
                            "연말 두 주는 일정을 잡을 수 없습니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-9",
                    title: "비는 기간",
                    messages: [
                        {
                            externalMessageId: "succ-b405-9-m1",
                            role: "user",
                            content:
                                "연말 두 주는 일정을 잡을 수 없습니다. 매년 본가에 내려가 있어서요.",
                        },
                        {
                            externalMessageId: "succ-b405-9-m2",
                            role: "assistant",
                            content:
                                "그 기간은 후보에서 빼겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-130",
        movedBecause:
            "Read during the 121: a missing object denied of the user, where the " +
            "reading had to say whether the gold asserts the object or its absence.",
        boundary:
            "A piece of equipment the user does not have, which excludes every method " +
            "that assumes it.",
        differsBy:
            "A scanner in a workspace rather than a printer at home, and the excluded " +
            "step is digitising rather than printing.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-412",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "negated",
                    factValueAll: ["스캐너"],
                    evidence: {
                        evidenceMessageId: "succ-b405-10-m1",
                        evidenceQuote:
                            "작업실에 스캐너가 없어서 종이를 디지털로 옮기는 단계는 제가 못 합니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-10",
                    title: "장비",
                    messages: [
                        {
                            externalMessageId: "succ-b405-10-m1",
                            role: "user",
                            content:
                                "작업실에 스캐너가 없어서 종이를 디지털로 옮기는 단계는 제가 못 합니다.",
                        },
                        {
                            externalMessageId: "succ-b405-10-m2",
                            role: "assistant",
                            content:
                                "사진으로 찍어 올리는 방식으로 바꿔서 안내하겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-140",
        movedBecause:
            "Its second gold was read during the 121 and the case went with it: a trade " +
            "and the season it makes unavailable, off one turn, where 못 sits in the " +
            "second sentence only.",
        boundary:
            "An occupation and the seasonal unavailability that follows from it, kept " +
            "as two golds off one user turn.",
        differsBy:
            "A fishing season at sea rather than an orchard harvest, and each gold is " +
            "anchored on its own sentence rather than both sharing one.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-413",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "occupation",
                    polarity: "affirmed",
                    factValueAll: ["어선"],
                    evidence: {
                        evidenceMessageId: "succ-b405-11-m1",
                        evidenceQuote:
                            "연근해 어선에서 일합니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
                {
                    id: "e2",
                    kind: "recurring_context",
                    polarity: "affirmed",
                    factValueAll: ["조업철"],
                    evidence: {
                        evidenceMessageId: "succ-b405-11-m1",
                        evidenceQuote:
                            "조업철에는 두 달 내내 배에 있어서 아무것도 못 합니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-11",
                    title: "하는 일",
                    messages: [
                        {
                            externalMessageId: "succ-b405-11-m1",
                            role: "user",
                            content:
                                "연근해 어선에서 일합니다. 조업철에는 두 달 내내 배에 있어서 아무것도 못 합니다.",
                        },
                        {
                            externalMessageId: "succ-b405-11-m2",
                            role: "assistant",
                            content:
                                "출항 일정을 먼저 여쭤보고 맞추겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-153",
        movedBecause:
            "Read during the 121: a settled decision to be rid of something, where the " +
            "gold had to say whether it asserts the object or its removal.",
        boundary:
            "A decision already carried out, so the thing is denied of the user going " +
            "forward and will not come back.",
        differsBy:
            "Recurring subscriptions cancelled rather than a television disposed of, " +
            "and the gold names the payment that is denied rather than the subscription " +
            "alone — the conversation says the user did subscribe, so 구독 on its own " +
            "leaves the opposite reading live.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-414",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "decision",
                    polarity: "negated",
                    factValueAll: ["구독", "결제"],
                    evidence: {
                        evidenceMessageId: "succ-b405-12-m1",
                        evidenceQuote:
                            "구독 서비스를 전부 해지했고 다시 결제할 생각은 없습니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-12",
                    title: "정리한 것",
                    messages: [
                        {
                            externalMessageId: "succ-b405-12-m1",
                            role: "user",
                            content:
                                "구독 서비스를 전부 해지했고 다시 결제할 생각은 없습니다.",
                        },
                        {
                            externalMessageId: "succ-b405-12-m2",
                            role: "assistant",
                            content:
                                "무료로 되는 방법만 추리겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-159",
        movedBecause:
            "Read during the 121, where a periodic obligation carrying 못 in its " +
            "consequence clause had to be settled as affirmed of the user's year.",
        boundary:
            "A periodic obligation that blocks a stretch of the user's calendar.",
        differsBy:
            "The opening weeks of a term rather than a quarterly audit, and the " +
            "recurring period is named by the term itself rather than by its length.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-415",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "recurring_context",
                    polarity: "affirmed",
                    factValueAll: ["학기초"],
                    evidence: {
                        evidenceMessageId: "succ-b405-13-m1",
                        evidenceQuote:
                            "학기초 두 주는 상담이 몰려서 다른 일을 못 잡습니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-13",
                    title: "몰리는 시기",
                    messages: [
                        {
                            externalMessageId: "succ-b405-13-m1",
                            role: "user",
                            content:
                                "학기초 두 주는 상담이 몰려서 다른 일을 못 잡습니다.",
                        },
                        {
                            externalMessageId: "succ-b405-13-m2",
                            role: "assistant",
                            content:
                                "그 기간을 피해서 순서를 짜겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-16",
        movedBecause:
            "Read during the 121 as the pair that fixed how one turn can carry an " +
            "affirmed gold and a negated one at once.",
        boundary:
            "Long experience plus an explicit refusal, two golds of opposite sign off " +
            "one user turn.",
        differsBy:
            "A bakery trade rather than welding, and what is refused is a glossary " +
            "rather than the fundamentals, so the negated gold names a deliverable and " +
            "not a depth.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-416",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "expertise",
                    polarity: "affirmed",
                    factValueAll: ["제빵"],
                    evidence: {
                        evidenceMessageId: "succ-b405-14-m1",
                        evidenceQuote:
                            "제빵은 가게에서 십오 년 했습니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
                {
                    id: "e2",
                    kind: "explanation_depth",
                    polarity: "negated",
                    factValueAll: ["용어"],
                    evidence: {
                        evidenceMessageId: "succ-b405-14-m1",
                        evidenceQuote:
                            "용어 풀이는 넣지 마세요.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-14",
                    title: "경력",
                    messages: [
                        {
                            externalMessageId: "succ-b405-14-m1",
                            role: "user",
                            content:
                                "제빵은 가게에서 십오 년 했습니다. 용어 풀이는 넣지 마세요.",
                        },
                        {
                            externalMessageId: "succ-b405-14-m2",
                            role: "assistant",
                            content:
                                "공정 차이 위주로 바로 들어가겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-161",
        movedBecause:
            "Read during the 121: a seasonal peak whose consequence clause carries 없, " +
            "which the rule now settles by asking what the quote asserts of the user.",
        boundary:
            "A seasonal peak that fills a stretch of the user's year.",
        differsBy:
            "A one-month ordering peak in late autumn rather than a three-month summer " +
            "season, and the period is named by the work that causes it.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-417",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "recurring_context",
                    polarity: "affirmed",
                    factValueAll: ["김장철"],
                    evidence: {
                        evidenceMessageId: "succ-b405-15-m1",
                        evidenceQuote:
                            "김장철에 주문이 몰려서 십일월 한 달은 다른 일을 받지 못합니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-15",
                    title: "바쁜 철",
                    messages: [
                        {
                            externalMessageId: "succ-b405-15-m1",
                            role: "user",
                            content:
                                "김장철에 주문이 몰려서 십일월 한 달은 다른 일을 받지 못합니다.",
                        },
                        {
                            externalMessageId: "succ-b405-15-m2",
                            role: "assistant",
                            content:
                                "그 달은 새 일정을 넣지 않겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-162",
        movedBecause:
            "Read during the 121, where [\"모른다\"] is a quotation of what the assistant " +
            "should say rather than a fact of the user, and settling that reading " +
            "shaped the rule.",
        boundary:
            "An instruction about how to behave under uncertainty, stated affirmatively.",
        differsBy:
            "Marking where a guess begins rather than declining to answer, so the " +
            "instruction is about labelling rather than withholding, and the gold names " +
            "the act asked for (표시) beside its subject.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-418",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "communication_style",
                    polarity: "affirmed",
                    factValueAll: ["추측", "표시"],
                    evidence: {
                        evidenceMessageId: "succ-b405-16-m1",
                        evidenceQuote:
                            "추측이 섞일 때는 어디서부터가 추측인지 표시해 주세요.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-16",
                    title: "확신 없을 때",
                    messages: [
                        {
                            externalMessageId: "succ-b405-16-m1",
                            role: "user",
                            content:
                                "추측이 섞일 때는 어디서부터가 추측인지 표시해 주세요.",
                        },
                        {
                            externalMessageId: "succ-b405-16-m2",
                            role: "assistant",
                            content:
                                "확인된 부분과 추정한 부분을 나눠서 쓰겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-172",
        movedBecause:
            "Read during the 121: a condition affirmed of the user in a sentence whose " +
            "consequence clause is negated, which is the pair the rule separates.",
        boundary:
            "A medical condition producing a physical constraint, held for review.",
        differsBy:
            "A tremor limiting fine handling rather than dizziness limiting standing, " +
            "and the constraint is on picking things up rather than on staying upright.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-419",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "affirmed",
                    factValueAll: ["떨림"],
                    evidence: {
                        evidenceMessageId: "succ-b405-17-m1",
                        evidenceQuote:
                            "손 떨림이 있어서 작은 부품을 집어 올리는 작업은 못 합니다.",
                    },
                    expectedDisposition: "sensitive_review",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-17",
                    title: "손",
                    messages: [
                        {
                            externalMessageId: "succ-b405-17-m1",
                            role: "user",
                            content:
                                "손 떨림이 있어서 작은 부품을 집어 올리는 작업은 못 합니다.",
                        },
                        {
                            externalMessageId: "succ-b405-17-m2",
                            role: "assistant",
                            content:
                                "손 대신 도구로 고정하는 방법으로 안내드리겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-173",
        movedBecause:
            "Read during the 121, where a numeric threshold sat in a second sentence " +
            "carrying 안 and the gold named only the body part.",
        boundary:
            "A physical limit stated with a threshold, held for review.",
        differsBy:
            "A knee and a floor count rather than a back and a weight, and the " +
            "threshold is stated as how far the user does go rather than what they must " +
            "not exceed.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-420",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "affirmed",
                    factValueAll: ["무릎"],
                    evidence: {
                        evidenceMessageId: "succ-b405-18-m1",
                        evidenceQuote:
                            "무릎 때문에 계단은 두 층까지만 오를 수 있습니다.",
                    },
                    expectedDisposition: "sensitive_review",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-18",
                    title: "오르내리기",
                    messages: [
                        {
                            externalMessageId: "succ-b405-18-m1",
                            role: "user",
                            content:
                                "무릎 때문에 계단은 두 층까지만 오를 수 있습니다.",
                        },
                        {
                            externalMessageId: "succ-b405-18-m2",
                            role: "assistant",
                            content:
                                "그 이상 올라가지 않는 경로로 잡겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-181",
        movedBecause:
            "Its second gold was read during the 121 and the case went with it: two " +
            "affirmed golds off one turn, where the second is a permission rather than " +
            "a preference.",
        boundary:
            "Long experience plus permission to leave a notation unexplained, two " +
            "affirmed golds off one user turn.",
        differsBy:
            "Paperhanging rather than knitting, and what may be left unexplained is a " +
            "set of site words. The first draft was darkroom chemistry and measured " +
            "0.58 against succ-durable-ko-143, which stays in the corpus and is " +
            "calligraphy of twenty years with its script names left unglossed — the " +
            "same case in a different craft.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-421",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "expertise",
                    polarity: "affirmed",
                    factValueAll: ["도배"],
                    evidence: {
                        evidenceMessageId: "succ-b405-19-m1",
                        evidenceQuote:
                            "도배 일을 스무 해 넘게 했습니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
                {
                    id: "e2",
                    kind: "explanation_depth",
                    polarity: "affirmed",
                    factValueAll: ["초배지"],
                    evidence: {
                        evidenceMessageId: "succ-b405-19-m1",
                        evidenceQuote:
                            "초배지나 정배 같은 말은 풀지 않으셔도 됩니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-19",
                    title: "오래 한 일",
                    messages: [
                        {
                            externalMessageId: "succ-b405-19-m1",
                            role: "user",
                            content:
                                "도배 일을 스무 해 넘게 했습니다. 초배지나 정배 같은 말은 풀지 않으셔도 됩니다.",
                        },
                        {
                            externalMessageId: "succ-b405-19-m2",
                            role: "assistant",
                            content:
                                "현장 용어 그대로 쓰고 순서만 정리하겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-199",
        movedBecause:
            "The case whose hand-copied identifier put ko-199:e1 on the negated list " +
            "when the reading was of ko-199:e2, and whose two golds anchor on different " +
            "messages.",
        boundary:
            "A goal in the first turn and a current-level denial in a later one, so the " +
            "two golds anchor on different messages and only the second is negated.",
        differsBy:
            "Open-water swimming rather than Japanese, and the negated gold names what " +
            "is denied (헤엄) beside where, rather than the skill's topic alone — which " +
            "matters here because the opposite reading is live in the same " +
            "conversation.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-422",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "long_term_goal",
                    polarity: "affirmed",
                    factValueAll: ["오픈워터"],
                    evidence: {
                        evidenceMessageId: "succ-b405-20-m1",
                        evidenceQuote:
                            "내년 봄에 오픈워터 대회를 완주하는 게 목표입니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
                {
                    id: "e2",
                    kind: "expertise",
                    polarity: "negated",
                    factValueAll: ["바다", "헤엄"],
                    evidence: {
                        evidenceMessageId: "succ-b405-20-m3",
                        evidenceQuote:
                            "바다에서는 아직 못 헤엄칩니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-20",
                    title: "목표와 현재",
                    messages: [
                        {
                            externalMessageId: "succ-b405-20-m1",
                            role: "user",
                            content:
                                "내년 봄에 오픈워터 대회를 완주하는 게 목표입니다.",
                        },
                        {
                            externalMessageId: "succ-b405-20-m2",
                            role: "assistant",
                            content:
                                "기간이 정해져 있군요. 현재 상태를 알려 주시겠어요?",
                        },
                        {
                            externalMessageId: "succ-b405-20-m3",
                            role: "user",
                            content:
                                "실내 수영장에서 자유형만 하고 바다에서는 아직 못 헤엄칩니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-20",
        movedBecause:
            "Read during the 121: a hard ceiling stated twice, where both sentences " +
            "carry 못 and the gold had to say what the number is denied of.",
        boundary:
            "A hard numeric ceiling the user restates to make it non-negotiable.",
        differsBy:
            "A deposit ceiling in a tenancy rather than a purchase budget, and the " +
            "number is written in digits so the case does not turn on the numeral rule.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-423",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "negated",
                    factValueAll: ["보증금", "2000"],
                    evidence: {
                        evidenceMessageId: "succ-b405-21-m1",
                        evidenceQuote:
                            "보증금은 2000만원을 넘길 수 없습니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-21",
                    title: "한도",
                    messages: [
                        {
                            externalMessageId: "succ-b405-21-m1",
                            role: "user",
                            content:
                                "보증금은 2000만원을 넘길 수 없습니다. 이 선은 조정이 안 됩니다.",
                        },
                        {
                            externalMessageId: "succ-b405-21-m2",
                            role: "assistant",
                            content:
                                "그 한도 위쪽은 아예 빼고 보겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-200",
        movedBecause:
            "Read during the 121 beside succ-durable-ko-1, where [\"갑각류\"] alone left the " +
            "reader to infer that an allergy — not a preference — is what the memory " +
            "asserts.",
        boundary:
            "A named allergy producing a food exclusion, held for review and affirmed " +
            "of the user.",
        differsBy:
            "A fruit allergy rather than a shellfish one, and the gold names the " +
            "allergy beside the food rather than the food alone.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-424",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "affirmed",
                    factValueAll: ["복숭아", "알레르기"],
                    evidence: {
                        evidenceMessageId: "succ-b405-22-m1",
                        evidenceQuote:
                            "복숭아 알레르기가 있어서 털 있는 과일은 못 먹습니다.",
                    },
                    expectedDisposition: "sensitive_review",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-22",
                    title: "알레르기",
                    messages: [
                        {
                            externalMessageId: "succ-b405-22-m1",
                            role: "user",
                            content:
                                "복숭아 알레르기가 있어서 털 있는 과일은 못 먹습니다.",
                        },
                        {
                            externalMessageId: "succ-b405-22-m2",
                            role: "assistant",
                            content:
                                "그 계열 과일은 빼고 정리하겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-313",
        movedBecause:
            "Read during the 121: a location fact in the first clause and a service " +
            "denial in the second, where [\"배송\"] named the category and not what is " +
            "unavailable.",
        boundary:
            "Where the user lives makes a service unavailable to them, so the denial is " +
            "about the service and not about the place.",
        differsBy:
            "On-site installation in a mountain area rather than same-day delivery on " +
            "an island, and the gold names the service that is denied rather than its " +
            "category.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-425",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "g1",
                    kind: "constraint",
                    polarity: "negated",
                    factValueAll: ["방문", "설치"],
                    evidence: {
                        evidenceMessageId: "succ-b405-23-m1",
                        evidenceQuote:
                            "산간 지역이라 방문 설치가 되는 업체가 거의 없습니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-23",
                    title: "안 되는 서비스",
                    messages: [
                        {
                            externalMessageId: "succ-b405-23-m1",
                            role: "user",
                            content:
                                "산간 지역이라 방문 설치가 되는 업체가 거의 없습니다.",
                        },
                        {
                            externalMessageId: "succ-b405-23-m2",
                            role: "assistant",
                            content:
                                "택배로 받아 직접 다는 제품 위주로 보겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-323",
        movedBecause:
            "Read during the 121, where the relationship is stated in passing inside a " +
            "turn about something else and the reader had to decide which clause the " +
            "gold is anchored on.",
        boundary:
            "A household relationship stated in passing while planning something else, " +
            "and affirmed of the user.",
        differsBy:
            "A move being planned rather than a holiday, and the relative is named as a " +
            "co-resident who sets a room count rather than as a reason to stay home.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-426",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "g1",
                    kind: "relationship",
                    polarity: "affirmed",
                    factValueAll: ["장모"],
                    evidence: {
                        evidenceMessageId: "succ-b405-24-m1",
                        evidenceQuote:
                            "장모님과 같이 살아서 방이 하나 더 필요합니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-24",
                    title: "같이 사는 사람",
                    messages: [
                        {
                            externalMessageId: "succ-b405-24-m1",
                            role: "user",
                            content:
                                "이사할 집을 보고 있습니다. 장모님과 같이 살아서 방이 하나 더 필요합니다.",
                        },
                        {
                            externalMessageId: "succ-b405-24-m2",
                            role: "assistant",
                            content:
                                "방 개수를 조건에 넣고 보겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-ko-326",
        movedBecause:
            "Read during the 121: an accessibility need affirmed of the user in a " +
            "sentence whose consequence clause is negated, which is the pair the rule " +
            "separates.",
        boundary:
            "An accessibility need producing a format constraint, held for review.",
        differsBy:
            "A reading difficulty limiting paragraph length rather than low vision " +
            "limiting type size, and what has to change is sentence length rather than " +
            "tables.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-427",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "g1",
                    kind: "constraint",
                    polarity: "affirmed",
                    factValueAll: ["난독"],
                    evidence: {
                        evidenceMessageId: "succ-b405-25-m1",
                        evidenceQuote:
                            "난독이 있어서 긴 문단은 읽어 내기 어렵습니다.",
                    },
                    expectedDisposition: "sensitive_review",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b405-25",
                    title: "읽기",
                    messages: [
                        {
                            externalMessageId: "succ-b405-25-m1",
                            role: "user",
                            content:
                                "난독이 있어서 긴 문단은 읽어 내기 어렵습니다. 짧게 끊어 주세요.",
                        },
                        {
                            externalMessageId: "succ-b405-25-m2",
                            role: "assistant",
                            content:
                                "문장을 짧게 나누고 목록으로 정리하겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
];
