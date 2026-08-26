/**
 * Successor batch batch-109 — `durable_facts:en`. **CANDIDATE.**
 *
 * Not dataset. Nothing scores these until a person adopts them
 * (`docs/ops/memory-extraction-eval-dataset.md` §6.2).
 *
 * A schema-2 rework of `lib/memoryExtractionEvalAdopted/batch012DurableEn.ts`.
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
    const id = nextId("succ-b109");
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

export const BATCH_109_DURABLE_EN: readonly MemoryEvalCaseV2[] = [
    {
        id: "succ-durable-en-76",
        sourceCaseId: "cand-durable-en3-1",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["glasgow"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Where I'm based", [
                ["user", "I'm in Glasgow and I've no plans to leave."],
                ["assistant", "I'll keep things local to there."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-77",
        sourceCaseId: "cand-durable-en3-2",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["1995"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Age", [
                ["user", "I was born in 1995 if any of this is age dependent."],
                ["assistant", "Noted."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-78",
        sourceCaseId: "cand-durable-en3-3",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["left-handed"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Handedness", [
                ["user", "I'm left-handed, which matters more than people think when you're recommending tools."],
                ["assistant", "I'll flag left-handed versions where they exist."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-79",
        sourceCaseId: "cand-durable-en3-4",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["only child"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Family", [
                ["user", "I'm an only child, so anything about siblings doesn't apply to me."],
                ["assistant", "Understood."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-80",
        sourceCaseId: "cand-durable-en3-5",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["audiobook"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("How I read", [
                ["user", "I get through books as audiobooks. I almost never sit down with a printed one."],
                ["assistant", "I'll check audio availability when I recommend something."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-81",
        sourceCaseId: "cand-durable-en3-6",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["walking"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Meetings", [
                ["user", "I'd rather have a walking meeting than sit in a room for an hour."],
                ["assistant", "I'll suggest those where the format allows."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-82",
        sourceCaseId: "cand-durable-en3-7",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["tea"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("What I drink", [
                ["user", "I don't drink coffee at all. It's tea, all day."],
                ["assistant", "I'll keep that in mind."],
            ]),
        ],
    },
    {
        // A gap in the taxonomy rather than a decision. Units are a property of
        // the answer, so step 3 does not really fit; but they are not a manner of
        // interaction either, so the residual does not fit and no dedicated kind
        // covers them. Left on the adopted label, and raised in the batch notes.
        id: "succ-durable-en-83",
        sourceCaseId: "cand-durable-en3-8",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["metric"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Units", [
                ["user", "Please give me everything in metric. Imperial units mean nothing to me."],
                ["assistant", "I'll use metric throughout."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-84",
        sourceCaseId: "cand-durable-en3-9",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["veterinary"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("My work", [
                ["user", "I'm a veterinary nurse at a small animal practice."],
                ["assistant", "I'll assume that setting."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-85",
        sourceCaseId: "cand-durable-en3-10",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["locksmith"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Trade", [
                ["user", "I've been a locksmith for eighteen years, mostly emergency call-outs."],
                ["assistant", "I'll frame things around call-out work."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-86",
        sourceCaseId: "cand-durable-en3-11",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["air traffic"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "recurring_context",
                mustInclude: ["shift"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Job", [
                ["user", "I work in air traffic control. The shift pattern is brutal and it rules everything else."],
                ["assistant", "I'll plan around a rotating shift pattern."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-87",
        sourceCaseId: "cand-durable-en3-12",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["copy editor"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("What I do", [
                ["user", "I'm a copy editor. I work on academic manuscripts, mostly."],
                ["assistant", "I'll keep that context."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-88",
        sourceCaseId: "cand-durable-en3-13",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["photography"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["aperture"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Comfortable ground", [
                ["user", "I've done photography professionally for years — you don't need to explain aperture to me."],
                ["assistant", "I'll skip the basics there."],
            ]),
        ],
    },
    {
        // The notation offer is the assistant's, not an instruction from the user.
        id: "succ-durable-en-89",
        sourceCaseId: "cand-durable-en3-14",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["knitting"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Long-standing skill", [
                ["user", "I've been knitting since I was six. Cable charts and shaping are second nature."],
                ["assistant", "I'll use the standard notation."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-90",
        sourceCaseId: "cand-durable-en3-15",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["invest"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("New territory", [
                ["user", "I've never invested in anything. I don't know what an index fund is."],
                ["assistant", "I'll start from first principles."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-91",
        sourceCaseId: "cand-durable-en3-16",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["first aid"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["clinical"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Trained in", [
                ["user", "I'm a qualified first aid trainer, so you can use the clinical terms directly."],
                ["assistant", "I'll use them as-is."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-92",
        sourceCaseId: "cand-durable-en3-17",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["smallholding"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("The long game", [
                ["user", "The plan, eventually, is a smallholding. Everything I save is pointed at that."],
                ["assistant", "I'll treat that as the destination."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-93",
        sourceCaseId: "cand-durable-en3-18",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["phd"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Study", [
                ["user", "I want to end up doing a PhD. I'm still a few years off applying."],
                ["assistant", "I'll keep that trajectory in mind."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-94",
        sourceCaseId: "cand-durable-en3-19",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["atlantic"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("One day", [
                ["user", "Crossing the Atlantic under sail is the thing I'm building toward. No date set."],
                ["assistant", "Noted as the long-term goal."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-95",
        sourceCaseId: "cand-durable-en3-20",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["gallery"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Ambition", [
                ["user", "I want to open a small gallery for local artists someday. That's the endpoint."],
                ["assistant", "I'll frame things around that."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-96",
        sourceCaseId: "cand-durable-en3-21",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["board game"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Side project", [
                ["user", "I'm designing a board game. It's been in playtesting for about a year."],
                ["assistant", "I'll treat that as the ongoing project."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-97",
        sourceCaseId: "cand-durable-en3-22",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["memoir"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Writing", [
                ["user", "I'm writing a memoir about my years at sea. Roughly half drafted."],
                ["assistant", "I'll assume that's the manuscript you mean."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-98",
        sourceCaseId: "cand-durable-en3-23",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["treehouse"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Building", [
                ["user", "I'm building a treehouse for my nephews. Weekends only, so it's slow."],
                ["assistant", "I'll size suggestions to weekend work."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-99",
        sourceCaseId: "cand-durable-en3-24",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["newsletter"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Publishing", [
                ["user", "I run a fortnightly newsletter about urban wildlife. About four hundred subscribers."],
                ["assistant", "Got it — that's the running project."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-100",
        sourceCaseId: "cand-durable-en3-25",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["freelance"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Working arrangement", [
                ["user", "I decided to stay freelance rather than take a staff job. That's settled."],
                ["assistant", "I'll stop framing options around employment."],
            ]),
        ],
    },
];
