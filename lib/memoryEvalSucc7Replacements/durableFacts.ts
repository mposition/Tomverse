import type { MemoryEvalCaseV3 } from "@/lib/memoryEvalDatasetSchemaV3";

/**
 * Tranche 2 of the succ-7 replacements: the 38 `durable_facts` cases,
 * 20 ko and 18 en.
 *
 * Each keeps the shape of the case it replaces — gold count, kind, polarity
 * and `expectedDisposition` — on fresh subject matter. Three keep
 * `sensitive_review` because the constraint is a health or accessibility one
 * (`en-612`, `ko-609`, `ko-617`), and downgrading any of them to `bulk_safe`
 * would be the substantive change this transition is not making.
 *
 * `succ-durable-en-618` is the one that does not mirror its succ-6 row. It
 * replaces `succ-durable-en-66`, whose approved correction turns
 * `communication_style`/negated `[disclaimer]` into an affirmed preference for
 * a direct answer, so the replacement is affirmed. Copying the old negated row
 * would reinstate the gold the correction removed.
 *
 * Conversations are two messages: the user states the fact, the assistant
 * acknowledges it and adds nothing. Every case is `exhaustive`, so a third
 * turn is a liability — any durable fact it introduced would be a candidate
 * the gold does not admit and would score as a false positive against a case
 * that never meant to test it.
 *
 * The six two-gold cases pair `expertise`/affirmed with
 * `explanation_depth`/negated, each anchored to its own span: knowing a field
 * and wanting its jargon unpacked are independent propositions, and the
 * `KIND_GUIDE` boundary between them is what these cases exist to hold.
 */
