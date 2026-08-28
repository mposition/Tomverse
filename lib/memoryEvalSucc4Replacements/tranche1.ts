/**
 * The eight replacements for the cases whose reason for moving was particular.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12. Written first,
 * on purpose: the other ninety-five moved for one reason — they were in front
 * of a reviewer while the polarity assignment rule was being written — and
 * these eight each moved for a defect the contract had to answer. If writing
 * their replacements needs a rule the contract does not already have, that is
 * cheaper to find now than after ninety-five more.
 *
 * **Not wired into any registry.** `succ-4` is assembled once all 103 exist;
 * a partial tranche in the canonical decision set would have to be unpicked if
 * one of these turned up a gap.
 *
 * ## What a replacement has to do
 *
 * Keep the boundary the original tested, change the situation and the wording
 * so it is not the same case with the nouns swapped, and carry a gold whose
 * predicate is explicit — the failure that moved `en-129` and `en-316` was a
 * token list naming the topic and leaving the predicate to be inferred.
 *
 * Every gold here has its `polarity`, `evidenceMessageId` and `evidenceQuote`
 * written out and reviewed one at a time
 * (.github/audits/memory-eval-gold-contract-2026-08-27.md §12.11). None is a
 * proposal.
 */

import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";

/** Why the original left, and what its replacement has to keep. */
export type Succ4Replacement = {
    originalId: string;
    /** The defect that moved the original, in one line. */
    movedBecause: string;
    /** What the case measures, and must go on measuring. */
    boundary: string;
    /** How the replacement differs beyond renaming. */
    differsBy: string;
    /**
     * Whether the frozen contract settled every question the writing raised.
     *
     * `false` on any of these stops the remaining ninety-five: it means the
     * contract has a gap and the same judgement would have to be made again
     * across the rest.
     */
    settledByExistingContract: true;
    replacement: MemoryEvalCaseV3;
};

