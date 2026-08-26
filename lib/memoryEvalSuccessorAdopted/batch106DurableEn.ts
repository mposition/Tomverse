/**
 * Successor batch batch-106 — `durable_facts:en`. **Adopted. This is the successor dataset.**
 *
 * Not dataset. Nothing scores these until a person adopts them
 * (`docs/ops/memory-extraction-eval-dataset.md` §6.2).
 *
 * A schema-2 rework of `lib/memoryExtractionEvalAdopted/batch010DurableEn.ts`.
 * Conversations are copied unchanged; the labelling follows
 * `docs/ops/memory-extraction-eval-dataset.md` §4.1.1–§4.1.3. Cases that
 * could not carry an exhaustive gold were rewritten instead, and those
 * declare no `sourceCaseId` because they copy nothing.
 *
 * What changed, case by case:
 * `docs/ops/memory-extraction-eval-batches/batch-102-114-rework-notes.md`.
 */

import type { MemoryEvalCaseV2 } from "@/lib/memoryEvalDatasetSchema";

let sequence = 0;
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`;

const conversation = (
    title: string,
    turns: readonly (readonly [role: "user" | "assistant", content: string])[]
) => {
    const id = nextId("succ-b106");
    return {
        externalConversationId: id,
        title,
        messages: turns.map(([role, content], index) => ({
            externalMessageId: `${id}-m${index + 1}`,
            role,
            content,
        })),
    };
};

export const BATCH_106_DURABLE_EN: readonly MemoryEvalCaseV2[] = [
    {
        id: "succ-durable-en-51",
        sourceCaseId: "cand-durable-en2-26",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["renting"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Housing", [
                ["user", "We decided to keep renting rather than buy. It's a deliberate choice, not a temporary one."],
                ["assistant", "I'll stop framing options around ownership."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-52",
        sourceCaseId: "cand-durable-en2-27",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["car"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Getting around", [
                ["user", "We got rid of the car last year and decided not to replace it."],
                ["assistant", "I'll assume no car when suggesting routes."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-53",
        sourceCaseId: "cand-durable-en2-28",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["supplier"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Sourcing", [
                ["user", "After the last mess we decided to consolidate to one supplier. That call is made."],
                ["assistant", "I'll treat multi-sourcing as off the table."],
            ]),
        ],
    },
    {
        // Re-labelled from `relationship` and normalised. A third party's
        // diagnosis is not the memory; the household cooking constraint it
        // creates is. Neither token is satisfied by "the user's daughter is
        // coeliac", which is the profile form this gold has to refuse.
        id: "succ-durable-en-54",
        sourceCaseId: "cand-durable-en2-29",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["gluten", "home"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("Cooking for the house", [
                ["user", "My daughter is coeliac, so anything I cook at home has to be gluten free."],
                ["assistant", "I'll keep household recipes gluten free."],
            ]),
        ],
    },
    {
        // Where a family member lives is not health information.
        id: "succ-durable-en-55",
        sourceCaseId: "cand-durable-en2-30",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["mother", "japan"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Family abroad", [
                ["user", "My mother lives in Japan and I visit twice a year."],
                ["assistant", "I'll bear the time difference in mind."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-56",
        sourceCaseId: "cand-durable-en2-31",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["co-founder"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Who I work with", [
                ["user", "I have a co-founder, and any decision about equity or hiring goes through both of us."],
                ["assistant", "I'll frame those as joint decisions."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-57",
        sourceCaseId: "cand-durable-en2-32",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["flatmate"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Living situation", [
                ["user", "I live with three flatmates, so anything involving space or noise is constrained."],
                ["assistant", "I'll account for shared space."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-58",
        sourceCaseId: "cand-durable-en2-33",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["internet"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Connection", [
                ["user", "My internet at home is barely faster than dial-up, so don't suggest anything that streams."],
                ["assistant", "I'll stick to low-bandwidth options."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-59",
        sourceCaseId: "cand-durable-en2-34",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["shellfish"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("Allergy", [
                ["user", "Severe shellfish allergy here. Please never include it in a recipe suggestion."],
                ["assistant", "I'll exclude shellfish entirely."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-60",
        sourceCaseId: "cand-durable-en2-35",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["windows"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("What I run", [
                ["user", "I'm on Windows only. No Mac, no Linux box, so shell instructions need to work there."],
                ["assistant", "I'll give Windows-native steps."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-61",
        sourceCaseId: "cand-durable-en2-36",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["30 minutes"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Time available", [
                ["user", "I have about 30 minutes a day for this and no more. Plans that assume two hours are useless to me."],
                ["assistant", "I'll size everything to that."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-62",
        sourceCaseId: "cand-durable-en2-37",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["phone"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Contact method", [
                ["user", "I can't take phone calls at work, so anything requiring a call has to wait until evening."],
                ["assistant", "I'll prefer written channels."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-63",
        sourceCaseId: "cand-durable-en2-38",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["monday"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Standing commitment", [
                ["user", "Every Monday morning I'm in a two-hour review that I can't move."],
                ["assistant", "I'll keep Monday mornings clear."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-64",
        sourceCaseId: "cand-durable-en2-39",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["quarter"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Cycle", [
                ["user", "We close the books at the end of each quarter and that week is always chaos."],
                ["assistant", "I'll avoid scheduling anything into those weeks."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-65",
        sourceCaseId: "cand-durable-en2-40",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["school run"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Daily fixture", [
                ["user", "I do the school run at half three every weekday, so afternoons are broken up."],
                ["assistant", "I'll treat mid-afternoon as unavailable."],
            ]),
        ],
    },
    {
        // Residual: dropping hedges is about how the exchange is conducted, not
        // about register, length, order or format.
        id: "succ-durable-en-66",
        sourceCaseId: "cand-durable-en2-41",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "communication_style",
                mustInclude: ["disclaimer"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("How to answer", [
                ["user", "Please drop the disclaimers. Just tell me what you think and I'll decide what to do with it."],
                ["assistant", "I'll answer directly."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-67",
        sourceCaseId: "cand-durable-en2-42",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "communication_style",
                mustInclude: ["clarifying"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Check first", [
                ["user", "If my question is ambiguous, ask me one clarifying question before answering. Don't guess."],
                ["assistant", "I'll ask rather than assume."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-68",
        sourceCaseId: "cand-durable-en2-43",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "tone",
                mustInclude: ["formal"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Register", [
                ["user", "Keep it formal, please. I often paste your answers straight into work email."],
                ["assistant", "I'll write in a formal register."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-69",
        sourceCaseId: "cand-durable-en2-44",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "verbosity",
                mustInclude: ["short"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Length", [
                ["user", "Short answers. A paragraph at most unless I ask you to expand."],
                ["assistant", "I'll keep replies brief."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-70",
        sourceCaseId: "cand-durable-en2-45",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "structure",
                mustInclude: ["conclusion"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Order", [
                ["user", "Give me the conclusion first and the reasoning after it. I often only read the first line."],
                ["assistant", "I'll lead with the answer."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-71",
        sourceCaseId: "cand-durable-en2-46",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "formatting",
                mustInclude: ["table"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Layout", [
                ["user", "Use tables when you're comparing things. Prose comparisons are hard for me to follow."],
                ["assistant", "I'll put comparisons in a table."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-72",
        sourceCaseId: "cand-durable-en2-47",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "language",
                mustInclude: ["german"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Reply language", [
                ["user", "Answer me in German even when I write in English. I'm trying to keep it up."],
                ["assistant", "Ich antworte ab jetzt auf Deutsch."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-73",
        sourceCaseId: "cand-durable-en2-48",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "explanation_depth",
                mustInclude: ["trade-off"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("How deep", [
                ["user", "Don't just give me the recommendation — walk me through the trade-offs behind it."],
                ["assistant", "I'll lay out the alternatives too."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-74",
        sourceCaseId: "cand-durable-en2-49",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "citation_preference",
                mustInclude: ["primary"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Evidence", [
                ["user", "When you cite something, point me at primary sources rather than summaries."],
                ["assistant", "I'll link the original where I can."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-75",
        sourceCaseId: "cand-durable-en2-50",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "code_style",
                mustInclude: ["test"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Code examples", [
                ["user", "Any code example you give me should come with a test. That's how I read code."],
                ["assistant", "I'll include a test alongside each example."],
            ]),
        ],
    },
];
