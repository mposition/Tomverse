/**
 * The last twenty-six replacements, completing all 103.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §12.1 and §12.10.
 * The second half of `durable_facts:en`, on the same B+ reason as tranches 2
 * to 4.
 *
 * ## Four trades, four vocabularies
 *
 * This half holds four two-gold cases of the same shape -- a trade or
 * qualification, plus permission to use its vocabulary unglossed -- which the
 * originals filled with lifeguarding, kitchen fitting, pottery and rescue
 * diving. Writing four replacements that are the same case four times would
 * lose what the repetition was measuring, so each takes a different trade and
 * a different relation to it: a training, twenty years of practice, a living,
 * and an award held without ever having worked in the field.
 *
 * ## What the cell would otherwise have doubled up on
 *
 * `succ-durable-en-312` is tinnitus and `succ-durable-en-109` is migraines
 * from screens; the replacement for the second (tranche 4) is tinnitus, so
 * this one is colour blindness. The same care applies to the recurring-slot
 * cases, which between them had Wednesday, Friday, Saturday and Monday: no
 * two replacements share a day, and none reuses a day tranche 1 or 4 took.
 *
 * **Not wired into any registry.** `succ-4` is assembled once all 103 exist --
 * which, with this file, they do.
 *
 * Every gold here has its `polarity`, `evidenceMessageId` and `evidenceQuote`
 * written out and reviewed one at a time
 * (.github/audits/memory-eval-gold-contract-2026-08-27.md §12.11).
 */

import type { Succ4Replacement } from "@/lib/memoryEvalSucc4Replacements/tranche1";

