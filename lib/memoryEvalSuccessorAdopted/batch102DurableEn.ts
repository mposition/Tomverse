/**
 * Successor batch batch-102 — `durable_facts:en`. **Adopted. This is the successor dataset.**
 *
 * Not dataset. Nothing scores these until a person adopts them
 * (`docs/ops/memory-extraction-eval-dataset.md` §6.2).
 *
 * A schema-2 rework of `lib/memoryExtractionEvalAdopted/batch002DurableEn.ts`.
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
    const id = nextId("succ-b102");
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

export const BATCH_102_DURABLE_EN: readonly MemoryEvalCaseV2[] = [
    {
        // The job and the shift pattern are each useful without the other.
        // "mostly nights this quarter" is time-boxed, so it is not durable and is
        // not gold.
        id: "succ-durable-en-1",
        sourceCaseId: "cand-durable-en-1",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["paramedic"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "recurring_context",
                mustInclude: ["twelve-hour"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Shift work", [
                ["user", "I'm a paramedic, twelve-hour shifts, mostly nights this quarter. Any advice on eating properly when the schedule is like that?"],
                ["assistant", "Batch cooking on your days off tends to survive that schedule better than daily prep."],
                ["user", "That's roughly what I've been doing."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-2",
        sourceCaseId: "cand-durable-en-2",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["chemistry", "teacher"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Eleven years in", [
                ["user", "I've been a high school chemistry teacher for eleven years."],
                ["assistant", "That's a long stretch in one subject. What's the question?"],
                ["user", "How to make titration feel less like a recipe to follow."],
            ]),
        ],
    },
    {
        // The operating limit is useful on its own: it survives into any
        // conversation about the bakery's capacity.
        id: "succ-durable-en-3",
        sourceCaseId: "cand-durable-en-3",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["bakery"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "constraint",
                mustInclude: ["oven"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Small business", [
                ["user", "I run a small bakery. Two staff, one oven, no room for a third."],
                ["assistant", "Understood — small operation, tight constraints."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-4",
        sourceCaseId: "cand-durable-en-4",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["lisbon"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Where I am", [
                ["user", "I'm based in Lisbon, if that changes any of your suggestions."],
                ["assistant", "It does for anything time-zone or supplier related. Noted."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-5",
        sourceCaseId: "cand-durable-en-5",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["1974"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Age", [
                ["user", "I was born in 1974, for whatever that's worth here."],
                ["assistant", "Noted."],
            ]),
        ],
    },
    {
        // Re-labelled from `preference`. Examples before theory is an ordering
        // instruction, and ordering has a dedicated kind.
        id: "succ-durable-en-6",
        sourceCaseId: "cand-durable-en-6",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "structure",
                mustInclude: ["examples"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("How I learn", [
                ["user", "I'd much rather see examples first and the theory afterwards. The other order never sticks for me."],
                ["assistant", "Then I'll lead with examples from here on."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-7",
        sourceCaseId: "cand-durable-en-7",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["aisle"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Flights", [
                ["user", "I always take the aisle seat, every flight, no exceptions."],
                ["assistant", "Got it — aisle when I'm suggesting bookings."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-8",
        sourceCaseId: "cand-durable-en-8",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["subscription"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("No recurring costs", [
                ["user", "Please don't suggest anything that needs a subscription. I only buy things outright."],
                ["assistant", "One-off purchases and free tools only, then."],
                ["user", "Right."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-9",
        sourceCaseId: "cand-durable-en-9",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["budget", "2000"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Hard ceiling", [
                ["user", "my budget is 2000 dollars and thats a hard limit, i cant go over it even a little"],
                ["assistant", "I'll keep every option under that."],
            ]),
        ],
    },
    {
        // Drug allergy: extractable, held for review, never auto-approved.
        id: "succ-durable-en-10",
        sourceCaseId: "cand-durable-en-10",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["penicillin"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("Medication", [
                ["user", "I'm allergic to penicillin — worth knowing before you mention any antibiotic."],
                ["assistant", "I'll flag that, though a prescriber makes the call."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-11",
        sourceCaseId: "cand-durable-en-11",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["tax law"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["introduction"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Skip the basics", [
                ["user", "I've practised tax law for fifteen years. You can skip the introductions and go straight to the edge cases."],
                ["assistant", "Straight to the edge cases, then."],
            ]),
        ],
    },
    {
        // "I know what a cell is" qualifies the same fact rather than adding one.
        id: "succ-durable-en-12",
        sourceCaseId: "cand-durable-en-12",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["beginner", "spreadsheet"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Starting out", [
                ["user", "I'm a complete beginner with spreadsheets. I know what a cell is and that's about the extent of it."],
                ["assistant", "We'll start from there, no assumptions."],
                ["user", "Please do 🙏"],
            ]),
        ],
    },
    {
        id: "succ-durable-en-13",
        sourceCaseId: "cand-durable-en-13",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["marathon"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Distance", [
                ["user", "The goal is a marathon. Not this year, but that's what everything is building toward."],
                ["assistant", "A multi-year build changes how the early training should look."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-14",
        sourceCaseId: "cand-durable-en-14",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["retire", "55"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Timeline", [
                ["user", "I want to retire at 55. That number has been fixed for a while now."],
                ["assistant", "Fixed target, then — that shapes the savings rate."],
            ]),
        ],
    },
    {
        // The electrics are what is stuck today, not a durable fact.
        id: "succ-durable-en-15",
        sourceCaseId: "cand-durable-en-15",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["camper"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Weekend build", [
                ["user", "I'm restoring a 1968 camper van. Been at it two winters now and the electrics are still beating me."],
                ["assistant", "Old vehicle electrics usually mean tracing rather than replacing."],
                ["user", "That's the part I keep putting off."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-16",
        sourceCaseId: "cand-durable-en-16",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["cookbook"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Family recipes", [
                ["user", "I'm putting together a cookbook of my grandmother's recipes. Most of them are on index cards in her handwriting."],
                ["assistant", "Transcription order matters more than layout at this stage."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-17",
        sourceCaseId: "cand-durable-en-17",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["kubernetes"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Settled", [
                ["user", "We've decided on kubernetes. That's settled and I don't want to reopen it."],
                ["assistant", "Then I'll answer inside that choice rather than around it."],
            ]),
        ],
    },
    {
        // The daughter appears only as a participant in the decision, so she is
        // carried by it rather than stored separately.
        id: "succ-durable-en-18",
        sourceCaseId: "cand-durable-en-18",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["homeschool"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Schooling", [
                ["user", "After a lot of back and forth we decided to homeschool our daughter starting this autumn."],
                ["assistant", "That changes what kind of resources are useful."],
                ["user", "It does, and the decision itself is final."],
            ]),
        ],
    },
    {
        // Third-party disability, normalised into the user's own constraint.
        // Both tokens on purpose: "the user's partner is deaf" is a profile and
        // satisfies only the first, so it does not score.
        id: "succ-durable-en-19",
        sourceCaseId: "cand-durable-en-19",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["deaf", "audio"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("Household", [
                ["user", "My partner is deaf, so anything you suggest that's audio-only won't work for us."],
                ["assistant", "I'll keep suggestions to things with captions or text."],
            ]),
        ],
    },
    {
        // Same shape. The useful fact is that evenings are not free; the
        // diagnosis is the minimum context that explains it, not the memory.
        id: "succ-durable-en-20",
        sourceCaseId: "cand-durable-en-20",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["father", "evening"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("Care", [
                ["user", "I look after my father. He has dementia and lives with us now, which reshapes most of the week."],
                ["assistant", "That's a large constraint on scheduling anything."],
                ["user", "It is. I mention it so you don't suggest things that assume free evenings."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-21",
        sourceCaseId: "cand-durable-en-21",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["friday"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Standing block", [
                ["user", "Every Friday afternoon I'm offline for prayers, so don't plan anything for that window."],
                ["assistant", "Friday afternoons are out."],
            ]),
        ],
    },
    {
        // The residual case: refusing to hedge is about how uncertainty is
        // expressed, which is not register, depth, structure or format.
        id: "succ-durable-en-22",
        sourceCaseId: "cand-durable-en-22",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "communication_style",
                mustInclude: ["hedge"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Plain answers", [
                ["user", "Don't hedge with me. If you're not sure, say you're not sure and say why."],
                ["assistant", "Understood — I'll state uncertainty rather than soften it."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-23",
        sourceCaseId: "cand-durable-en-23",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "verbosity",
                mustInclude: ["detail"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Longer, please", [
                ["user", "Give me the long version. I actually want the detail, not the summary."],
                ["assistant", "Then I'll expand rather than compress."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-24",
        sourceCaseId: "cand-durable-en-24",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "language",
                mustInclude: ["spanish"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Reply language", [
                ["user", "Write your answers in spanish even when I ask in English. I read it faster than I write it."],
                ["assistant", "Entendido — I'll answer in Spanish."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-25",
        sourceCaseId: "cand-durable-en-25",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "code_style",
                mustInclude: ["type hint"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Python examples", [
                ["user", "Every python example you give me should have type hints. I've been bitten too many times without them."],
                ["assistant", "Type hints on everything, then."],
            ]),
        ],
    },
];
