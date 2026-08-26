/**
 * Successor batch batch-105 — `durable_facts:en`. **CANDIDATE.**
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
    const id = nextId("succ-b105");
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

export const BATCH_105_DURABLE_EN: readonly MemoryEvalCaseV2[] = [
    {
        id: "succ-durable-en-26",
        sourceCaseId: "cand-durable-en2-1",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["halifax"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Where I live", [
                ["user", "I've lived in Halifax my whole life and I'm not moving."],
                ["assistant", "I'll keep suggestions local to there."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-27",
        sourceCaseId: "cand-durable-en2-2",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["1988"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Age", [
                ["user", "Born in 1988, if that matters for any of the age-banded stuff."],
                ["assistant", "Noted — I'll use that band."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-28",
        sourceCaseId: "cand-durable-en2-3",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["twin"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Sibling", [
                ["user", "I have an identical twin, which comes up more often than you'd think."],
                ["assistant", "Good to know."],
            ]),
        ],
    },
    {
        // Colour vision is health information, so it is held for review.
        // The token is "red-green" rather than the condition's name: the model is
        // asked to answer in the evidence's language, and "colour"/"color" would
        // have made a spelling difference decide a score.
        id: "succ-durable-en-29",
        sourceCaseId: "cand-durable-en2-4",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["red-green"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("Colour vision", [
                ["user", "I'm red-green colour blind, so don't tell me to look for the red line on a chart."],
                ["assistant", "I'll describe chart series by label and position instead."],
            ]),
        ],
    },
    {
        // Kept as `preference`, the label a reviewer already adopted. Whether a
        // working rhythm is a preference or a recurring context is an axis the
        // 2026-08-25 amendment did not touch, and relabelling on my own reading
        // would be changing a judgement rather than applying one.
        id: "succ-durable-en-30",
        sourceCaseId: "cand-durable-en2-5",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["night"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("When I work", [
                ["user", "I do all my real work at night. Mornings are a write-off for me."],
                ["assistant", "I'll plan schedules around a late start."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-31",
        sourceCaseId: "cand-durable-en2-6",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["train"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Travel", [
                ["user", "For anything under six hours I'd rather take the train than fly."],
                ["assistant", "I'll price rail first on those routes."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-32",
        sourceCaseId: "cand-durable-en2-7",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["secondhand"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Buying things", [
                ["user", "I buy almost everything secondhand. It's a habit at this point, not a budget thing."],
                ["assistant", "I'll look at used listings first."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-33",
        sourceCaseId: "cand-durable-en2-8",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["paper"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Reading", [
                ["user", "I read on paper. E-books just don't stick for me 📚"],
                ["assistant", "I'll point you at print editions where they exist."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-34",
        sourceCaseId: "cand-durable-en2-9",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["midwife"],
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
            conversation("My job", [
                ["user", "I'm a midwife. Twelve-hour shifts, mostly nights."],
                ["assistant", "I'll assume that schedule."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-35",
        sourceCaseId: "cand-durable-en2-10",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["archivist"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Day to day", [
                ["user", "I work as an archivist at a county records office."],
                ["assistant", "I'll keep that context in mind."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-36",
        sourceCaseId: "cand-durable-en2-11",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["electrician"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Trade", [
                ["user", "I'm a self-employed electrician, so my invoicing questions are about my own books."],
                ["assistant", "Understood — sole trader, then."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-37",
        sourceCaseId: "cand-durable-en2-12",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["translator"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Freelance", [
                ["user", "I'm a freelance translator working on legal documents, about six clients."],
                ["assistant", "I'll frame things around freelance work."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-38",
        sourceCaseId: "cand-durable-en2-13",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["statistics"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["p-value"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Skip ahead", [
                ["user", "I have a graduate background in statistics, so please don't explain what a p-value is."],
                ["assistant", "I'll skip the fundamentals."],
            ]),
        ],
    },
    {
        // The user states the expertise; the offer to skip definitions is the
        // assistant's, so there is no second instruction to store.
        id: "succ-durable-en-39",
        sourceCaseId: "cand-durable-en2-14",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["sailing"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Comfortable there", [
                ["user", "I've been sailing since I was a kid. Points of sail, rigging, all of that is second nature."],
                ["assistant", "I'll use the terms without defining them."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-40",
        sourceCaseId: "cand-durable-en2-15",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["gardening"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Starting out", [
                ["user", "I'm completely new to gardening. I don't know what hardening off means."],
                ["assistant", "I'll define terms as they come up."],
            ]),
        ],
    },
    {
        // "WCAG references are fine as-is" follows from the expertise rather than
        // standing on its own.
        id: "succ-durable-en-41",
        sourceCaseId: "cand-durable-en2-16",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["accessibility"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("My field", [
                ["user", "Accessibility auditing is what I do professionally, so WCAG references are fine as-is."],
                ["assistant", "I'll cite the criteria directly."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-42",
        sourceCaseId: "cand-durable-en2-17",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["sabbatical"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Someday", [
                ["user", "The long-term plan is a year-long sabbatical to write. No date yet, but it's the direction."],
                ["assistant", "I'll treat that as the goal."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-43",
        sourceCaseId: "cand-durable-en2-18",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["citizenship"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Paperwork ahead", [
                ["user", "I'm working toward citizenship here. It's a multi-year thing and it shapes a lot of my decisions."],
                ["assistant", "I'll factor that in."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-44",
        sourceCaseId: "cand-durable-en2-19",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["debt"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Financial aim", [
                ["user", "Everything I'm doing financially is aimed at being debt free. That's the goal, not returns."],
                ["assistant", "I'll optimise for payoff rather than yield."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-45",
        sourceCaseId: "cand-durable-en2-20",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["teach"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Second career", [
                ["user", "Eventually I want to teach at a community college. That's the endpoint I'm building toward."],
                ["assistant", "I'll keep that destination in view."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-46",
        sourceCaseId: "cand-durable-en2-21",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["greenhouse"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("In the garden", [
                ["user", "I'm building a greenhouse in the back garden. It'll take me most of the summer."],
                ["assistant", "I'll assume that's the project when you mention the build."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-47",
        sourceCaseId: "cand-durable-en2-22",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["podcast"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Side thing", [
                ["user", "I run a small podcast about local history. Two episodes a month."],
                ["assistant", "Got it — that's the ongoing project."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-48",
        sourceCaseId: "cand-durable-en2-23",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["thesis"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Academic", [
                ["user", "My thesis is on coastal erosion. I'm in the writing-up stage."],
                ["assistant", "I'll assume writing-up unless you say otherwise."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-49",
        sourceCaseId: "cand-durable-en2-24",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["motorbike"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Restoration", [
                ["user", "I'm restoring a 1970s motorbike in the garage. It's a long slow one."],
                ["assistant", "Noted as the standing project."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-50",
        sourceCaseId: "cand-durable-en2-25",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["postgres"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Settled question", [
                ["user", "We settled on Postgres for the new service. That part is not up for discussion again."],
                ["assistant", "I'll take that as fixed."],
            ]),
        ],
    },
];
