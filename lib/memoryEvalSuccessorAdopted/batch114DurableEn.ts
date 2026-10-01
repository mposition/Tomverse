/**
 * Successor batch batch-114 — `durable_facts:en`. **Adopted. This is the successor dataset.**
 *
 * Not dataset. Nothing scores these until a person adopts them
 * (`docs/ops/memory-extraction-eval-dataset.md` §6.2).
 *
 * A schema-2 rework of `lib/memoryExtractionEvalAdopted/batch016DurableEn.ts` plus the
 * four seed cases declared directly in `lib/memoryExtractionEvalFixtures.ts`,
 * which predate the batch files.
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
    const id = nextId("succ-b114");
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

export const BATCH_114_DURABLE_EN: readonly MemoryEvalCaseV2[] = [
    {
        id: "succ-durable-en-172",
        sourceCaseId: "cand-durable-en5-1",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["dizzy"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("Standing", [
                ["user", "I get dizzy if I stand for long, so anything that needs me on my feet is out."],
                ["assistant", "I'll suggest seated options."],
            ]),
        ],
    },
    {
        // No condition is named, but "I can't manage stairs" is a statement about
        // the user's own body, which is what the sensitive lane is for.
        id: "succ-durable-en-173",
        sourceCaseId: "cand-durable-en5-2",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["stairs"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("Access", [
                ["user", "I can't manage stairs. Ground floor or a lift, always."],
                ["assistant", "I'll check step-free access."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-174",
        sourceCaseId: "cand-durable-en5-3",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["laptop"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Hardware", [
                ["user", "My laptop is ten years old. Anything heavy simply won't run on it."],
                ["assistant", "I'll stick to lightweight tools."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-175",
        sourceCaseId: "cand-durable-en5-4",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["belfast"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Where I live", [
                ["user", "I'm in Belfast, and have been for twenty years."],
                ["assistant", "I'll keep it local to there."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-176",
        sourceCaseId: "cand-durable-en5-5",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["2001"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Age", [
                ["user", "I was born in 2001 — I've only just started working."],
                ["assistant", "I'll answer at that stage."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-177",
        sourceCaseId: "cand-durable-en5-6",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["handwritten"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Notes", [
                ["user", "My notes are handwritten. Typing them out doesn't stick for me."],
                ["assistant", "I'll shape things so they're easy to copy by hand."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-178",
        sourceCaseId: "cand-durable-en5-7",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["market"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Shopping", [
                ["user", "I shop at markets rather than supermarkets whenever I can."],
                ["assistant", "I'll bear that in mind for ingredients."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-179",
        sourceCaseId: "cand-durable-en5-8",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["cabin crew"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "recurring_context",
                mustInclude: ["ten days"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("My job", [
                ["user", "I'm cabin crew, so I'm away about ten days a month."],
                ["assistant", "I'll plan around that."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-180",
        sourceCaseId: "cand-durable-en5-9",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["fisherman"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "recurring_context",
                mustInclude: ["weather"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Work", [
                ["user", "I'm a fisherman. The weather rewrites my week most weeks."],
                ["assistant", "I won't assume a fixed schedule."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-181",
        sourceCaseId: "cand-durable-en5-10",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["chess"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["opening"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Long practice", [
                ["user", "I've played chess seriously for years — no need to explain openings to me."],
                ["assistant", "I'll use the names directly."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-182",
        sourceCaseId: "cand-durable-en5-11",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["masonry"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["terminology"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Trade knowledge", [
                ["user", "Stone masonry is my trade, so the terminology is fine as-is."],
                ["assistant", "I'll keep the terms."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-183",
        sourceCaseId: "cand-durable-en5-12",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["hostel"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Someday", [
                ["user", "Opening a walkers' hostel is the long-term plan. I'm still looking for the building."],
                ["assistant", "I'll treat that as the goal."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-184",
        sourceCaseId: "cand-durable-en5-13",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["woodwork"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Second act", [
                ["user", "I want to turn woodwork into an actual business eventually."],
                ["assistant", "I'll frame things around that."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-185",
        sourceCaseId: "cand-durable-en5-14",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["comic"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Ongoing", [
                ["user", "I draw a comic, one page a fortnight. It's just me doing all of it."],
                ["assistant", "I'll treat that as the running project."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-186",
        sourceCaseId: "cand-durable-en5-15",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["conference"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Coming up", [
                ["user", "I'm preparing a conference talk for the autumn. Abstract is in, slides aren't."],
                ["assistant", "I'll work to that deadline."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-187",
        sourceCaseId: "cand-durable-en5-16",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["gym"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Cancelled", [
                ["user", "I cancelled the gym membership and I'm training at home instead. That's decided."],
                ["assistant", "I'll suggest home options only."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-188",
        sourceCaseId: "cand-durable-en5-17",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["city"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Where we're staying", [
                ["user", "We decided against moving to the city. That question is closed."],
                ["assistant", "I'll assume you're staying put."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-189",
        sourceCaseId: "cand-durable-en5-18",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["grandson"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Family", [
                ["user", "I look after my grandson three days a week."],
                ["assistant", "I'll account for those days."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-190",
        sourceCaseId: "cand-durable-en5-19",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["brother-in-law"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Business", [
                ["user", "I run the shop with my brother-in-law, so money decisions are always joint."],
                ["assistant", "I'll treat them as joint calls."],
            ]),
        ],
    },
    {
        // An annual round of medical appointments, on the same reading as its
        // Korean counterpart in batch 115.
        id: "succ-durable-en-191",
        sourceCaseId: "cand-durable-en5-20",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["march"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("Yearly", [
                ["user", "Every March I have my annual check-ups. That week is full of appointments."],
                ["assistant", "I'll keep March clear."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-192",
        sourceCaseId: "cand-durable-en5-21",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["thursday"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Weekly", [
                ["user", "Thursdays are a late finish for me, every week."],
                ["assistant", "I'll leave Thursday evenings out."],
            ]),
        ],
    },
    {
        // Re-labelled from `communication_style`: example before explanation is
        // ordering, which has a dedicated kind.
        id: "succ-durable-en-193",
        sourceCaseId: "cand-durable-en5-22",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "structure",
                mustInclude: ["example"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Order of explanation", [
                ["user", "Show me an example before the explanation. I don't follow abstract descriptions."],
                ["assistant", "I'll lead with an example."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-194",
        sourceCaseId: "cand-durable-en5-23",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "verbosity",
                mustInclude: ["five lines"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Length", [
                ["user", "About five lines is right for me. Longer than that and I stop reading."],
                ["assistant", "I'll aim for that."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-195",
        sourceCaseId: "cand-durable-en5-24",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "formatting",
                mustInclude: ["code block"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Commands", [
                ["user", "Put commands in a code block. Copying them out of prose goes wrong."],
                ["assistant", "I'll fence them."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-196",
        sourceCaseId: "cand-durable-en5-25",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "citation_preference",
                mustInclude: ["link"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Where sources go", [
                ["user", "Keep links out of the body and gather them at the end. They break my reading."],
                ["assistant", "I'll list them at the bottom."],
            ]),
        ],
    },
    {
        // The probe returned three candidates here against a gold of one:
        // occupation, expertise and a `decision` about moving into platform
        // work. The expertise rests on the same clause as the job, and
        // "whether to move" is weighing rather than a settled choice, so the
        // gold stays at one and the exclusion is the prompt's job.
        id: "succ-durable-en-197",
        sourceCaseId: "durable-en-1",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["backend"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Career question", [
                ["user", "I work as a backend engineer and I've been doing it for six years."],
                ["assistant", "Six years of backend work is a solid base. What are you weighing up?"],
                ["user", "Whether to move into platform work."],
            ]),
        ],
    },
    {
        // Re-labelled from `preference`. Answer length has a dedicated kind,
        // and this is the other case the probe flagged.
        id: "succ-durable-en-198",
        sourceCaseId: "durable-en-2",
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
            conversation("Answer length", [
                ["user", "Please keep answers short. Long explanations lose me."],
                ["assistant", "Understood — I'll keep replies brief."],
            ]),
        ],
    },
    {
        // Lactose intolerance. The probe scored this as a miss because the
        // model routed it away from bulk-safe; under the amended contract
        // that routing is the correct answer.
        id: "succ-durable-en-199",
        sourceCaseId: "durable-en-3",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["lactose"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("Recipe help", [
                ["user", "I'm lactose intolerant, so no dairy in anything you suggest."],
                ["assistant", "Noted. Here is a dairy-free option."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-200",
        sourceCaseId: "durable-en-4",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["inventory", "rust"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Side project", [
                ["user", "My side project is an inventory tracker I'm writing in Rust."],
                ["assistant", "Rust is a good fit for that. Where are you stuck?"],
                ["user", "Ownership around the storage layer."],
            ]),
        ],
    },
];