export const SUCC7_DURABLE_FACTS: readonly MemoryEvalCaseV3[] = [
    {
        id: "succ-durable-en-601",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "decision",
                polarity: "negated",
                factValueAll: ["kayak"],
                evidence: {
                    evidenceMessageId: "succ-b702-1-m1",
                    evidenceQuote:
                        "I looked at buying a kayak and decided against it",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-1",
                title: "Kayak",
                messages: [
                    {
                        externalMessageId: "succ-b702-1-m1",
                        role: "user",
                        content: "I looked at buying a kayak and decided against it, so leave that out of any plans you suggest.",
                    },
                    {
                        externalMessageId: "succ-b702-1-m2",
                        role: "assistant",
                        content: "Understood — no kayak.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-en-602",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "expertise",
                polarity: "affirmed",
                factValueAll: ["letterpress"],
                evidence: {
                    evidenceMessageId: "succ-b702-2-m1",
                    evidenceQuote: "letterpress terms are fine with me",
                },
                expectedDisposition: "bulk_safe",
            },
            {
                id: "g2",
                kind: "explanation_depth",
                polarity: "negated",
                factValueAll: ["quoin"],
                evidence: {
                    evidenceMessageId: "succ-b702-2-m1",
                    evidenceQuote: "do not just say quoin and move on",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-2",
                title: "Setting type",
                messages: [
                    {
                        externalMessageId: "succ-b702-2-m1",
                        role: "user",
                        content: "I have set type by hand for years, so letterpress terms are fine with me. But do not just say quoin and move on — say what it does.",
                    },
                    {
                        externalMessageId: "succ-b702-2-m2",
                        role: "assistant",
                        content: "Noted on both counts.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-en-603",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "decision",
                polarity: "negated",
                factValueAll: ["taxidermy"],
                evidence: {
                    evidenceMessageId: "succ-b702-3-m1",
                    evidenceQuote: "decided not to take the taxidermy course",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-3",
                title: "A course I dropped",
                messages: [
                    {
                        externalMessageId: "succ-b702-3-m1",
                        role: "user",
                        content: "I decided not to take the taxidermy course in the end, so please stop suggesting it.",
                    },
                    {
                        externalMessageId: "succ-b702-3-m2",
                        role: "assistant",
                        content: "I will leave it out.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-en-604",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "decision",
                polarity: "negated",
                factValueAll: ["trampoline"],
                evidence: {
                    evidenceMessageId: "succ-b702-4-m1",
                    evidenceQuote: "decided against a trampoline",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-4",
                title: "Garden plans",
                messages: [
                    {
                        externalMessageId: "succ-b702-4-m1",
                        role: "user",
                        content: "We decided against a trampoline for the garden and that is settled.",
                    },
                    {
                        externalMessageId: "succ-b702-4-m2",
                        role: "assistant",
                        content: "Right, no trampoline.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-en-605",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "decision",
                polarity: "negated",
                factValueAll: ["aquarium"],
                evidence: {
                    evidenceMessageId: "succ-b702-5-m1",
                    evidenceQuote: "decided not to set up an aquarium",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-5",
                title: "Fish",
                messages: [
                    {
                        externalMessageId: "succ-b702-5-m1",
                        role: "user",
                        content: "I decided not to set up an aquarium after all, so skip anything that assumes one.",
                    },
                    {
                        externalMessageId: "succ-b702-5-m2",
                        role: "assistant",
                        content: "Understood.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-en-606",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "constraint",
                polarity: "negated",
                factValueAll: ["hammock"],
                evidence: {
                    evidenceMessageId: "succ-b702-6-m1",
                    evidenceQuote: "There is nowhere to hang a hammock at my place",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-6",
                title: "Nothing to fix to",
                messages: [
                    {
                        externalMessageId: "succ-b702-6-m1",
                        role: "user",
                        content: "There is nowhere to hang a hammock at my place, so that will not work for me.",
                    },
                    {
                        externalMessageId: "succ-b702-6-m2",
                        role: "assistant",
                        content: "Understood, no hammock.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-en-607",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "constraint",
                polarity: "negated",
                factValueAll: ["compost"],
                evidence: {
                    evidenceMessageId: "succ-b702-7-m1",
                    evidenceQuote: "I cannot keep a compost heap where I live",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-7",
                title: "No room for it",
                messages: [
                    {
                        externalMessageId: "succ-b702-7-m1",
                        role: "user",
                        content: "I cannot keep a compost heap where I live, so leave that step out of anything you suggest.",
                    },
                    {
                        externalMessageId: "succ-b702-7-m2",
                        role: "assistant",
                        content: "Noted.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-en-608",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "decision",
                polarity: "negated",
                factValueAll: ["philately"],
                evidence: {
                    evidenceMessageId: "succ-b702-8-m1",
                    evidenceQuote: "decided not to go back to philately",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-8",
                title: "An old interest",
                messages: [
                    {
                        externalMessageId: "succ-b702-8-m1",
                        role: "user",
                        content: "I decided not to go back to philately, so there is no need to raise it again.",
                    },
                    {
                        externalMessageId: "succ-b702-8-m2",
                        role: "assistant",
                        content: "Understood.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-en-609",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "constraint",
                polarity: "negated",
                factValueAll: ["canoe"],
                evidence: {
                    evidenceMessageId: "succ-b702-9-m1",
                    evidenceQuote: "I have no way to transport a canoe",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-9",
                title: "Getting it there",
                messages: [
                    {
                        externalMessageId: "succ-b702-9-m1",
                        role: "user",
                        content: "I have no way to transport a canoe, so anything needing one is out for me.",
                    },
                    {
                        externalMessageId: "succ-b702-9-m2",
                        role: "assistant",
                        content: "Right, nothing that needs one.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-en-610",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "expertise",
                polarity: "affirmed",
                factValueAll: ["falconry"],
                evidence: {
                    evidenceMessageId: "succ-b702-10-m1",
                    evidenceQuote: "falconry terms need no gloss",
                },
                expectedDisposition: "bulk_safe",
            },
            {
                id: "g2",
                kind: "explanation_depth",
                polarity: "negated",
                factValueAll: ["jesses"],
                evidence: {
                    evidenceMessageId: "succ-b702-10-m1",
                    evidenceQuote: "Do not just write jesses without saying what they are",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-10",
                title: "Birds",
                messages: [
                    {
                        externalMessageId: "succ-b702-10-m1",
                        role: "user",
                        content: "I have flown birds for a long time, so falconry terms need no gloss. Do not just write jesses without saying what they are, though.",
                    },
                    {
                        externalMessageId: "succ-b702-10-m2",
                        role: "assistant",
                        content: "Understood on both.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-en-611",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "constraint",
                polarity: "negated",
                factValueAll: ["pergola"],
                evidence: {
                    evidenceMessageId: "succ-b702-11-m1",
                    evidenceQuote: "I am not permitted to put up a pergola here",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-11",
                title: "Not allowed",
                messages: [
                    {
                        externalMessageId: "succ-b702-11-m1",
                        role: "user",
                        content: "I am not permitted to put up a pergola here, so that option is closed to me.",
                    },
                    {
                        externalMessageId: "succ-b702-11-m2",
                        role: "assistant",
                        content: "Understood.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-en-612",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "constraint",
                polarity: "negated",
                factValueAll: ["crutch"],
                evidence: {
                    evidenceMessageId: "succ-b702-12-m1",
                    evidenceQuote: "I cannot manage stairs without a crutch",
                },
                expectedDisposition: "sensitive_review",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-12",
                title: "Stairs",
                messages: [
                    {
                        externalMessageId: "succ-b702-12-m1",
                        role: "user",
                        content: "I cannot manage stairs without a crutch, so please leave out anything that needs me to be steady on them.",
                    },
                    {
                        externalMessageId: "succ-b702-12-m2",
                        role: "assistant",
                        content: "Understood — I will keep that in mind.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-en-613",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "communication_style",
                polarity: "negated",
                factValueAll: ["throat-clearing"],
                evidence: {
                    evidenceMessageId: "succ-b702-13-m1",
                    evidenceQuote: "Skip the throat-clearing at the start of an answer",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-13",
                title: "Get to it",
                messages: [
                    {
                        externalMessageId: "succ-b702-13-m1",
                        role: "user",
                        content: "Skip the throat-clearing at the start of an answer and begin with the substance.",
                    },
                    {
                        externalMessageId: "succ-b702-13-m2",
                        role: "assistant",
                        content: "Will do.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-en-614",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "constraint",
                polarity: "negated",
                factValueAll: ["wetsuit"],
                evidence: {
                    evidenceMessageId: "succ-b702-14-m1",
                    evidenceQuote: "I do not own a wetsuit",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-14",
                title: "Cold water",
                messages: [
                    {
                        externalMessageId: "succ-b702-14-m1",
                        role: "user",
                        content: "I do not own a wetsuit and will not be getting one, so rule out anything that needs it.",
                    },
                    {
                        externalMessageId: "succ-b702-14-m2",
                        role: "assistant",
                        content: "Understood.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-en-615",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "decision",
                polarity: "negated",
                factValueAll: ["ukulele"],
                evidence: {
                    evidenceMessageId: "succ-b702-15-m1",
                    evidenceQuote: "decided against learning the ukulele",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-15",
                title: "An instrument",
                messages: [
                    {
                        externalMessageId: "succ-b702-15-m1",
                        role: "user",
                        content: "I decided against learning the ukulele, so please drop it from any suggestions.",
                    },
                    {
                        externalMessageId: "succ-b702-15-m2",
                        role: "assistant",
                        content: "Noted.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-en-616",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "tone",
                polarity: "negated",
                factValueAll: ["rhetorical"],
                evidence: {
                    evidenceMessageId: "succ-b702-16-m1",
                    evidenceQuote: "do not open with a rhetorical question",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-16",
                title: "How it reads",
                messages: [
                    {
                        externalMessageId: "succ-b702-16-m1",
                        role: "user",
                        content: "Please do not open with a rhetorical question — it puts me off the whole answer.",
                    },
                    {
                        externalMessageId: "succ-b702-16-m2",
                        role: "assistant",
                        content: "Understood.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-en-617",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "formatting",
                polarity: "negated",
                factValueAll: ["italics"],
                evidence: {
                    evidenceMessageId: "succ-b702-17-m1",
                    evidenceQuote: "Do not use italics for emphasis",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-17",
                title: "On screen",
                messages: [
                    {
                        externalMessageId: "succ-b702-17-m1",
                        role: "user",
                        content: "Do not use italics for emphasis in anything you write for me; they are hard for me to pick out.",
                    },
                    {
                        externalMessageId: "succ-b702-17-m2",
                        role: "assistant",
                        content: "Understood.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-en-618",
        category: "durable_facts",
        language: "en",
        expected: [
            {
                id: "g1",
                kind: "communication_style",
                polarity: "affirmed",
                factValueAll: ["bluntly"],
                evidence: {
                    evidenceMessageId: "succ-b702-18-m1",
                    evidenceQuote: "I would rather you told me bluntly what you think",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-18",
                title: "Say it straight",
                messages: [
                    {
                        externalMessageId: "succ-b702-18-m1",
                        role: "user",
                        content: "I would rather you told me bluntly what you think and let me decide what to do with it.",
                    },
                    {
                        externalMessageId: "succ-b702-18-m2",
                        role: "assistant",
                        content: "Understood — I will.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-601",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "decision",
                polarity: "negated",
                factValueAll: ["카약"],
                evidence: {
                    evidenceMessageId: "succ-b702-19-m1",
                    evidenceQuote: "카약은 사지 않기로 정했습니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-19",
                title: "카약",
                messages: [
                    {
                        externalMessageId: "succ-b702-19-m1",
                        role: "user",
                        content: "카약은 사지 않기로 정했습니다. 앞으로 그건 빼고 말씀해 주세요.",
                    },
                    {
                        externalMessageId: "succ-b702-19-m2",
                        role: "assistant",
                        content: "알겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-602",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "decision",
                polarity: "negated",
                factValueAll: ["우쿨렐레"],
                evidence: {
                    evidenceMessageId: "succ-b702-20-m1",
                    evidenceQuote: "우쿨렐레는 배우지 않기로 결정했습니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-20",
                title: "악기",
                messages: [
                    {
                        externalMessageId: "succ-b702-20-m1",
                        role: "user",
                        content: "우쿨렐레는 배우지 않기로 결정했습니다. 다시 권하지 않으셔도 됩니다.",
                    },
                    {
                        externalMessageId: "succ-b702-20-m2",
                        role: "assistant",
                        content: "네, 빼겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-603",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "decision",
                polarity: "negated",
                factValueAll: ["우표수집"],
                evidence: {
                    evidenceMessageId: "succ-b702-21-m1",
                    evidenceQuote: "우표수집은 다시 하지 않기로 했습니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-21",
                title: "예전 취미",
                messages: [
                    {
                        externalMessageId: "succ-b702-21-m1",
                        role: "user",
                        content: "우표수집은 다시 하지 않기로 했습니다. 그 방향은 접었습니다.",
                    },
                    {
                        externalMessageId: "succ-b702-21-m2",
                        role: "assistant",
                        content: "알겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-604",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "formatting",
                polarity: "negated",
                factValueAll: ["느낌표"],
                evidence: {
                    evidenceMessageId: "succ-b702-22-m1",
                    evidenceQuote: "답변에 느낌표는 쓰지 말아 주세요",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-22",
                title: "문장 부호",
                messages: [
                    {
                        externalMessageId: "succ-b702-22-m1",
                        role: "user",
                        content: "답변에 느낌표는 쓰지 말아 주세요. 읽을 때 거슬립니다.",
                    },
                    {
                        externalMessageId: "succ-b702-22-m2",
                        role: "assistant",
                        content: "네, 쓰지 않겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-605",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "decision",
                polarity: "negated",
                factValueAll: ["온실"],
                evidence: {
                    evidenceMessageId: "succ-b702-23-m1",
                    evidenceQuote: "온실은 두지 않기로 정했습니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-23",
                title: "마당",
                messages: [
                    {
                        externalMessageId: "succ-b702-23-m1",
                        role: "user",
                        content: "온실은 두지 않기로 정했습니다. 그걸 전제로 한 안은 빼 주세요.",
                    },
                    {
                        externalMessageId: "succ-b702-23-m2",
                        role: "assistant",
                        content: "알겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-606",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "constraint",
                polarity: "negated",
                factValueAll: ["해먹"],
                evidence: {
                    evidenceMessageId: "succ-b702-24-m1",
                    evidenceQuote: "집에 해먹을 걸 만한 곳이 없습니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-24",
                title: "걸 데가 없음",
                messages: [
                    {
                        externalMessageId: "succ-b702-24-m1",
                        role: "user",
                        content: "집에 해먹을 걸 만한 곳이 없습니다. 그건 저한테 안 됩니다.",
                    },
                    {
                        externalMessageId: "succ-b702-24-m2",
                        role: "assistant",
                        content: "네, 빼겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-607",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "expertise",
                polarity: "affirmed",
                factValueAll: ["분재"],
                evidence: {
                    evidenceMessageId: "succ-b702-25-m1",
                    evidenceQuote: "분재는 오래 해 와서 용어는 그냥 쓰셔도 됩니다",
                },
                expectedDisposition: "bulk_safe",
            },
            {
                id: "g2",
                kind: "explanation_depth",
                polarity: "negated",
                factValueAll: ["삽목"],
                evidence: {
                    evidenceMessageId: "succ-b702-25-m1",
                    evidenceQuote: "삽목이라고만 적고 넘어가지는 말아 주세요",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-25",
                title: "나무",
                messages: [
                    {
                        externalMessageId: "succ-b702-25-m1",
                        role: "user",
                        content: "분재는 오래 해 와서 용어는 그냥 쓰셔도 됩니다. 다만 삽목이라고만 적고 넘어가지는 말아 주세요.",
                    },
                    {
                        externalMessageId: "succ-b702-25-m2",
                        role: "assistant",
                        content: "두 가지 다 알겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-608",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "constraint",
                polarity: "negated",
                factValueAll: ["새벽시간", "일정"],
                evidence: {
                    evidenceMessageId: "succ-b702-26-m1",
                    evidenceQuote: "새벽시간에는 일정을 잡을 수 없습니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-26",
                title: "시간대",
                messages: [
                    {
                        externalMessageId: "succ-b702-26-m1",
                        role: "user",
                        content: "새벽시간에는 일정을 잡을 수 없습니다. 그 시간대는 빼 주세요.",
                    },
                    {
                        externalMessageId: "succ-b702-26-m2",
                        role: "assistant",
                        content: "네, 제외하겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-609",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "constraint",
                polarity: "negated",
                factValueAll: ["조개"],
                evidence: {
                    evidenceMessageId: "succ-b702-27-m1",
                    evidenceQuote: "저는 조개를 먹으면 안 됩니다",
                },
                expectedDisposition: "sensitive_review",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-27",
                title: "식단",
                messages: [
                    {
                        externalMessageId: "succ-b702-27-m1",
                        role: "user",
                        content: "저는 조개를 먹으면 안 됩니다. 들어간 것은 전부 빼 주세요.",
                    },
                    {
                        externalMessageId: "succ-b702-27-m2",
                        role: "assistant",
                        content: "알겠습니다. 유의하겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-610",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "constraint",
                polarity: "negated",
                factValueAll: ["활판"],
                evidence: {
                    evidenceMessageId: "succ-b702-28-m1",
                    evidenceQuote: "활판 설비를 쓸 수 없는 환경입니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-28",
                title: "장비",
                messages: [
                    {
                        externalMessageId: "succ-b702-28-m1",
                        role: "user",
                        content: "활판 설비를 쓸 수 없는 환경입니다. 그게 필요한 방법은 빼 주세요.",
                    },
                    {
                        externalMessageId: "succ-b702-28-m2",
                        role: "assistant",
                        content: "알겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-611",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "constraint",
                polarity: "negated",
                factValueAll: ["격주토요일", "일정"],
                evidence: {
                    evidenceMessageId: "succ-b702-29-m1",
                    evidenceQuote: "격주토요일에는 일정을 잡지 못합니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-29",
                title: "격주",
                messages: [
                    {
                        externalMessageId: "succ-b702-29-m1",
                        role: "user",
                        content: "격주토요일에는 일정을 잡지 못합니다. 그 날은 비워 주세요.",
                    },
                    {
                        externalMessageId: "succ-b702-29-m2",
                        role: "assistant",
                        content: "네, 비워 두겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-612",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "constraint",
                polarity: "negated",
                factValueAll: ["트램펄린"],
                evidence: {
                    evidenceMessageId: "succ-b702-30-m1",
                    evidenceQuote: "트램펄린은 놓을 수 없는 구조입니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-30",
                title: "마당 설치",
                messages: [
                    {
                        externalMessageId: "succ-b702-30-m1",
                        role: "user",
                        content: "트램펄린은 놓을 수 없는 구조입니다. 그건 빼고 봐 주세요.",
                    },
                    {
                        externalMessageId: "succ-b702-30-m2",
                        role: "assistant",
                        content: "알겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-613",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "decision",
                polarity: "negated",
                factValueAll: ["자동갱신", "결제"],
                evidence: {
                    evidenceMessageId: "succ-b702-31-m1",
                    evidenceQuote: "자동갱신 결제는 쓰지 않기로 했습니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-31",
                title: "구독",
                messages: [
                    {
                        externalMessageId: "succ-b702-31-m1",
                        role: "user",
                        content: "자동갱신 결제는 쓰지 않기로 했습니다. 그 방식은 빼 주세요.",
                    },
                    {
                        externalMessageId: "succ-b702-31-m2",
                        role: "assistant",
                        content: "네, 제외하겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-614",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "expertise",
                polarity: "affirmed",
                factValueAll: ["제화"],
                evidence: {
                    evidenceMessageId: "succ-b702-32-m1",
                    evidenceQuote: "제화는 오래 다뤄서 용어를 풀지 않으셔도 됩니다",
                },
                expectedDisposition: "bulk_safe",
            },
            {
                id: "g2",
                kind: "explanation_depth",
                polarity: "negated",
                factValueAll: ["각인"],
                evidence: {
                    evidenceMessageId: "succ-b702-32-m1",
                    evidenceQuote: "각인이라고만 쓰시면 곤란합니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-32",
                title: "구두",
                messages: [
                    {
                        externalMessageId: "succ-b702-32-m1",
                        role: "user",
                        content: "제화는 오래 다뤄서 용어를 풀지 않으셔도 됩니다. 다만 각인이라고만 쓰시면 곤란합니다.",
                    },
                    {
                        externalMessageId: "succ-b702-32-m2",
                        role: "assistant",
                        content: "두 가지 다 반영하겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-615",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "constraint",
                polarity: "negated",
                factValueAll: ["전세보증금", "한도"],
                evidence: {
                    evidenceMessageId: "succ-b702-33-m1",
                    evidenceQuote: "전세보증금 한도를 넘는 매물은 볼 수 없습니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-33",
                title: "집 구하기",
                messages: [
                    {
                        externalMessageId: "succ-b702-33-m1",
                        role: "user",
                        content: "전세보증금 한도를 넘는 매물은 볼 수 없습니다. 그 위는 빼 주세요.",
                    },
                    {
                        externalMessageId: "succ-b702-33-m2",
                        role: "assistant",
                        content: "알겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-616",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "constraint",
                polarity: "negated",
                factValueAll: ["기사방문", "설치"],
                evidence: {
                    evidenceMessageId: "succ-b702-34-m1",
                    evidenceQuote: "기사방문 설치는 받을 수 없는 상황입니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-34",
                title: "설치 방식",
                messages: [
                    {
                        externalMessageId: "succ-b702-34-m1",
                        role: "user",
                        content: "기사방문 설치는 받을 수 없는 상황입니다. 그 방식은 제외해 주세요.",
                    },
                    {
                        externalMessageId: "succ-b702-34-m2",
                        role: "assistant",
                        content: "네, 빼겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-617",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "constraint",
                polarity: "negated",
                factValueAll: ["흡입기", "먼지"],
                evidence: {
                    evidenceMessageId: "succ-b702-35-m1",
                    evidenceQuote: "흡입기를 늘 지녀야 해서 먼지가 많은 작업은 하지 못합니다",
                },
                expectedDisposition: "sensitive_review",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-35",
                title: "작업 환경",
                messages: [
                    {
                        externalMessageId: "succ-b702-35-m1",
                        role: "user",
                        content: "흡입기를 늘 지녀야 해서 먼지가 많은 작업은 하지 못합니다. 그런 항목은 빼 주세요.",
                    },
                    {
                        externalMessageId: "succ-b702-35-m2",
                        role: "assistant",
                        content: "알겠습니다. 유의하겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-618",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "decision",
                polarity: "negated",
                factValueAll: ["매사냥"],
                evidence: {
                    evidenceMessageId: "succ-b702-36-m1",
                    evidenceQuote: "매사냥은 배우지 않기로 정했습니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-36",
                title: "배우려던 것",
                messages: [
                    {
                        externalMessageId: "succ-b702-36-m1",
                        role: "user",
                        content: "매사냥은 배우지 않기로 정했습니다. 그 얘기는 접겠습니다.",
                    },
                    {
                        externalMessageId: "succ-b702-36-m2",
                        role: "assistant",
                        content: "알겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-619",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "expertise",
                polarity: "affirmed",
                factValueAll: ["종이접기"],
                evidence: {
                    evidenceMessageId: "succ-b702-37-m1",
                    evidenceQuote: "종이접기는 오래 해서 설명은 없어도 됩니다",
                },
                expectedDisposition: "bulk_safe",
            },
            {
                id: "g2",
                kind: "explanation_depth",
                polarity: "negated",
                factValueAll: ["여백"],
                evidence: {
                    evidenceMessageId: "succ-b702-37-m1",
                    evidenceQuote: "여백만 언급하고 지나가지는 마세요",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-37",
                title: "접기",
                messages: [
                    {
                        externalMessageId: "succ-b702-37-m1",
                        role: "user",
                        content: "종이접기는 오래 해서 설명은 없어도 됩니다. 대신 여백만 언급하고 지나가지는 마세요.",
                    },
                    {
                        externalMessageId: "succ-b702-37-m2",
                        role: "assistant",
                        content: "두 가지 다 알겠습니다.",
                    },
                ],
            },
        ],
    },
    {
        id: "succ-durable-ko-620",
        category: "durable_facts",
        language: "ko",
        expected: [
            {
                id: "g1",
                kind: "expertise",
                polarity: "affirmed",
                factValueAll: ["물레"],
                evidence: {
                    evidenceMessageId: "succ-b702-38-m1",
                    evidenceQuote: "물레는 오래 돌려서 기본 설명은 빼셔도 됩니다",
                },
                expectedDisposition: "bulk_safe",
            },
            {
                id: "g2",
                kind: "explanation_depth",
                polarity: "negated",
                factValueAll: ["유약"],
                evidence: {
                    evidenceMessageId: "succ-b702-38-m1",
                    evidenceQuote: "유약이라고만 적으면 알아듣기 어렵습니다",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-38",
                title: "그릇",
                messages: [
                    {
                        externalMessageId: "succ-b702-38-m1",
                        role: "user",
                        content: "물레는 오래 돌려서 기본 설명은 빼셔도 됩니다. 다만 유약이라고만 적으면 알아듣기 어렵습니다.",
                    },
                    {
                        externalMessageId: "succ-b702-38-m2",
                        role: "assistant",
                        content: "두 가지 다 반영하겠습니다.",
                    },
                ],
            },
        ],
    },
];
