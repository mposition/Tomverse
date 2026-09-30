/**
 * Successor batch batch-110 — `durable_facts:en`. **Adopted. This is the successor dataset.**
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
    const id = nextId("succ-b110");
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

export const BATCH_110_DURABLE_EN: readonly MemoryEvalCaseV2[] = [
    {
        // A household dietary choice, stated as a decision rather than a medical
        // requirement, so it is not health information.
        id: "succ-durable-en-101",
        sourceCaseId: "cand-durable-en3-26",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["vegetarian"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Diet", [
                ["user", "We went vegetarian as a household two years ago and it's not up for revisiting."],
                ["assistant", "I'll keep all suggestions vegetarian."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-102",
        sourceCaseId: "cand-durable-en3-27",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["payroll"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Business call", [
                ["user", "We decided to outsource payroll rather than keep it in house. Done deal."],
                ["assistant", "I'll take that as fixed."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-103",
        sourceCaseId: "cand-durable-en3-28",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["insurance"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Cover", [
                ["user", "We dropped the extended insurance after doing the maths. That decision stands."],
                ["assistant", "I won't raise it again."],
            ]),
        ],
    },
    {
        // Re-labelled from `relationship` and normalised. The diagnosis is not
        // the memory; the need for predictable routines is. "The user's son is
        // autistic" satisfies only the first token.
        id: "succ-durable-en-104",
        sourceCaseId: "cand-durable-en3-29",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["son", "routine"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("At home", [
                ["user", "My son is autistic, and routine changes are genuinely hard for him."],
                ["assistant", "I'll factor predictability into anything I suggest."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-105",
        sourceCaseId: "cand-durable-en3-30",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["sister", "australia"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Family abroad", [
                ["user", "My sister lives in Australia, so half my calls happen at odd hours."],
                ["assistant", "I'll account for the time difference."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-106",
        sourceCaseId: "cand-durable-en3-31",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["neighbour"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Shared arrangement", [
                ["user", "I share a car with my neighbour, so I don't have one available on demand."],
                ["assistant", "I won't assume a car is to hand."],
            ]),
        ],
    },
    {
        // A boundary case, kept bulk-safe deliberately. Being someone's carer is
        // a caregiving role; no diagnosis, treatment or condition is stated. The
        // contrast is with the father-with-dementia case in batch 102, where one
        // is. Marking every caring relationship sensitive would cost bulk
        // eligibility recall for no privacy gain.
        id: "succ-durable-en-107",
        sourceCaseId: "cand-durable-en3-32",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["grandmother"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Who I care for", [
                ["user", "My grandmother lives with us and I'm her main carer."],
                ["assistant", "I'll keep caring responsibilities in view."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-108",
        sourceCaseId: "cand-durable-en3-33",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["peanut"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("Allergy", [
                ["user", "Peanuts are a hard no — anaphylaxis. Never put them in anything you suggest."],
                ["assistant", "I'll exclude them completely."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-109",
        sourceCaseId: "cand-durable-en3-34",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["migraine"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("Health", [
                ["user", "I get migraines from screens after about two hours, so long sessions aren't an option."],
                ["assistant", "I'll break things into shorter blocks."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-110",
        sourceCaseId: "cand-durable-en3-35",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["oven"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Kitchen", [
                ["user", "There's no oven in this flat. Hob and microwave only."],
                ["assistant", "I'll stick to hob and microwave recipes."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-111",
        sourceCaseId: "cand-durable-en3-36",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["capped"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Data", [
                ["user", "My connection is capped monthly, so nothing that downloads gigabytes."],
                ["assistant", "I'll keep the data footprint small."],
            ]),
        ],
    },
    {
        // Derived from the user's own surgery. Their own health, so it is stored
        // as stated; minimisation is the third-party rule.
        id: "succ-durable-en-112",
        sourceCaseId: "cand-durable-en3-37",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["heavy lifting"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("Physical limit", [
                ["user", "I can't do heavy lifting since my back surgery. Please don't suggest anything that needs it."],
                ["assistant", "I'll rule those options out."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-113",
        sourceCaseId: "cand-durable-en3-38",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["wednesday"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Weekly fixture", [
                ["user", "Wednesday evenings are choir practice, every week without fail."],
                ["assistant", "I'll leave Wednesday evenings alone."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-114",
        sourceCaseId: "cand-durable-en3-39",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["month end"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Cycle", [
                ["user", "Month end is always a scramble for us — invoicing, reporting, all of it at once."],
                ["assistant", "I'll avoid loading anything into those days."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-115",
        sourceCaseId: "cand-durable-en3-40",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["term time"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Yearly rhythm", [
                ["user", "During term time my evenings disappear. Holidays are the opposite."],
                ["assistant", "I'll plan differently for term and holidays."],
            ]),
        ],
    },
    {
        // Residual. Not tone: the instruction is about what to do after a
        // mistake, not about register.
        id: "succ-durable-en-116",
        sourceCaseId: "cand-durable-en3-41",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "communication_style",
                mustInclude: ["apolog"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("How to write to me", [
                ["user", "You don't need to apologise when you get something wrong. Just correct it and carry on."],
                ["assistant", "I'll correct without the preamble."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-117",
        sourceCaseId: "cand-durable-en3-42",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "communication_style",
                mustInclude: ["push back"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Disagreement", [
                ["user", "If you think I'm wrong, push back. I'd rather hear it than be agreed with."],
                ["assistant", "I'll say so when I disagree."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-118",
        sourceCaseId: "cand-durable-en3-43",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "tone",
                mustInclude: ["casual"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Register", [
                ["user", "Keep it casual. The stiff professional voice makes things harder to read for me."],
                ["assistant", "I'll write plainly."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-119",
        sourceCaseId: "cand-durable-en3-44",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "verbosity",
                mustInclude: ["three sentence"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Length", [
                ["user", "Cap answers at three sentences unless I ask for more."],
                ["assistant", "I'll stay within that."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-120",
        sourceCaseId: "cand-durable-en3-45",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "structure",
                mustInclude: ["heading"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Layout", [
                ["user", "Use headings on anything long. A wall of text is unusable to me."],
                ["assistant", "I'll break long answers into sections."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-121",
        sourceCaseId: "cand-durable-en3-46",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "formatting",
                mustInclude: ["bold"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Emphasis", [
                ["user", "Put the key sentence in bold so I can find it when I skim back."],
                ["assistant", "I'll highlight the main point."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-122",
        sourceCaseId: "cand-durable-en3-47",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "language",
                mustInclude: ["french"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Reply language", [
                ["user", "Reply in French from now on. I need the practice."],
                ["assistant", "Je répondrai en français à partir de maintenant."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-123",
        sourceCaseId: "cand-durable-en3-48",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "explanation_depth",
                mustInclude: ["practical"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("How deep to go", [
                ["user", "Skip the theory and keep it practical. I just need to get the thing working."],
                ["assistant", "I'll stay at that level."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-124",
        sourceCaseId: "cand-durable-en3-49",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "citation_preference",
                mustInclude: ["official"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Sources", [
                ["user", "Cite the official docs rather than a blog post. Blogs go stale and I can't check them."],
                ["assistant", "I'll point at the documentation."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-125",
        sourceCaseId: "cand-durable-en3-50",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "code_style",
                mustInclude: ["variable name"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Code examples", [
                ["user", "Write out full variable names in examples. Single letters are unreadable to me."],
                ["assistant", "I'll use descriptive names."],
            ]),
        ],
    },
];
