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
 * ## Rewritten after two adoption reviews (2026-09-02)
 *
 * **One direction per case.** Six cases paired "I know this field, skip the
 * glossary" with "but explain this one term", and labelled the second clause
 * `explanation_depth`/negated. That is the wrong sign — asking for a term to be
 * explained is an affirmative depth request — and it left the case with three
 * valid memories under a two-gold `exhaustive` label. Section 4.1.2 says a
 * conversation richer than its gold is rewritten rather than relabelled, so the
 * exception clause is gone and each case states one direction: the field is
 * known, the jargon needs no gloss.
 *
 * **Gold anchored to the fact, not to its trappings.** `en-612` binds the
 * constraint to stairs rather than to the crutch, which cannot tell "needs one"
 * from "does not use one"; `ko-615` names a real ceiling instead of the word
 * "limit", which filters nothing; `ko-617` keeps asthma in the conversation and
 * out of the tokens, the way `ko-428` kept its migraine out of them; and
 * `en-618` anchors on wanting the model’s own view rather than on the adverb
 * "bluntly", which points at `tone`.
 *
 * **The kind has to be the kind.** `en-603` was one enrolment let pass, which
 * is an event rather than the standing decision `en-155` tested, so it now
 * refuses the pursuit itself rather than one intake of it. `en-614` said the
 * user would not buy a wetsuit, which is a `decision` wearing a `constraint`
 * label; it is now a skill never acquired, as `en-433` was. `en-617` blamed the
 * user’s eyesight, which makes the case an accessibility fact and leaves a
 * single `formatting`/`bulk_safe` gold short of `exhaustive`; the reason is back
 * where `en-441` had it, in what survives a paste.
 *
 * ## Why the conversations are not one sentence frame
 *
 * Every decision case read "I decided not to X, so leave it out" and every
 * durable case was two messages. Individually correct, and still one case
 * counted thirty-eight times: a set like that measures a single phrasing’s
 * extraction rate and reports it as a cell. The framings are now distinct —
 * a decision costed and dropped, one a household settled, one closed years ago,
 * a constraint of space, of permission, of transport, of schedule, of money —
 * and each language cell carries three turn shapes rather than one: ten two-turn,
 * six three-turn and two four-turn in en, twelve, six and two in ko.
 *
 * In the four-turn cases the durable fact arrives after the assistant has
 * proposed something, which is how these facts reach a real assistant. The
 * proposal states nothing about the user, and every third or fourth turn that is
 * not the fact itself is a bare acknowledgement: each case is `exhaustive`, so a
 * turn that introduced a durable fact of its own would be a candidate the gold
 * does not admit, scoring as a false positive against a case that never meant to
 * test it.
 *
 * The ko cell is not the en cell in Korean. Seven subjects were literal
 * translations of their English counterparts — 카약/kayak, 해먹/hammock,
 * 우표수집/philately, 우쿨렐레/ukulele, 트램펄린/trampoline, 활판/letterpress,
 * 매사냥/falconry — which makes twenty Korean cases partly a measurement of
 * the same twenty English ones. They now stand on their own subjects.
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
                        "I priced up a kayak last spring and decided against buying one.",
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
                        content:
                            "I priced up a kayak last spring and decided against buying one.",
                    },
                    {
                        externalMessageId: "succ-b702-1-m2",
                        role: "assistant",
                        content: "Should I leave it out of anything I suggest?",
                    },
                    {
                        externalMessageId: "succ-b702-1-m3",
                        role: "user",
                        content: "Yes — that one is settled.",
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
                    evidenceQuote:
                        "I have set letterpress type by hand for years",
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
                    evidenceQuote:
                        "you can say quoin without stopping to explain it",
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
                        content:
                            "I have set letterpress type by hand for years, so you can say quoin without stopping to explain it.",
                    },
                    {
                        externalMessageId: "succ-b702-2-m2",
                        role: "assistant",
                        content:
                            "Noted — I will use the vocabulary as it stands.",
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
                    evidenceQuote: "I am not taking up taxidermy, now or later",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-3",
                title: "Closed for good",
                messages: [
                    {
                        externalMessageId: "succ-b702-3-m1",
                        role: "user",
                        content:
                            "That question closed for me years ago — I am not taking up taxidermy, now or later.",
                    },
                    {
                        externalMessageId: "succ-b702-3-m2",
                        role: "assistant",
                        content: "Then it stays off the list.",
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
                    evidenceQuote:
                        "A trampoline came up at home and we agreed as a family not to get one.",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-4",
                title: "The garden",
                messages: [
                    {
                        externalMessageId: "succ-b702-4-m1",
                        role: "user",
                        content:
                            "A trampoline came up at home and we agreed as a family not to get one.",
                    },
                    {
                        externalMessageId: "succ-b702-4-m2",
                        role: "assistant",
                        content:
                            "Should I keep garden suggestions clear of it?",
                    },
                    {
                        externalMessageId: "succ-b702-4-m3",
                        role: "user",
                        content: "Please do.",
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
                    evidenceQuote:
                        "I thought about an aquarium for a long time and settled on not having one.",
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
                        content:
                            "I thought about an aquarium for a long time and settled on not having one.",
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
                    evidenceQuote:
                        "There is nothing at my place to fix a hammock to",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-6",
                title: "Nothing to fix it to",
                messages: [
                    {
                        externalMessageId: "succ-b702-6-m1",
                        role: "user",
                        content:
                            "There is nothing at my place to fix a hammock to, so it will not work here.",
                    },
                    {
                        externalMessageId: "succ-b702-6-m2",
                        role: "assistant",
                        content: "I will leave that out.",
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
                    evidenceQuote: "My lease does not allow a compost heap.",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-7",
                title: "What the lease says",
                messages: [
                    {
                        externalMessageId: "succ-b702-7-m1",
                        role: "user",
                        content: "My lease does not allow a compost heap.",
                    },
                    {
                        externalMessageId: "succ-b702-7-m2",
                        role: "assistant",
                        content:
                            "So nothing that depends on composting on site.",
                    },
                    {
                        externalMessageId: "succ-b702-7-m3",
                        role: "user",
                        content: "That is it.",
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
                    evidenceQuote:
                        "I gave up philately for good a few years ago.",
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
                        content:
                            "I gave up philately for good a few years ago.",
                    },
                    {
                        externalMessageId: "succ-b702-8-m2",
                        role: "assistant",
                        content: "Then I will not bring it up.",
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
                    evidenceQuote: "I have no way to move a canoe.",
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
                        content: "I have no way to move a canoe.",
                    },
                    {
                        externalMessageId: "succ-b702-9-m2",
                        role: "assistant",
                        content: "So getting one there is the blocker?",
                    },
                    {
                        externalMessageId: "succ-b702-9-m3",
                        role: "user",
                        content: "That is the whole of it.",
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
                    evidenceQuote:
                        "I have kept birds for falconry since I was a boy",
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
                    evidenceQuote: "jesses needs no explaining when you use it",
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
                        content:
                            "I have kept birds for falconry since I was a boy, so jesses needs no explaining when you use it.",
                    },
                    {
                        externalMessageId: "succ-b702-10-m2",
                        role: "assistant",
                        content: "Understood — the terms stay as they are.",
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
                    evidenceMessageId: "succ-b702-11-m3",
                    evidenceQuote: "The freeholder turned down a pergola",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-11",
                title: "Shade",
                messages: [
                    {
                        externalMessageId: "succ-b702-11-m1",
                        role: "user",
                        content:
                            "What is the usual way to get shade over a patio?",
                    },
                    {
                        externalMessageId: "succ-b702-11-m2",
                        role: "assistant",
                        content:
                            "A pergola is the common answer — shall I work from that?",
                    },
                    {
                        externalMessageId: "succ-b702-11-m3",
                        role: "user",
                        content:
                            "The freeholder turned down a pergola, so that route is closed to me.",
                    },
                    {
                        externalMessageId: "succ-b702-11-m4",
                        role: "assistant",
                        content:
                            "Then I will keep to things that need no permission.",
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
                factValueAll: ["stairs"],
                evidence: {
                    evidenceMessageId: "succ-b702-12-m1",
                    evidenceQuote: "I cannot manage stairs",
                },
                expectedDisposition: "sensitive_review",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-12",
                title: "One level",
                messages: [
                    {
                        externalMessageId: "succ-b702-12-m1",
                        role: "user",
                        content:
                            "Since the operation I cannot manage stairs, so leave out anything that starts with a flight of them.",
                    },
                    {
                        externalMessageId: "succ-b702-12-m2",
                        role: "assistant",
                        content: "Everything I suggest will stay on one level.",
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
                    evidenceQuote:
                        "cut the throat-clearing at the start of an answer",
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
                        content:
                            "Could you cut the throat-clearing at the start of an answer?",
                    },
                    {
                        externalMessageId: "succ-b702-13-m2",
                        role: "assistant",
                        content: "You mean the lead-in before the point?",
                    },
                    {
                        externalMessageId: "succ-b702-13-m3",
                        role: "user",
                        content: "That is the one.",
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
                factValueAll: ["read music"],
                evidence: {
                    evidenceMessageId: "succ-b702-14-m3",
                    evidenceQuote: "I never learned to read music",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-14",
                title: "Where to start",
                messages: [
                    {
                        externalMessageId: "succ-b702-14-m1",
                        role: "user",
                        content:
                            "How would someone pick up the tin whistle from scratch?",
                    },
                    {
                        externalMessageId: "succ-b702-14-m2",
                        role: "assistant",
                        content:
                            "Most people start from sheet music and work through a beginner book.",
                    },
                    {
                        externalMessageId: "succ-b702-14-m3",
                        role: "user",
                        content:
                            "I never learned to read music, so anything that starts from a score is out for me.",
                    },
                    {
                        externalMessageId: "succ-b702-14-m4",
                        role: "assistant",
                        content:
                            "Then I will keep to things you can learn by ear.",
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
                    evidenceQuote:
                        "A month with a borrowed ukulele was enough to tell me it is not for me",
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
                        content:
                            "A month with a borrowed ukulele was enough to tell me it is not for me, so it is off the list.",
                    },
                    {
                        externalMessageId: "succ-b702-15-m2",
                        role: "assistant",
                        content: "Shall I drop it from anything I suggest?",
                    },
                    {
                        externalMessageId: "succ-b702-15-m3",
                        role: "user",
                        content: "Yes, please.",
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
                    evidenceQuote:
                        "A rhetorical question at the top of an answer loses me straight away",
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
                        content:
                            "A rhetorical question at the top of an answer loses me straight away, so please write without them.",
                    },
                    {
                        externalMessageId: "succ-b702-16-m2",
                        role: "assistant",
                        content: "I will state things plainly.",
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
                    evidenceQuote:
                        "Emphasis in italics does not survive the editor I paste into",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-17",
                title: "What survives the paste",
                messages: [
                    {
                        externalMessageId: "succ-b702-17-m1",
                        role: "user",
                        content:
                            "Emphasis in italics does not survive the editor I paste into, so please use something else.",
                    },
                    {
                        externalMessageId: "succ-b702-17-m2",
                        role: "assistant",
                        content: "I will mark emphasis another way.",
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
                factValueAll: ["what you think"],
                evidence: {
                    evidenceMessageId: "succ-b702-18-m1",
                    evidenceQuote:
                        "say what you think anyway and let me weigh it",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-18",
                title: "Where you land",
                messages: [
                    {
                        externalMessageId: "succ-b702-18-m1",
                        role: "user",
                        content:
                            "When you are unsure, say what you think anyway and let me weigh it.",
                    },
                    {
                        externalMessageId: "succ-b702-18-m2",
                        role: "assistant",
                        content: "I will give you my read rather than hedging.",
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
                factValueAll: ["캠핑카"],
                evidence: {
                    evidenceMessageId: "succ-b702-19-m1",
                    evidenceQuote: "캠핑카는 견적까지 받아 보고 사지 않기로 정했습니다.",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-19",
                title: "차",
                messages: [
                    {
                        externalMessageId: "succ-b702-19-m1",
                        role: "user",
                        content: "캠핑카는 견적까지 받아 보고 사지 않기로 정했습니다.",
                    },
                    {
                        externalMessageId: "succ-b702-19-m2",
                        role: "assistant",
                        content: "그럼 캠핑카는 빼고 말씀드릴까요?",
                    },
                    {
                        externalMessageId: "succ-b702-19-m3",
                        role: "user",
                        content: "네, 그렇게 해 주세요.",
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
                factValueAll: ["낚시"],
                evidence: {
                    evidenceMessageId: "succ-b702-20-m1",
                    evidenceQuote: "낚시는 두어 번 따라가 보고 접었습니다.",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-20",
                title: "물가에서",
                messages: [
                    {
                        externalMessageId: "succ-b702-20-m1",
                        role: "user",
                        content: "낚시는 두어 번 따라가 보고 접었습니다. 다시 시작할 생각은 없습니다.",
                    },
                    {
                        externalMessageId: "succ-b702-20-m2",
                        role: "assistant",
                        content: "그럼 그건 빼겠습니다.",
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
                factValueAll: ["주말농장"],
                evidence: {
                    evidenceMessageId: "succ-b702-21-m1",
                    evidenceQuote: "주말농장은 계약을 연장하지 않기로 했습니다.",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-21",
                title: "작년까지 하던 것",
                messages: [
                    {
                        externalMessageId: "succ-b702-21-m1",
                        role: "user",
                        content: "주말농장은 계약을 연장하지 않기로 했습니다. 그 방향은 접었습니다.",
                    },
                    {
                        externalMessageId: "succ-b702-21-m2",
                        role: "assistant",
                        content: "네, 그 전제로 보겠습니다.",
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
                    evidenceQuote: "답변에서 느낌표는 빼 주실 수 있을까요?",
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
                        content: "답변에서 느낌표는 빼 주실 수 있을까요?",
                    },
                    {
                        externalMessageId: "succ-b702-22-m2",
                        role: "assistant",
                        content: "문장은 마침표로만 맺겠습니다.",
                    },
                    {
                        externalMessageId: "succ-b702-22-m3",
                        role: "user",
                        content: "네, 부탁드립니다.",
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
                    evidenceQuote: "온실은 식구들과 얘기해서 두지 않기로 결론이 났습니다.",
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
                        content: "온실은 식구들과 얘기해서 두지 않기로 결론이 났습니다.",
                    },
                    {
                        externalMessageId: "succ-b702-23-m2",
                        role: "assistant",
                        content: "알겠습니다. 그 전제로 보겠습니다.",
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
                factValueAll: ["건조기"],
                evidence: {
                    evidenceMessageId: "succ-b702-24-m1",
                    evidenceQuote: "베란다가 좁아서 건조기를 놓을 자리가 나오지 않습니다.",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-24",
                title: "베란다",
                messages: [
                    {
                        externalMessageId: "succ-b702-24-m1",
                        role: "user",
                        content: "베란다가 좁아서 건조기를 놓을 자리가 나오지 않습니다.",
                    },
                    {
                        externalMessageId: "succ-b702-24-m2",
                        role: "assistant",
                        content: "네, 그건 빼고 보겠습니다.",
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
                    evidenceQuote: "분재는 오래 붙들어 온 분야라 웬만한 건 압니다.",
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
                    evidenceQuote: "삽목은 따로 풀어 주실 것 없습니다.",
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
                        content:
                            "분재는 오래 붙들어 온 분야라 웬만한 건 압니다. 삽목은 따로 풀어 주실 것 없습니다.",
                    },
                    {
                        externalMessageId: "succ-b702-25-m2",
                        role: "assistant",
                        content: "네, 용어는 그대로 쓰겠습니다.",
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
                    evidenceQuote: "새벽시간에는 일정을 잡지 못합니다.",
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
                        content: "새벽시간에는 일정을 잡지 못합니다.",
                    },
                    {
                        externalMessageId: "succ-b702-26-m2",
                        role: "assistant",
                        content: "오전 늦게부터 잡으면 될까요?",
                    },
                    {
                        externalMessageId: "succ-b702-26-m3",
                        role: "user",
                        content: "네, 그 시간대만 빼 주시면 됩니다.",
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
                    evidenceQuote: "조개 알레르기가 있어서 조개가 들어간 메뉴는 못 먹습니다.",
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
                        content: "조개 알레르기가 있어서 조개가 들어간 메뉴는 못 먹습니다.",
                    },
                    {
                        externalMessageId: "succ-b702-27-m2",
                        role: "assistant",
                        content: "그 재료는 빼고 골라 드리겠습니다.",
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
                factValueAll: ["암실"],
                evidence: {
                    evidenceMessageId: "succ-b702-28-m3",
                    evidenceQuote: "암실은 마련할 수 없는 형편입니다.",
                },
                expectedDisposition: "bulk_safe",
            },
        ],
        goldCompleteness: "exhaustive",
        conversations: [
            {
                externalConversationId: "succ-b702-28",
                title: "현상",
                messages: [
                    {
                        externalMessageId: "succ-b702-28-m1",
                        role: "user",
                        content: "필름을 직접 현상하려면 무엇부터 갖춰야 하나요?",
                    },
                    {
                        externalMessageId: "succ-b702-28-m2",
                        role: "assistant",
                        content: "보통은 암실을 먼저 마련하고 그 안에서 작업합니다.",
                    },
                    {
                        externalMessageId: "succ-b702-28-m3",
                        role: "user",
                        content: "암실은 마련할 수 없는 형편입니다. 그게 필요한 방법은 빼 주세요.",
                    },
                    {
                        externalMessageId: "succ-b702-28-m4",
                        role: "assistant",
                        content: "네, 암실 없이 되는 쪽으로만 안내하겠습니다.",
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
                    evidenceQuote: "격주토요일에는 일정을 잡을 수 없습니다.",
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
                        content: "격주토요일에는 일정을 잡을 수 없습니다.",
                    },
                    {
                        externalMessageId: "succ-b702-29-m2",
                        role: "assistant",
                        content: "그 주 토요일은 후보에서 빼 둘까요?",
                    },
                    {
                        externalMessageId: "succ-b702-29-m3",
                        role: "user",
                        content: "네, 비워 두시면 됩니다.",
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
                factValueAll: ["평상"],
                evidence: {
                    evidenceMessageId: "succ-b702-30-m1",
                    evidenceQuote: "마당 바닥이 고르지 않아 평상은 놓을 수 없습니다.",
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
                        content: "마당 바닥이 고르지 않아 평상은 놓을 수 없습니다.",
                    },
                    {
                        externalMessageId: "succ-b702-30-m2",
                        role: "assistant",
                        content: "알겠습니다. 그건 빼고 보겠습니다.",
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
                    evidenceQuote: "자동갱신 결제는 지난달에 다 끊었고 되돌릴 생각이 없습니다.",
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
                        content: "자동갱신 결제는 지난달에 다 끊었고 되돌릴 생각이 없습니다.",
                    },
                    {
                        externalMessageId: "succ-b702-31-m2",
                        role: "assistant",
                        content: "그럼 자동갱신이 붙는 건 빼 드릴까요?",
                    },
                    {
                        externalMessageId: "succ-b702-31-m3",
                        role: "user",
                        content: "네, 빼 주세요.",
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
                    evidenceQuote: "제화는 손에 익을 만큼 다뤄 봤습니다.",
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
                    evidenceQuote: "각인이라는 말도 설명 없이 쓰셔도 됩니다.",
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
                        content:
                            "제화는 손에 익을 만큼 다뤄 봤습니다. 각인이라는 말도 설명 없이 쓰셔도 됩니다.",
                    },
                    {
                        externalMessageId: "succ-b702-32-m2",
                        role: "assistant",
                        content: "네, 그대로 쓰겠습니다.",
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
                factValueAll: ["전세보증금", "9000"],
                evidence: {
                    evidenceMessageId: "succ-b702-33-m1",
                    evidenceQuote: "전세보증금은 9000만 원이 상한입니다.",
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
                        content: "전세보증금은 9000만 원이 상한입니다. 그 위 매물은 볼 수 없습니다.",
                    },
                    {
                        externalMessageId: "succ-b702-33-m2",
                        role: "assistant",
                        content: "그 위쪽은 빼고 보겠습니다.",
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
                    evidenceQuote: "건물 사정으로 기사방문 설치는 받을 수 없습니다.",
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
                        content: "건물 사정으로 기사방문 설치는 받을 수 없습니다.",
                    },
                    {
                        externalMessageId: "succ-b702-34-m2",
                        role: "assistant",
                        content: "직접 설치하는 제품 위주로 보겠습니다.",
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
                factValueAll: ["먼지"],
                evidence: {
                    evidenceMessageId: "succ-b702-35-m1",
                    evidenceQuote: "먼지가 많은 작업은 하지 못합니다.",
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
                        content: "천식이 있어서 먼지가 많은 작업은 하지 못합니다. 일정에서 빼 주세요.",
                    },
                    {
                        externalMessageId: "succ-b702-35-m2",
                        role: "assistant",
                        content: "그런 항목은 빼고 짜겠습니다.",
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
                factValueAll: ["승마"],
                evidence: {
                    evidenceMessageId: "succ-b702-36-m1",
                    evidenceQuote: "승마는 알아보다가 배우지 않기로 정했습니다.",
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
                        content: "승마는 알아보다가 배우지 않기로 정했습니다.",
                    },
                    {
                        externalMessageId: "succ-b702-36-m2",
                        role: "assistant",
                        content: "그럼 그 얘기는 접을까요?",
                    },
                    {
                        externalMessageId: "succ-b702-36-m3",
                        role: "user",
                        content: "네, 접어 주세요.",
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
                    evidenceQuote: "종이접기는 십 년 넘게 해 왔습니다.",
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
                    evidenceQuote: "여백 같은 말은 굳이 풀지 마세요.",
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
                        content: "종이접기는 십 년 넘게 해 왔습니다. 여백 같은 말은 굳이 풀지 마세요.",
                    },
                    {
                        externalMessageId: "succ-b702-37-m2",
                        role: "assistant",
                        content: "네, 바로 들어가겠습니다.",
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
                    evidenceMessageId: "succ-b702-38-m3",
                    evidenceQuote: "물레는 스무 해 가까이 돌려 왔습니다.",
                },
                expectedDisposition: "bulk_safe",
            },
            {
                id: "g2",
                kind: "explanation_depth",
                polarity: "negated",
                factValueAll: ["유약"],
                evidence: {
                    evidenceMessageId: "succ-b702-38-m3",
                    evidenceQuote: "유약 같은 말은 따로 설명하지 않으셔도 됩니다.",
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
                        content: "물레로 뽑은 그릇 표면을 정리하는 순서를 알려 주세요.",
                    },
                    {
                        externalMessageId: "succ-b702-38-m2",
                        role: "assistant",
                        content:
                            "먼저 굽을 깎고, 유약을 어떻게 올릴지 정하는 순서로 보시면 됩니다. 용어는 풀어 드릴까요?",
                    },
                    {
                        externalMessageId: "succ-b702-38-m3",
                        role: "user",
                        content:
                            "물레는 스무 해 가까이 돌려 왔습니다. 유약 같은 말은 따로 설명하지 않으셔도 됩니다.",
                    },
                    {
                        externalMessageId: "succ-b702-38-m4",
                        role: "assistant",
                        content: "네, 용어는 그대로 두겠습니다.",
                    },
                ],
            },
        ],
    },
];
