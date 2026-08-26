/**
 * Successor batch batch-112 — `durable_facts:en`. **CANDIDATE.**
 *
 * Not dataset. Nothing scores these until a person adopts them
 * (`docs/ops/memory-extraction-eval-dataset.md` §6.2).
 *
 * A schema-2 rework of `lib/memoryExtractionEvalAdopted/batch014DurableEn.ts`.
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
    const id = nextId("succ-b112");
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

export const BATCH_112_DURABLE_EN: readonly MemoryEvalCaseV2[] = [
    {
        id: "succ-durable-en-126",
        sourceCaseId: "cand-durable-en4-1",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["gluten"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("What I can eat", [
                ["user", "I'm coeliac, so gluten is completely off the table for me."],
                ["assistant", "I'll keep everything gluten free."],
            ]),
        ],
    },
    {
        // "React badly" describes a reaction, not a dislike.
        id: "succ-durable-en-127",
        sourceCaseId: "cand-durable-en4-2",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["fragrance"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("Sensitivity", [
                ["user", "I react badly to fragrance, so scented products are out."],
                ["assistant", "I'll stick to unscented options."],
            ]),
        ],
    },
    {
        // Never learned, so nothing here is health information.
        id: "succ-durable-en-128",
        sourceCaseId: "cand-durable-en4-3",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["drive"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Getting about", [
                ["user", "I can't drive — never learned — so anything that assumes a car won't work."],
                ["assistant", "I'll plan around public transport."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-129",
        sourceCaseId: "cand-durable-en4-4",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["weekend"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("When I'm free", [
                ["user", "Weekends are completely spoken for. Nothing can go there."],
                ["assistant", "I'll keep suggestions to weekdays."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-130",
        sourceCaseId: "cand-durable-en4-5",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["printer"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Equipment", [
                ["user", "There's no printer here, so please don't suggest anything that needs printing out."],
                ["assistant", "I'll keep it all on screen."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-131",
        sourceCaseId: "cand-durable-en4-6",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["cardiff"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Where I am", [
                ["user", "I'm in Cardiff and have been for most of my adult life."],
                ["assistant", "I'll keep things local to there."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-132",
        sourceCaseId: "cand-durable-en4-7",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["1962"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Age", [
                ["user", "Born in 1962, so retirement questions are live ones for me."],
                ["assistant", "I'll answer with that in mind."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-133",
        sourceCaseId: "cand-durable-en4-8",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["hard of hearing"],
                expectedDisposition: "sensitive_review",
            },
        ],
        conversations: [
            conversation("Hearing", [
                ["user", "I'm hard of hearing in one ear. Phone calls are difficult."],
                ["assistant", "I'll favour written options."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-134",
        sourceCaseId: "cand-durable-en4-9",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "identity",
                mustInclude: ["dual citizenship"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Nationality", [
                ["user", "I have dual citizenship, so paperwork usually means checking two sets of rules."],
                ["assistant", "I'll cover both where it matters."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-135",
        sourceCaseId: "cand-durable-en4-10",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["newspaper"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("News", [
                ["user", "I read a printed newspaper. I don't use news apps at all."],
                ["assistant", "I'll bear that in mind."],
            ]),
        ],
    },
    {
        // Stated as a habit with no hearing reason given. The batch's own
        // hard-of-hearing case is the contrast.
        id: "succ-durable-en-136",
        sourceCaseId: "cand-durable-en4-11",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["subtitle"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Video", [
                ["user", "I watch everything with subtitles on, even in my own language."],
                ["assistant", "I'll check for subtitled versions."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-137",
        sourceCaseId: "cand-durable-en4-12",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["alone"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Meals", [
                ["user", "I actually prefer eating alone. Group meals are something I avoid."],
                ["assistant", "I'll suggest places that suit that."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-138",
        sourceCaseId: "cand-durable-en4-13",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "preference",
                mustInclude: ["cash"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Paying", [
                ["user", "I pay in cash wherever I can. Card-only places annoy me."],
                ["assistant", "I'll note that when it's relevant."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-139",
        sourceCaseId: "cand-durable-en4-14",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["hygienist"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "recurring_context",
                mustInclude: ["saturday"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("My job", [
                ["user", "I'm a dental hygienist. We run Saturday clinics too."],
                ["assistant", "I'll assume that pattern."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-140",
        sourceCaseId: "cand-durable-en4-15",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["orchard"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "recurring_context",
                mustInclude: ["harvest"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Work", [
                ["user", "I run an apple orchard. During harvest I'm unavailable for anything else."],
                ["assistant", "I'll plan around the season."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-141",
        sourceCaseId: "cand-durable-en4-16",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["school cook"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "recurring_context",
                mustInclude: ["six"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Where I work", [
                ["user", "I'm a school cook, so my day ends early but starts at six."],
                ["assistant", "I'll use those hours."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-142",
        sourceCaseId: "cand-durable-en4-17",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "occupation",
                mustInclude: ["decorator"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Trade", [
                ["user", "I'm a decorator. Different site every week, no fixed office."],
                ["assistant", "I'll frame things around site work."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-143",
        sourceCaseId: "cand-durable-en4-18",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["calligraphy"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["script name"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Long practice", [
                ["user", "I've done calligraphy for twenty years — you can use the proper script names."],
                ["assistant", "I'll use them directly."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-144",
        sourceCaseId: "cand-durable-en4-19",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["engine"],
                expectedDisposition: "bulk_safe",
            },
            {
                id: "e2",
                kind: "explanation_depth",
                mustInclude: ["manifold"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Comfortable with", [
                ["user", "Engines are my trade. You don't need to explain what a manifold is."],
                ["assistant", "I'll skip that level of detail."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-145",
        sourceCaseId: "cand-durable-en4-20",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["portuguese"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("New language", [
                ["user", "I'm a complete beginner in Portuguese. I don't know the pronunciation rules yet."],
                ["assistant", "I'll start from the basics."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-146",
        sourceCaseId: "cand-durable-en4-21",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "expertise",
                mustInclude: ["lifeguard"],
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
            conversation("Qualified in", [
                ["user", "I'm a qualified lifeguard, so water safety terminology is fine as-is."],
                ["assistant", "I'll use the standard terms."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-147",
        sourceCaseId: "cand-durable-en4-22",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["poetry"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Someday", [
                ["user", "Publishing a poetry collection is the long-term aim. Still gathering the poems."],
                ["assistant", "I'll treat that as the goal."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-148",
        sourceCaseId: "cand-durable-en4-23",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["abroad"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Where I'm heading", [
                ["user", "The plan is to move abroad eventually. Everything I'm doing points that way."],
                ["assistant", "I'll keep that destination in view."],
            ]),
        ],
    },
    {
        // Looking at courses is not a settled choice, so it is not gold.
        id: "succ-durable-en-149",
        sourceCaseId: "cand-durable-en4-24",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "long_term_goal",
                mustInclude: ["social work"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Career change", [
                ["user", "I want to retrain into social work. I'm looking at evening courses now."],
                ["assistant", "I'll frame options around retraining."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-150",
        sourceCaseId: "cand-durable-en4-25",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["footpath"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Mapping", [
                ["user", "I'm mapping the local footpaths, walking and recording them one by one."],
                ["assistant", "I'll treat that as the running project."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-151",
        sourceCaseId: "cand-durable-en4-26",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["album"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Recording", [
                ["user", "My band is recording an album. Five tracks done so far."],
                ["assistant", "I'll assume that's the project you mean."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-152",
        sourceCaseId: "cand-durable-en4-27",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "project",
                mustInclude: ["barn"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Conversion", [
                ["user", "I'm converting an old barn. It's a weekends-only job and it'll take years."],
                ["assistant", "I'll size things to weekend work."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-153",
        sourceCaseId: "cand-durable-en4-28",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["television"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Household", [
                ["user", "We got rid of the television and we're not getting another one."],
                ["assistant", "I'll leave that out of suggestions."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-154",
        sourceCaseId: "cand-durable-en4-29",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["mortgage"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Money", [
                ["user", "We decided to overpay the mortgage rather than invest. That's settled."],
                ["assistant", "I'll work from that decision."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-155",
        sourceCaseId: "cand-durable-en4-30",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "decision",
                mustInclude: ["side business"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Winding down", [
                ["user", "I wound down the side business deliberately. I'm not restarting it."],
                ["assistant", "I won't raise it again."],
            ]),
        ],
    },
    {
        // Same boundary as the carer cases: a care setting and a visiting rhythm,
        // with no condition or treatment stated.
        id: "succ-durable-en-156",
        sourceCaseId: "cand-durable-en4-31",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["mother"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Family", [
                ["user", "My mother is in a care home and I visit twice a week."],
                ["assistant", "I'll account for those visits."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-157",
        sourceCaseId: "cand-durable-en4-32",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["daughter"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Children", [
                ["user", "My daughter is at university, so the house is quieter than it used to be."],
                ["assistant", "Noted."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-158",
        sourceCaseId: "cand-durable-en4-33",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "relationship",
                mustInclude: ["father-in-law"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Who I live with", [
                ["user", "My father-in-law lives with us, and household decisions go through him too."],
                ["assistant", "I'll treat those as joint decisions."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-159",
        sourceCaseId: "cand-durable-en4-34",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["october"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Yearly", [
                ["user", "Every October is appraisal season and it swallows the whole month."],
                ["assistant", "I'll avoid loading anything into October."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-160",
        sourceCaseId: "cand-durable-en4-35",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["saturday"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Weekly", [
                ["user", "Saturday mornings are football, every week, no exceptions."],
                ["assistant", "I'll keep Saturday mornings clear."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-161",
        sourceCaseId: "cand-durable-en4-36",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "recurring_context",
                mustInclude: ["peak season"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Seasonal", [
                ["user", "Summer is peak season for us, so those three months I barely get a day off."],
                ["assistant", "I'll assume no spare capacity then."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-162",
        sourceCaseId: "cand-durable-en4-37",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "communication_style",
                mustInclude: ["not sure"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Uncertainty", [
                ["user", "If you're not sure, say you don't know. A made-up answer is worse than none."],
                ["assistant", "I'll say so when I'm unsure."],
            ]),
        ],
    },
    {
        // Marginal against `explanation_depth`, kept on the residual for the same
        // reason as its Korean counterpart: keeping the words and glossing them
        // is vocabulary handling rather than depth.
        id: "succ-durable-en-163",
        sourceCaseId: "cand-durable-en4-38",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "communication_style",
                mustInclude: ["jargon"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Terminology", [
                ["user", "Keep the jargon but put a short gloss in brackets. I need to learn the words themselves."],
                ["assistant", "I'll keep the terms and gloss them."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-164",
        sourceCaseId: "cand-durable-en4-39",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "tone",
                mustInclude: ["joke"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Register", [
                ["user", "No jokes, please. Straight answers only."],
                ["assistant", "I'll keep it plain."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-165",
        sourceCaseId: "cand-durable-en4-40",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "verbosity",
                mustInclude: ["one paragraph"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Length", [
                ["user", "One paragraph per answer. I'll ask if I want more."],
                ["assistant", "I'll hold to that."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-166",
        sourceCaseId: "cand-durable-en4-41",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "structure",
                mustInclude: ["numbered"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Layout", [
                ["user", "Anything procedural should come as numbered steps, not prose."],
                ["assistant", "I'll number the steps."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-167",
        sourceCaseId: "cand-durable-en4-42",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "formatting",
                mustInclude: ["emoji"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Presentation", [
                ["user", "Please don't use emoji. I paste a lot of this into work documents."],
                ["assistant", "I'll leave them out."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-168",
        sourceCaseId: "cand-durable-en4-43",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "language",
                mustInclude: ["italian"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Reply language", [
                ["user", "Answer in Italian from now on — I'm trying to build the habit."],
                ["assistant", "Risponderò in italiano d'ora in poi."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-169",
        sourceCaseId: "cand-durable-en4-44",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "explanation_depth",
                mustInclude: ["twelve"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Level", [
                ["user", "Explain things as you would to a twelve year old. I have no background in this."],
                ["assistant", "I'll keep it simple."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-170",
        sourceCaseId: "cand-durable-en4-45",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "citation_preference",
                mustInclude: ["year"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Sources", [
                ["user", "When you cite something, give me the publication year. Old material is a problem here."],
                ["assistant", "I'll include the year."],
            ]),
        ],
    },
    {
        id: "succ-durable-en-171",
        sourceCaseId: "cand-durable-en4-46",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        expected: [
            {
                id: "e1",
                kind: "code_style",
                mustInclude: ["single file"],
                expectedDisposition: "bulk_safe",
            },
        ],
        conversations: [
            conversation("Code examples", [
                ["user", "Give code examples as a single file rather than split across modules. Easier to paste."],
                ["assistant", "I'll keep each example in one file."],
            ]),
        ],
    },
];