export const SUCC4_TRANCHE_1: readonly Succ4Replacement[] = [
    /* ===================================================== under-specified */
    {
        originalId: "succ-durable-en-129",
        movedBecause:
            "«Weekends are completely spoken for» is affirmative in form and denies the " +
            "weekend's availability, and [\"weekend\"] left the predicate out, so the " +
            "label depended on how the sentence was read.",
        boundary:
            "A recurring unavailability the user states in the affirmative, which the " +
            "model has to store as a scheduling constraint.",
        differsBy:
            "A named commitment on one weekday evening rather than a blanket weekend, " +
            "and the gold names the predicate (booked) instead of the period alone, so " +
            "no reading of the sentence changes the label.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-401",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "recurring_context",
                    polarity: "affirmed",
                    factValueAll: ["thursday", "booked"],
                    evidence: {
                        evidenceMessageId: "succ-b401-1-m1",
                        evidenceQuote:
                            "Thursday evenings are booked solid with a night class until June.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b401-1",
                    title: "night class",
                    messages: [
                        {
                            externalMessageId: "succ-b401-1-m1",
                            role: "user",
                            content:
                                "Thursday evenings are booked solid with a night class until June.",
                        },
                        {
                            externalMessageId: "succ-b401-1-m2",
                            role: "assistant",
                            content: "I'll leave Thursday evenings out until then.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-316",
        movedBecause:
            "«anything that needs quiet or floor space is constrained» is the same " +
            "shape, and [\"space\"] named the topic. Its own provenance runs " +
            "succ-durable-en-57 -> en-316 -> here.",
        boundary:
            "Two golds off one sentence — a working relationship and a resource " +
            "constraint that follows from it — with the two-gold shape kept.",
        differsBy:
            "A rented bench in a jewellery workshop rather than a shared studio, and " +
            "the constraint is a named machine with a named window rather than floor " +
            "space in the abstract.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-402",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "g1",
                    kind: "relationship",
                    polarity: "affirmed",
                    factValueAll: ["workshop"],
                    factValueAny: ["share", "shares", "shared"],
                    evidence: {
                        evidenceMessageId: "succ-b402-1-m1",
                        evidenceQuote:
                            "I share a jewellery workshop with three other makers, and the polishing motor is only free before ten.",
                    },
                    expectedDisposition: "bulk_safe",
                },
                {
                    id: "g2",
                    kind: "constraint",
                    polarity: "affirmed",
                    factValueAll: ["polishing motor", "before ten"],
                    evidence: {
                        evidenceMessageId: "succ-b402-1-m1",
                        evidenceQuote:
                            "I share a jewellery workshop with three other makers, and the polishing motor is only free before ten.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b402-1",
                    title: "shared bench",
                    messages: [
                        {
                            externalMessageId: "succ-b402-1-m1",
                            role: "user",
                            content:
                                "I share a jewellery workshop with three other makers, and the polishing motor is only free before ten.",
                        },
                        {
                            externalMessageId: "succ-b402-1-m2",
                            role: "assistant",
                            content: "I'll plan the polishing steps for the morning.",
                        },
                    ],
                },
            ],
        },
    },

    /* ============================== anchor did not support the polarity == */
    {
        originalId: "succ-assistant-en-306",
        movedBecause:
            "The anchor landed on «The onboarding checklist you drafted has a section " +
            "on sibling carer leave» — the user quoting the draft back — because the " +
            "fact's token appeared there first. goldEvidenceFailure passes such a " +
            "quote: it checks structure, not polarity.",
        boundary:
            "A user correcting an assumption the assistant made about them, where the " +
            "correction is the memory and the assistant's own words are not.",
        differsBy:
            "A route plan assuming the user drives rather than a checklist assuming a " +
            "sibling, and the gold's token appears only in the correcting turn, so the " +
            "premise being quoted back cannot attract the anchor.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-assistant-en-401",
            category: "assistant_only",
            language: "en",
            goldCompleteness: "exhaustive",
            criticalGoldMode: "allow_expected_only",
            expected: [
                {
                    id: "g1",
                    kind: "constraint",
                    polarity: "negated",
                    factValueAll: ["licence"],
                    evidence: {
                        evidenceMessageId: "succ-b401-2-m3",
                        evidenceQuote:
                            "I have never held a driving licence, so it will be buses either way.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b401-2",
                    title: "route plan",
                    messages: [
                        {
                            externalMessageId: "succ-b401-2-m1",
                            role: "user",
                            content:
                                "The route plan you wrote has me setting off at six and parking on site.",
                        },
                        {
                            externalMessageId: "succ-b401-2-m2",
                            role: "assistant",
                            content: "I assumed you would be going by car.",
                        },
                        {
                            externalMessageId: "succ-b401-2-m3",
                            role: "user",
                            content:
                                "I have never held a driving licence, so it will be buses either way.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-assistant-en-307",
        movedBecause:
            "Same defect: anchored on «Every option in that list needs a form printed " +
            "and posted back» rather than on «I don't have a printer».",
        boundary:
            "The assistant assumes the user has a piece of equipment; the memory is the " +
            "user saying they do not.",
        differsBy:
            "A scanner in a claims process rather than a printer in a form process, and " +
            "the equipment noun does not occur in the assistant's premise at all.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-assistant-en-402",
            category: "assistant_only",
            language: "en",
            goldCompleteness: "exhaustive",
            criticalGoldMode: "allow_expected_only",
            expected: [
                {
                    id: "g1",
                    kind: "constraint",
                    polarity: "negated",
                    factValueAll: ["scanner"],
                    evidence: {
                        evidenceMessageId: "succ-b402-2-m3",
                        evidenceQuote:
                            "There is no scanner in this house, so I would be posting the originals.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b402-2",
                    title: "claim steps",
                    messages: [
                        {
                            externalMessageId: "succ-b402-2-m1",
                            role: "user",
                            content:
                                "Each of those steps finishes by uploading the signed page.",
                        },
                        {
                            externalMessageId: "succ-b402-2-m2",
                            role: "assistant",
                            content: "That is how the claim is processed.",
                        },
                        {
                            externalMessageId: "succ-b402-2-m3",
                            role: "user",
                            content:
                                "There is no scanner in this house, so I would be posting the originals.",
                        },
                    ],
                },
            ],
        },
    },

    /* ================================= canonical form and correction clause */
    {
        originalId: "succ-durable-ko-301",
        movedBecause:
            "The gold wrote 여섯 where the user wrote 여섯 시, which canon rewrites to " +
            "6시 — the Korean numeral rule fires only when a counter follows, so a bare " +
            "numeral can never match text where it was rewritten.",
        boundary:
            "A household routine anchored to a clock time, where the user writes the " +
            "hour in Korean numerals and the gold has to be in canonical form.",
        differsBy:
            "The user's own shop-opening rather than a parent leaving the house, a " +
            "different hour, and the consequence is when they can be reached rather " +
            "than who is awake. Rewritten after the first draft measured 0.53 against " +
            "the original: it kept the parent-leaves-early-so-the-house-wakes shape and " +
            "only changed the nouns.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-401",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "g1",
                    kind: "recurring_context",
                    polarity: "affirmed",
                    factValueAll: ["9시"],
                    evidence: {
                        evidenceMessageId: "succ-b403-1-m1",
                        evidenceQuote:
                            "가게 문을 아홉 시에 열어서 그 전에는 연락이 잘 안 됩니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b403-1",
                    title: "개점 시간",
                    messages: [
                        {
                            externalMessageId: "succ-b403-1-m1",
                            role: "user",
                            content:
                                "가게 문을 아홉 시에 열어서 그 전에는 연락이 잘 안 됩니다.",
                        },
                        {
                            externalMessageId: "succ-b403-1-m2",
                            role: "assistant",
                            content: "오전 연락은 피해서 잡겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-assistant-ko-308",
        movedBecause:
            "The anchor was moved off «전주가 아니라 정읍이에요», where the marker sits " +
            "one character from the affirmed value — the shape rule 6 of " +
            ".github/audits/memory-eval-gold-contract-2026-08-27.md §10.2 admits only " +
            "through its plain clause.",
        boundary:
            "A resolved correction: the assistant has the wrong value, the user gives " +
            "the right one, and the anchor is the plain clause rather than the X-not-Y one.",
        differsBy:
            "An inference drawn from an earlier trip rather than a typo being fixed, and " +
            "the plain clause is in the later turn, so the anchor is not simply the first " +
            "sentence.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-assistant-ko-401",
            category: "assistant_only",
            language: "ko",
            goldCompleteness: "exhaustive",
            criticalGoldMode: "allow_expected_only",
            expected: [
                {
                    id: "g1",
                    kind: "identity",
                    polarity: "affirmed",
                    factValueAll: ["창원"],
                    evidence: {
                        evidenceMessageId: "succ-b403-2-m3",
                        evidenceQuote: "제 소속은 창원 지사입니다.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b403-2",
                    title: "소속 지사",
                    messages: [
                        {
                            externalMessageId: "succ-b403-2-m1",
                            role: "user",
                            content: "일정표에 제 이름이 부산 지사 쪽으로 들어가 있네요.",
                        },
                        {
                            externalMessageId: "succ-b403-2-m2",
                            role: "assistant",
                            content: "지난번에 부산을 말씀하셔서 그렇게 두었습니다.",
                        },
                        {
                            externalMessageId: "succ-b403-2-m3",
                            role: "user",
                            content:
                                "그때는 출장이었습니다. 제 소속은 창원 지사입니다.",
                        },
                    ],
                },
            ],
        },
    },

    /* =========================== one gold, two predications of opposite sign */
    {
        originalId: "succ-durable-ko-12",
        movedBecause:
            "One gold carried 휠체어 (affirmed of the mother) and 계단 (denied of the " +
            "user), so no single polarity was right for it.",
        boundary:
            "A household health fact producing a mobility constraint, held for review " +
            "rather than auto-approved.",
        differsBy:
            "An oxygen cylinder and a lift requirement rather than a wheelchair and " +
            "stairs, and the gold states the requirement in the affirmative so cause and " +
            "consequence do not share one label.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-ko-402",
            category: "durable_facts",
            language: "ko",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "affirmed",
                    factValueAll: ["엘리베이터"],
                    factValueAny: ["있는", "있어야"],
                    evidence: {
                        evidenceMessageId: "succ-b404-1-m1",
                        evidenceQuote:
                            "아버지가 산소통을 들고 다니셔서 엘리베이터가 있는 건물만 갈 수 있습니다.",
                    },
                    expectedDisposition: "sensitive_review",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b404-1",
                    title: "이동 조건",
                    messages: [
                        {
                            externalMessageId: "succ-b404-1-m1",
                            role: "user",
                            content:
                                "아버지가 산소통을 들고 다니셔서 엘리베이터가 있는 건물만 갈 수 있습니다. 이 점 감안해 주세요.",
                        },
                        {
                            externalMessageId: "succ-b404-1-m2",
                            role: "assistant",
                            content: "승강기가 있는 곳만 추려 드리겠습니다.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-19",
        movedBecause:
            "Same shape in English: `deaf` was affirmed of the partner and `audio` was " +
            "denied of what works, in one token list.",
        boundary:
            "A household health fact producing a modality constraint, held for review.",
        differsBy:
            "A child's limited vision and a print requirement rather than a partner's " +
            "deafness and audio-only material, and the gold names what is needed rather " +
            "than what fails.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-403",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "affirmed",
                    factValueAll: ["large print"],
                    evidence: {
                        evidenceMessageId: "succ-b404-2-m1",
                        evidenceQuote:
                            "My son has very limited vision, so we need everything in large print.",
                    },
                    expectedDisposition: "sensitive_review",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b404-2",
                    title: "reading at home",
                    messages: [
                        {
                            externalMessageId: "succ-b404-2-m1",
                            role: "user",
                            content:
                                "My son has very limited vision, so we need everything in large print.",
                        },
                        {
                            externalMessageId: "succ-b404-2-m2",
                            role: "assistant",
                            content: "I'll keep to large print for anything you'll read together.",
                        },
                    ],
                },
            ],
        },
    },
];