export const SUCC4_TRANCHE_5: readonly Succ4Replacement[] = [
    {
        originalId: "succ-durable-en-113",
        movedBecause:
            "Read during the 121, where «every week without fail» is emphasis and the " +
            "gold had to be the fixture rather than its frequency.",
        boundary:
            "A recurring slot the user is unreachable in, stated as a standing fixture.",
        differsBy:
            "A fortnightly overnight on-call rather than a weekly choir practice, and " +
            "the gold names the duty beside the day.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-430",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "recurring_context",
                    polarity: "affirmed",
                    factValueAll: ["monday", "on call"],
                    evidence: {
                        evidenceMessageId: "succ-b408-1-m1",
                        evidenceQuote:
                            "Every other Monday I'm on call overnight",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-1",
                    title: "on call",
                    messages: [
                        {
                            externalMessageId: "succ-b408-1-m1",
                            role: "user",
                            content:
                                "Every other Monday I'm on call overnight and unreachable.",
                        },
                        {
                            externalMessageId: "succ-b408-1-m2",
                            role: "assistant",
                            content:
                                "I'll treat those Mondays as gone.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-116",
        movedBecause:
            "Read during the 121: an instruction whose first sentence is marked and " +
            "whose second is affirmative, so the gold had to say which it is drawn " +
            "from.",
        boundary:
            "An instruction refusing a conversational habit, with what to do instead " +
            "named in the same turn.",
        differsBy:
            "A lead-in announcing what is coming rather than an apology, so what is " +
            "refused is how an answer opens rather than how a mistake is handled. The " +
            "first draft refused a thank-you and measured 0.50 against the staying " +
            "succ-durable-en-66, which drops disclaimers in the same two-sentence " +
            "shape.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-431",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "communication_style",
                    polarity: "negated",
                    factValueAll: ["preamble"],
                    evidence: {
                        evidenceMessageId: "succ-b408-2-m1",
                        evidenceQuote:
                            "No preamble about what you're about to do.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-2",
                    title: "straight in",
                    messages: [
                        {
                            externalMessageId: "succ-b408-2-m1",
                            role: "user",
                            content:
                                "No preamble about what you're about to do. The answer, " +
                                "then the reasoning.",
                        },
                        {
                            externalMessageId: "succ-b408-2-m2",
                            role: "assistant",
                            content:
                                "Answer first, reasoning after.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-122",
        movedBecause:
            "Read during the 121, where the language is affirmed of the reply rather " +
            "than of the user and the reading had to keep the two apart.",
        boundary:
            "A standing instruction about which language the assistant answers in, with " +
            "the reason in the same turn.",
        differsBy:
            "Portuguese rather than French, and the reason given is exposure rather " +
            "than practice.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-432",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "language",
                    polarity: "affirmed",
                    factValueAll: ["portuguese"],
                    evidence: {
                        evidenceMessageId: "succ-b408-3-m1",
                        evidenceQuote:
                            "Write back to me in Portuguese from here on",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-3",
                    title: "reply language",
                    messages: [
                        {
                            externalMessageId: "succ-b408-3-m1",
                            role: "user",
                            content:
                                "Write back to me in Portuguese from here on — I want " +
                                "the exposure.",
                        },
                        {
                            externalMessageId: "succ-b408-3-m2",
                            role: "assistant",
                            content:
                                "Combinado, sigo em português.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-128",
        movedBecause:
            "Read during the 121: an ability denied of the user with a parenthetical " +
            "reason and a consequence, three clauses in one sentence.",
        boundary:
            "An ability the user never acquired, which rules out anything that assumes it.",
        differsBy:
            "Swimming rather than driving, and what it rules out is a setting rather " +
            "than a mode of transport.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-433",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "negated",
                    factValueAll: ["swim"],
                    evidence: {
                        evidenceMessageId: "succ-b408-4-m1",
                        evidenceQuote:
                            "Swimming is not something I ever learned",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-4",
                    title: "never learned",
                    messages: [
                        {
                            externalMessageId: "succ-b408-4-m1",
                            role: "user",
                            content:
                                "Swimming is not something I ever learned, so anything " +
                                "in open water is out.",
                        },
                        {
                            externalMessageId: "succ-b408-4-m2",
                            role: "assistant",
                            content:
                                "I'll keep everything on dry land.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-130",
        movedBecause:
            "Read during the 121: a missing piece of equipment denied of the user's " +
            "place, with the instruction that follows it also marked.",
        boundary:
            "A piece of equipment the user's place does not have, which excludes " +
            "everything that assumes it.",
        differsBy:
            "A fridge in an office rather than a printer at home, and what is ruled out " +
            "is anything that must be kept cold rather than anything on paper.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-434",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "negated",
                    factValueAll: ["fridge"],
                    evidence: {
                        evidenceMessageId: "succ-b408-5-m1",
                        evidenceQuote:
                            "We have no fridge in the office",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-5",
                    title: "nothing chilled",
                    messages: [
                        {
                            externalMessageId: "succ-b408-5-m1",
                            role: "user",
                            content:
                                "We have no fridge in the office, so nothing that has " +
                                "to be kept cold.",
                        },
                        {
                            externalMessageId: "succ-b408-5-m2",
                            role: "assistant",
                            content:
                                "Shelf-stable only, then.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-146",
        movedBecause:
            "Read during the 121 as a pair whose two golds are both affirmed from one " +
            "sentence, which the assignment rule had to admit as readily as a mixed " +
            "pair.",
        boundary:
            "A qualification plus permission to use its vocabulary unexplained, two " +
            "affirmed golds in one sentence.",
        differsBy:
            "Wine rather than water safety, and the qualification is a training rather " +
            "than a certification.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-435",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "expertise",
                    polarity: "affirmed",
                    factValueAll: ["sommelier"],
                    evidence: {
                        evidenceMessageId: "succ-b408-6-m1",
                        evidenceQuote:
                            "I'm a trained sommelier",
                    },
                    expectedDisposition: "bulk_safe",
                },
                {
                    id: "e2",
                    kind: "explanation_depth",
                    polarity: "affirmed",
                    factValueAll: ["terminology"],
                    evidence: {
                        evidenceMessageId: "succ-b408-6-m1",
                        evidenceQuote:
                            "wine terminology can stay as it is",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-6",
                    title: "terms as they are",
                    messages: [
                        {
                            externalMessageId: "succ-b408-6-m1",
                            role: "user",
                            content:
                                "I'm a trained sommelier, so wine terminology can stay " +
                                "as it is.",
                        },
                        {
                            externalMessageId: "succ-b408-6-m2",
                            role: "assistant",
                            content:
                                "Then I'll write it the way the trade does.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-153",
        movedBecause:
            "Read during the 121: a thing given up and a decision not to take it up " +
            "again, where the gold had to say whether it asserts the thing or its " +
            "absence.",
        boundary:
            "Something given up together with a decision not to take it up again, so it " +
            "is denied of the user going forward.",
        differsBy:
            "A newspaper delivery rather than a television, so what is denied is a " +
            "recurring delivery rather than an object in the house, and the sentence is " +
            "built round the delivery stopping rather than round the household " +
            "disposing of something.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-436",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "decision",
                    polarity: "negated",
                    factValueAll: ["newspaper"],
                    evidence: {
                        evidenceMessageId: "succ-b408-7-m1",
                        evidenceQuote:
                            "The newspaper stopped coming years ago at our request.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-7",
                    title: "not renewing it",
                    messages: [
                        {
                            externalMessageId: "succ-b408-7-m1",
                            role: "user",
                            content:
                                "The newspaper stopped coming years ago at our request. " +
                                "Nobody here wants it back.",
                        },
                        {
                            externalMessageId: "succ-b408-7-m2",
                            role: "assistant",
                            content:
                                "I'll leave print subscriptions out of it.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-160",
        movedBecause:
            "Read during the 121, where «no exceptions» is emphasis and the gold had to " +
            "be the fixture rather than its invariance.",
        boundary:
            "A weekly fixture stated as invariant, which takes the same slot out of every week.",
        differsBy:
            "A Friday-night shift on a door rather than Saturday-morning football, so " +
            "the fixture is paid work rather than a game.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-437",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "recurring_context",
                    polarity: "affirmed",
                    factValueAll: ["friday"],
                    evidence: {
                        evidenceMessageId: "succ-b408-8-m1",
                        evidenceQuote:
                            "Friday nights I'm on the door at the club",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-8",
                    title: "on the door",
                    messages: [
                        {
                            externalMessageId: "succ-b408-8-m1",
                            role: "user",
                            content:
                                "Friday nights I'm on the door at the club, every week.",
                        },
                        {
                            externalMessageId: "succ-b408-8-m2",
                            role: "assistant",
                            content:
                                "I'll keep Friday nights out of anything I propose.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-162",
        movedBecause:
            "Read during the 121, where [\"not sure\"] is a phrase from the condition " +
            "clause rather than the instruction, and settling that reading shaped the " +
            "rule.",
        boundary:
            "An instruction about what to do when the assistant cannot give one clean answer.",
        differsBy:
            "Conflicting sources rather than uncertainty, so what is asked for is that " +
            "a disagreement be shown rather than that ignorance be admitted.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-438",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "communication_style",
                    polarity: "affirmed",
                    factValueAll: ["disagree"],
                    evidence: {
                        evidenceMessageId: "succ-b408-9-m1",
                        evidenceQuote:
                            "tell me they disagree rather than picking one",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-9",
                    title: "when they conflict",
                    messages: [
                        {
                            externalMessageId: "succ-b408-9-m1",
                            role: "user",
                            content:
                                "When the sources disagree, tell me they disagree " +
                                "rather than picking one.",
                        },
                        {
                            externalMessageId: "succ-b408-9-m2",
                            role: "assistant",
                            content:
                                "I'll set out both readings when they conflict.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-164",
        movedBecause:
            "Read during the 121: a two-word prohibition followed by an affirmative " +
            "fragment, where the gold's value sits in the marked half.",
        boundary:
            "A register instruction phrased as a refusal, with the wanted register " +
            "named beside it.",
        differsBy:
            "Metaphors rather than jokes, so what is refused is figurative language " +
            "rather than humour.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-439",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "tone",
                    polarity: "negated",
                    factValueAll: ["metaphor"],
                    evidence: {
                        evidenceMessageId: "succ-b408-10-m1",
                        evidenceQuote:
                            "Leave the metaphors out.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-10",
                    title: "say the thing itself",
                    messages: [
                        {
                            externalMessageId: "succ-b408-10-m1",
                            role: "user",
                            content:
                                "Leave the metaphors out. Say the thing itself.",
                        },
                        {
                            externalMessageId: "succ-b408-10-m2",
                            role: "assistant",
                            content:
                                "I'll say it directly.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-166",
        movedBecause:
            "Read during the 121, where «not prose» is the marked half and the gold is " +
            "drawn from the affirmed one.",
        boundary:
            "A layout instruction attached to a kind of content, with the rejected " +
            "layout named beside it.",
        differsBy:
            "A table for comparisons rather than numbered steps for procedures, so the " +
            "structure attaches to a different kind of content.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-440",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "structure",
                    polarity: "affirmed",
                    factValueAll: ["table"],
                    evidence: {
                        evidenceMessageId: "succ-b408-11-m1",
                        evidenceQuote:
                            "Put comparisons in a table.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-11",
                    title: "put it in a table",
                    messages: [
                        {
                            externalMessageId: "succ-b408-11-m1",
                            role: "user",
                            content:
                                "Put comparisons in a table. A paragraph comparing " +
                                "three things is unreadable.",
                        },
                        {
                            externalMessageId: "succ-b408-11-m2",
                            role: "assistant",
                            content:
                                "I'll tabulate anything with more than two options.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-167",
        movedBecause:
            "Read during the 121: a formatting prohibition with its reason in the " +
            "second sentence, where the gold is the thing refused.",
        boundary:
            "A formatting element the user refuses, with a practical reason given in " +
            "the same turn.",
        differsBy:
            "Bold formatting rather than emoji, and the reason is that the markup does " +
            "not survive rather than that it looks wrong.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-441",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "formatting",
                    polarity: "negated",
                    factValueAll: ["bold"],
                    evidence: {
                        evidenceMessageId: "succ-b408-12-m1",
                        evidenceQuote:
                            "Skip the bold.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-12",
                    title: "plain text",
                    messages: [
                        {
                            externalMessageId: "succ-b408-12-m1",
                            role: "user",
                            content:
                                "Skip the bold. It survives nothing I paste into.",
                        },
                        {
                            externalMessageId: "succ-b408-12-m2",
                            role: "assistant",
                            content:
                                "Plain text throughout.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-168",
        movedBecause:
            "Read during the 121 beside its French pair, where the language is affirmed " +
            "of the reply and not of the user.",
        boundary:
            "A standing instruction about which language the assistant answers in, with " +
            "the reason in the same turn.",
        differsBy:
            "Dutch rather than Italian, and the reason is a gap between reading and " +
            "speaking rather than habit. German was the first draft and measured 0.61 " +
            "against the staying succ-durable-en-72, which is already a standing " +
            "instruction to answer in German.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-442",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "language",
                    polarity: "affirmed",
                    factValueAll: ["dutch"],
                    evidence: {
                        evidenceMessageId: "succ-b408-13-m1",
                        evidenceQuote:
                            "From here on answer me in Dutch",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-13",
                    title: "answer language",
                    messages: [
                        {
                            externalMessageId: "succ-b408-13-m1",
                            role: "user",
                            content:
                                "From here on answer me in Dutch; I read it faster than " +
                                "I speak it.",
                        },
                        {
                            externalMessageId: "succ-b408-13-m2",
                            role: "assistant",
                            content:
                                "Vanaf nu antwoord ik in het Nederlands.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-173",
        movedBecause:
            "Read during the 121: an ability denied of the user with the requirement " +
            "that follows it stated as a fragment.",
        boundary:
            "A physical limit the user denies of themselves, with the accommodation it " +
            "requires named in the same turn and held for review.",
        differsBy:
            "Standing rather than stairs, and the requirement is somewhere to sit at " +
            "each stage rather than step-free access to a place.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-443",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "negated",
                    factValueAll: ["standing"],
                    evidence: {
                        evidenceMessageId: "succ-b408-14-m1",
                        evidenceQuote:
                            "Standing for long is not possible for me",
                    },
                    expectedDisposition: "sensitive_review",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-14",
                    title: "somewhere to sit",
                    messages: [
                        {
                            externalMessageId: "succ-b408-14-m1",
                            role: "user",
                            content:
                                "Standing for long is not possible for me — I need " +
                                "somewhere to sit at every stage.",
                        },
                        {
                            externalMessageId: "succ-b408-14-m2",
                            role: "assistant",
                            content:
                                "I'll make sure every step has a seat.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-177",
        movedBecause:
            "Read during the 121, where the first sentence affirms a habit and the " +
            "second denies the alternative, and the gold is drawn from the first.",
        boundary:
            "A working habit affirmed of the user, with what does not work for them " +
            "named beside it.",
        differsBy:
            "Reading on paper rather than writing by hand, so the preference is about " +
            "how material is taken in rather than how it is recorded.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-444",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "preference",
                    polarity: "affirmed",
                    factValueAll: ["paper"],
                    evidence: {
                        evidenceMessageId: "succ-b408-15-m1",
                        evidenceQuote:
                            "I read on paper.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-15",
                    title: "on paper",
                    messages: [
                        {
                            externalMessageId: "succ-b408-15-m1",
                            role: "user",
                            content:
                                "I read on paper. Anything long on a screen slides " +
                                "straight past me.",
                        },
                        {
                            externalMessageId: "succ-b408-15-m2",
                            role: "assistant",
                            content:
                                "I'll keep things printable and short-lined.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-178",
        movedBecause:
            "Read during the 121, where «rather than supermarkets» is a contrast clause " +
            "and the gold is the choice the user makes.",
        boundary:
            "A habitual choice between two options, stated with the rejected one beside it.",
        differsBy:
            "Borrowing before buying rather than choosing markets over supermarkets, so " +
            "the preference is about acquiring rather than about where.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-445",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "preference",
                    polarity: "affirmed",
                    factValueAll: ["library"],
                    evidence: {
                        evidenceMessageId: "succ-b408-16-m1",
                        evidenceQuote:
                            "I borrow from the library before I buy anything",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-16",
                    title: "before buying",
                    messages: [
                        {
                            externalMessageId: "succ-b408-16-m1",
                            role: "user",
                            content:
                                "I borrow from the library before I buy anything, " +
                                "whenever there's a copy.",
                        },
                        {
                            externalMessageId: "succ-b408-16-m2",
                            role: "assistant",
                            content:
                                "I'll say what's likely to be on the shelves.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-181",
        movedBecause:
            "Read during the 121 as another English pair whose two golds take opposite " +
            "signs from one sentence.",
        boundary:
            "Long experience plus an explicit refusal of an explanation, two golds of " +
            "opposite sign in one sentence.",
        differsBy:
            "Offshore navigation and bearings rather than chess and openings, and the " +
            "experience is stated as the job held since school. The first draft opened " +
            "«I've done X for two decades —» and measured 0.50 against the staying " +
            "succ-durable-en-143, which opens the same way about calligraphy.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-446",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "expertise",
                    polarity: "affirmed",
                    factValueAll: ["navigation"],
                    evidence: {
                        evidenceMessageId: "succ-b408-17-m1",
                        evidenceQuote:
                            "Offshore navigation has been my job since I left school",
                    },
                    expectedDisposition: "bulk_safe",
                },
                {
                    id: "e2",
                    kind: "explanation_depth",
                    polarity: "negated",
                    factValueAll: ["bearing"],
                    evidence: {
                        evidenceMessageId: "succ-b408-17-m1",
                        evidenceQuote:
                            "a bearing needs no explanation",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-17",
                    title: "no need to unpack it",
                    messages: [
                        {
                            externalMessageId: "succ-b408-17-m1",
                            role: "user",
                            content:
                                "Offshore navigation has been my job since I left " +
                                "school, so a bearing needs no explanation.",
                        },
                        {
                            externalMessageId: "succ-b408-17-m2",
                            role: "assistant",
                            content:
                                "I'll use the terms without unpacking them.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-199",
        movedBecause:
            "Read during the 121: a named condition affirmed of the user with the " +
            "exclusion it produces in the same sentence.",
        boundary:
            "A named medical condition producing a dietary exclusion, held for review " +
            "and affirmed of the user.",
        differsBy:
            "Hereditary fructose intolerance rather than lactose intolerance, so the " +
            "excluded ingredient is a sugar rather than a dairy protein. Coeliac " +
            "disease was the first draft and cannot be used: succ-durable-en-126 stays " +
            "in the corpus and is already a coeliac excluding gluten.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-447",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "e1",
                    kind: "constraint",
                    polarity: "affirmed",
                    factValueAll: ["fructose"],
                    evidence: {
                        evidenceMessageId: "succ-b408-18-m1",
                        evidenceQuote:
                            "I have hereditary fructose intolerance",
                    },
                    expectedDisposition: "sensitive_review",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-18",
                    title: "nothing with gluten",
                    messages: [
                        {
                            externalMessageId: "succ-b408-18-m1",
                            role: "user",
                            content:
                                "I have hereditary fructose intolerance, so anything " +
                                "sweetened with fruit sugar is out.",
                        },
                        {
                            externalMessageId: "succ-b408-18-m2",
                            role: "assistant",
                            content:
                                "I'll avoid fruit sugars in anything I suggest.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-302",
        movedBecause:
            "Read during the 121, where a shared resource is affirmed and the schedule " +
            "it rules out is denied, in one sentence.",
        boundary:
            "A resource shared with others, which makes a fixed personal routine impossible.",
        differsBy:
            "A shared desk across shifts rather than a single bathroom in a house, so " +
            "the shared resource is at work rather than at home.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-448",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "g1",
                    kind: "constraint",
                    polarity: "affirmed",
                    factValueAll: ["desk"],
                    evidence: {
                        evidenceMessageId: "succ-b408-19-m1",
                        evidenceQuote:
                            "We share one desk between three shifts",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-19",
                    title: "one desk",
                    messages: [
                        {
                            externalMessageId: "succ-b408-19-m1",
                            role: "user",
                            content:
                                "We share one desk between three shifts, so a fixed " +
                                "working hour is not something I can promise.",
                        },
                        {
                            externalMessageId: "succ-b408-19-m2",
                            role: "assistant",
                            content:
                                "I won't assume you're at it at any particular hour.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-303",
        movedBecause:
            "Read during the 121: a diagnosis affirmed of the user whose consequence " +
            "clause is negated, which is the pair the rule separates.",
        boundary:
            "A named injury producing a physical limit, held for review.",
        differsBy:
            "A shoulder impingement limiting reach rather than a slipped disc limiting " +
            "sitting, so the limit is on a movement rather than on duration.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-449",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "g1",
                    kind: "constraint",
                    polarity: "affirmed",
                    factValueAll: ["impingement"],
                    evidence: {
                        evidenceMessageId: "succ-b408-20-m1",
                        evidenceQuote:
                            "I have a shoulder impingement",
                    },
                    expectedDisposition: "sensitive_review",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-20",
                    title: "nothing overhead",
                    messages: [
                        {
                            externalMessageId: "succ-b408-20-m1",
                            role: "user",
                            content:
                                "I have a shoulder impingement, so I can't hold " +
                                "anything above head height.",
                        },
                        {
                            externalMessageId: "succ-b408-20-m2",
                            role: "assistant",
                            content:
                                "Nothing overhead, then.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-304",
        movedBecause:
            "Read during the 121, where a status is affirmed of the user and the clause " +
            "after it says the rules are never one set, which reads as a denial.",
        boundary:
            "A status that makes any single body of rules the wrong answer, affirmed of " +
            "the user.",
        differsBy:
            "Dual citizenship rather than dual tax residency, so what doubles is travel " +
            "rules rather than tax rules.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-450",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "g1",
                    kind: "identity",
                    polarity: "affirmed",
                    factValueAll: ["two passports"],
                    evidence: {
                        evidenceMessageId: "succ-b408-21-m1",
                        evidenceQuote:
                            "I hold two passports",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-21",
                    title: "two sets of rules",
                    messages: [
                        {
                            externalMessageId: "succ-b408-21-m1",
                            role: "user",
                            content:
                                "I hold two passports, so the rules for travel are " +
                                "never a single set.",
                        },
                        {
                            externalMessageId: "succ-b408-21-m2",
                            role: "assistant",
                            content:
                                "I'll say which one each answer depends on.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-305",
        movedBecause:
            "Read during the 121 as a two-gold turn where both are affirmed and the " +
            "second is a permission rather than a preference.",
        boundary:
            "A trade plus permission to use its vocabulary unglossed, two affirmed " +
            "golds in one sentence with sample words quoted.",
        differsBy:
            "Stonemasonry rather than kitchen fitting, and the two named words are " +
            "tools and cuts of the trade rather than parts of a unit. The first draft " +
            "kept the original's «Twenty years ..., so you can say X and Y without " +
            "unpacking» frame and measured 0.59 against it.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-451",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "g1",
                    kind: "occupation",
                    polarity: "affirmed",
                    factValueAll: ["stonemasonry"],
                    evidence: {
                        evidenceMessageId: "succ-b408-22-m1",
                        evidenceQuote:
                            "Stonemasonry is what I do",
                    },
                    expectedDisposition: "bulk_safe",
                },
                {
                    id: "g2",
                    kind: "explanation_depth",
                    polarity: "affirmed",
                    factValueAll: ["gloss"],
                    evidence: {
                        evidenceMessageId: "succ-b408-22-m1",
                        evidenceQuote:
                            "\"banker\" and \"pitching face\" need no gloss",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-22",
                    title: "trade words",
                    messages: [
                        {
                            externalMessageId: "succ-b408-22-m1",
                            role: "user",
                            content:
                                "Stonemasonry is what I do; \"banker\" and \"pitching " +
                                "face\" need no gloss.",
                        },
                        {
                            externalMessageId: "succ-b408-22-m2",
                            role: "assistant",
                            content:
                                "I'll leave the trade words as they are.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-308",
        movedBecause:
            "Read during the 121 as a two-gold turn where the second gold's value was " +
            "the word 'term' rather than a term.",
        boundary:
            "A trade plus permission to use its vocabulary unglossed, two affirmed " +
            "golds in one sentence.",
        differsBy:
            "Bookbinding rather than pottery, and the second gold names the term that " +
            "may go unexplained rather than the category of terms.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-452",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "g1",
                    kind: "occupation",
                    polarity: "affirmed",
                    factValueAll: ["bookbinding"],
                    evidence: {
                        evidenceMessageId: "succ-b408-23-m1",
                        evidenceQuote:
                            "Bookbinding is my living",
                    },
                    expectedDisposition: "bulk_safe",
                },
                {
                    id: "g2",
                    kind: "explanation_depth",
                    polarity: "affirmed",
                    factValueAll: ["signature"],
                    evidence: {
                        evidenceMessageId: "succ-b408-23-m1",
                        evidenceQuote:
                            "you can write \"signature\" and \"headband\" straight",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-23",
                    title: "binding vocabulary",
                    messages: [
                        {
                            externalMessageId: "succ-b408-23-m1",
                            role: "user",
                            content:
                                "Bookbinding is my living, so you can write \"signature\" " +
                                "and \"headband\" straight.",
                        },
                        {
                            externalMessageId: "succ-b408-23-m2",
                            role: "assistant",
                            content:
                                "I'll use the binding vocabulary as it stands.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-311",
        movedBecause:
            "Read during the 121, where «who weren't» is a marked contrast clause " +
            "hanging off an affirmed relationship.",
        boundary:
            "A family fact where the relation is affirmed and a contrast clause about " +
            "it carries the marker.",
        differsBy:
            "Being raised by a grandmother rather than being adopted, and the sibling " +
            "is younger and named by where she grew up rather than by what she was not.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-453",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "g1",
                    kind: "relationship",
                    polarity: "affirmed",
                    factValueAll: ["sister"],
                    evidence: {
                        evidenceMessageId: "succ-b408-24-m1",
                        evidenceQuote:
                            "I have a younger sister who grew up with our parents.",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-24",
                    title: "how we grew up",
                    messages: [
                        {
                            externalMessageId: "succ-b408-24-m1",
                            role: "user",
                            content:
                                "My grandmother raised me. I have a younger sister who " +
                                "grew up with our parents.",
                        },
                        {
                            externalMessageId: "succ-b408-24-m2",
                            role: "assistant",
                            content:
                                "Understood.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-312",
        movedBecause:
            "Read during the 121: a condition affirmed of the user with a consequence " +
            "clause that is negated, and the gold had to be drawn from the first.",
        boundary:
            "A sensory condition that makes one channel unusable, held for review.",
        differsBy:
            "Colour blindness and colour-coding rather than tinnitus and audio cues, so " +
            "the channel that fails is visual rather than aural.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-454",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "g1",
                    kind: "constraint",
                    polarity: "affirmed",
                    factValueAll: ["colour blind"],
                    evidence: {
                        evidenceMessageId: "succ-b408-25-m1",
                        evidenceQuote:
                            "I'm red-green colour blind",
                    },
                    expectedDisposition: "sensitive_review",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-25",
                    title: "not by colour",
                    messages: [
                        {
                            externalMessageId: "succ-b408-25-m1",
                            role: "user",
                            content:
                                "I'm red-green colour blind, so anything that codes " +
                                "meaning by colour alone is lost on me.",
                        },
                        {
                            externalMessageId: "succ-b408-25-m2",
                            role: "assistant",
                            content:
                                "I'll label rather than colour-code.",
                        },
                    ],
                },
            ],
        },
    },
    {
        originalId: "succ-durable-en-320",
        movedBecause:
            "Read during the 121, where a qualification is affirmed and «I've never " +
            "worked in the field» is denied of the same user in the same sentence.",
        boundary:
            "A qualification held without professional practice, plus permission to use " +
            "its notation, with an affirmed and a denied clause about the same person " +
            "in one sentence.",
        differsBy:
            "A mountain leader award rather than a rescue diving certification, and the " +
            "notation left unexplained is a walking-time rule rather than a " +
            "decompression table. The first draft kept the original's «I hold a X, " +
            "though I've never ..., — Y can go in unexplained» frame and measured 0.55 " +
            "against it.",
        settledByExistingContract: true,
        replacement: {
            id: "succ-durable-en-455",
            category: "durable_facts",
            language: "en",
            goldCompleteness: "exhaustive",
            expected: [
                {
                    id: "g1",
                    kind: "expertise",
                    polarity: "affirmed",
                    factValueAll: ["mountain leader"],
                    evidence: {
                        evidenceMessageId: "succ-b408-26-m1",
                        evidenceQuote:
                            "There's a mountain leader award on my wall",
                    },
                    expectedDisposition: "bulk_safe",
                },
                {
                    id: "g2",
                    kind: "explanation_depth",
                    polarity: "affirmed",
                    factValueAll: ["naismith"],
                    evidence: {
                        evidenceMessageId: "succ-b408-26-m1",
                        evidenceQuote:
                            "Naismith's rule needs no footnote",
                    },
                    expectedDisposition: "bulk_safe",
                },
            ],
            conversations: [
                {
                    externalConversationId: "succ-b408-26",
                    title: "held, not practised",
                    messages: [
                        {
                            externalMessageId: "succ-b408-26-m1",
                            role: "user",
                            content:
                                "There's a mountain leader award on my wall that I've " +
                                "never used professionally, so Naismith's rule needs no " +
                                "footnote.",
                        },
                        {
                            externalMessageId: "succ-b408-26-m2",
                            role: "assistant",
                            content:
                                "I'll use it as it stands.",
                        },
                    ],
                },
            ],
        },
    },
];
